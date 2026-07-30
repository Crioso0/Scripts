import * as hz from 'horizon/core';

import {
  activateZombieEvent,
  roundStateEvent,
  zombieDefeatedEvent,
} from 'GameEvents';

/**
 * RoundManager
 * ------------
 * Spawns a pool of zombies once, then activates them wave by wave.
 *
 * A round completes when every zombie for it has been spawned and defeated.
 * Because that depends entirely on zombieDefeatedEvent arriving, a lost event
 * used to stall the game permanently with nothing printed. Every failure path
 * now reschedules, and a watchdog force-completes a round that has stopped
 * making progress - loudly, so a real bug is still visible.
 */
class RoundManager extends hz.Component<typeof RoundManager> {
  static propsDefinition = {
    zombieAsset: { type: hz.PropTypes.Asset },
    playerHealthManager: { type: hz.PropTypes.Entity },
    holdingPoint: { type: hz.PropTypes.Entity },

    spawnPoints: { type: hz.PropTypes.EntityArray },
    /** Per spawn point, the round it unlocks on. Missing entries mean 1. */
    spawnUnlockRounds: { type: hz.PropTypes.NumberArray },

    startingRound: { type: hz.PropTypes.Number, default: 1 },
    baseZombies: { type: hz.PropTypes.Number, default: 3 },
    zombiesAddedPerRound: { type: hz.PropTypes.Number, default: 2 },

    /**
     * Pool size, and therefore the cap on how many can be alive at once. A
     * round needing more than this trickles them in as others die.
     */
    maxAliveAtOnce: { type: hz.PropTypes.Number, default: 8 },

    spawnInterval: { type: hz.PropTypes.Number, default: 1 },
    firstRoundDelay: { type: hz.PropTypes.Number, default: 3 },
    betweenRoundDelay: { type: hz.PropTypes.Number, default: 5 },

    /** Seconds without a spawn or a defeat before the round is force-cleared. */
    stallTimeoutSeconds: { type: hz.PropTypes.Number, default: 45 },

    debug: { type: hz.PropTypes.Boolean, default: true },
  };

  private zombiePool: hz.Entity[] = [];
  private activeZombies = new Set<hz.Entity>();

  private currentRound = 0;
  private remainingToSpawn = 0;
  private roundInProgress = false;

  private completedPoolRequests = 0;
  private poolRequested = 0;

  private spawnTimerPending = false;
  private roundTimerPending = false;

  private lastProgressAt = 0;

  preStart() {
    this.connectLocalBroadcastEvent(zombieDefeatedEvent, (data) => {
      this.onZombieDefeated(data.zombie, data.killer);
    });
  }

  start() {
    this.broadcastState(0, 'PREPARING');

    if (!this.props.zombieAsset) {
      console.error('RoundManager: zombieAsset is not assigned.');
      return;
    }

    if (!this.props.playerHealthManager) {
      console.error('RoundManager: playerHealthManager is not assigned.');
      return;
    }

    if (!this.props.spawnPoints || this.props.spawnPoints.length === 0) {
      console.error('RoundManager: no spawn points assigned.');
      return;
    }

    this.currentRound = this.firstRound() - 1;
    this.markProgress();

    this.async.setInterval(() => {
      this.watchdogTick();
    }, 1000);

    this.createZombiePool();
  }

  private firstRound(): number {
    return Math.max(1, Math.floor(this.props.startingRound));
  }

  // ------------------------------------------------------------------ pool

  private createZombiePool() {
    const asset = this.props.zombieAsset;
    if (!asset) {
      return;
    }

    const requested = Math.max(1, Math.floor(this.props.maxAliveAtOnce));
    this.poolRequested = requested;

    const holdingPosition =
      this.props.holdingPoint?.position.get() ?? this.entity.position.get();

    const holdingRotation =
      this.props.holdingPoint?.rotation.get() ?? this.entity.rotation.get();

    this.log(`creating a pool of ${requested} zombies`);

    for (let index = 0; index < requested; index++) {
      this.world
        .spawnAsset(asset, holdingPosition, holdingRotation)
        .then((entities) => {
          if (entities && entities.length > 0) {
            this.zombiePool.push(entities[0]);
            this.log(`pooled zombie ${this.zombiePool.length}/${requested}`);
          } else {
            console.warn('RoundManager: zombie asset spawned no root entity.');
          }

          this.finishPoolRequest();
        })
        .catch((error) => {
          console.error(
            `RoundManager: failed to spawn zombie asset: ${error}`,
          );
          this.finishPoolRequest();
        });
    }
  }

  private finishPoolRequest() {
    this.completedPoolRequests++;

    if (this.completedPoolRequests < this.poolRequested) {
      return;
    }

    if (this.zombiePool.length === 0) {
      console.error(
        'RoundManager: zombie pool is empty - no rounds can run. Check that ' +
          'zombieAsset points at a valid asset template.',
      );
      return;
    }

    this.log(`pool ready with ${this.zombiePool.length} zombies`);

    this.broadcastState(0, 'GET READY');
    this.scheduleNextRound(this.props.firstRoundDelay);
  }

  // ----------------------------------------------------------------- rounds

  private scheduleNextRound(delaySeconds: number) {
    if (this.roundTimerPending) {
      return;
    }

    this.roundTimerPending = true;

    this.async.setTimeout(() => {
      this.roundTimerPending = false;
      this.beginNextRound();
    }, Math.max(0, delaySeconds) * 1000);
  }

  private beginNextRound() {
    this.currentRound++;
    this.roundInProgress = true;

    // Anything still tracked from the previous round is stale by definition.
    this.activeZombies.clear();

    const roundIndex = Math.max(0, this.currentRound - this.firstRound());

    this.remainingToSpawn = Math.max(
      1,
      Math.floor(
        this.props.baseZombies +
          roundIndex * this.props.zombiesAddedPerRound,
      ),
    );

    this.log(`ROUND ${this.currentRound}: ${this.remainingToSpawn} zombies`);

    this.markProgress();
    this.broadcastState(this.remainingEnemies(), 'ROUND ACTIVE');
    this.scheduleSpawn(0.25);
  }

  private completeRound(forced: boolean) {
    if (!this.roundInProgress) {
      return;
    }

    this.roundInProgress = false;
    this.remainingToSpawn = 0;
    this.activeZombies.clear();

    if (forced) {
      console.warn(
        `RoundManager: ROUND ${this.currentRound} force-cleared after ` +
          `${this.props.stallTimeoutSeconds}s without progress. A zombie ` +
          'was probably killed without reporting, or is stuck unreachable.',
      );
    } else {
      this.log(`ROUND ${this.currentRound} CLEAR`);
    }

    this.markProgress();
    this.broadcastState(0, 'ROUND CLEAR');
    this.scheduleNextRound(this.props.betweenRoundDelay);
  }

  // ---------------------------------------------------------------- spawning

  private scheduleSpawn(delaySeconds: number) {
    if (this.spawnTimerPending || this.remainingToSpawn <= 0) {
      return;
    }

    this.spawnTimerPending = true;

    this.async.setTimeout(() => {
      this.spawnTimerPending = false;
      this.spawnOneZombie();
    }, Math.max(0, delaySeconds) * 1000);
  }

  private spawnOneZombie() {
    if (this.remainingToSpawn <= 0) {
      return;
    }

    const zombie = this.findAvailableZombie();

    if (!zombie) {
      // Every pooled zombie is out. Try again shortly rather than relying on
      // a defeat event to restart the queue.
      this.scheduleSpawn(this.props.spawnInterval);
      return;
    }

    const spawnPoint = this.chooseSpawnPoint();

    if (!spawnPoint) {
      console.error(
        `RoundManager: no spawn point unlocked at round ${this.currentRound}. ` +
          'Check spawnUnlockRounds - at least one entry should be 1.',
      );
      this.scheduleSpawn(this.props.spawnInterval);
      return;
    }

    const manager = this.props.playerHealthManager;
    if (!manager) {
      return;
    }

    this.activeZombies.add(zombie);
    this.remainingToSpawn--;

    this.sendLocalEvent(zombie, activateZombieEvent, {
      position: spawnPoint.position.get(),
      rotation: spawnPoint.rotation.get(),
      playerHealthManager: manager,
    });

    this.log(
      `spawned zombie at "${spawnPoint.name.get()}" ` +
        `(${this.activeZombies.size} alive, ${this.remainingToSpawn} queued)`,
    );

    this.markProgress();
    this.broadcastState(this.remainingEnemies(), 'ROUND ACTIVE');

    if (this.remainingToSpawn > 0) {
      this.scheduleSpawn(this.props.spawnInterval);
    }
  }

  private onZombieDefeated(zombie: hz.Entity, killer: hz.Player) {
    if (!this.activeZombies.has(zombie)) {
      // Either already counted, or from a previous round. Either way it is
      // not an error - just nothing to do.
      return;
    }

    this.activeZombies.delete(zombie);
    this.markProgress();

    this.log(`"${killer.name.get()}" defeated a zombie`);

    if (this.remainingEnemies() <= 0) {
      this.completeRound(false);
      return;
    }

    this.broadcastState(this.remainingEnemies(), 'ROUND ACTIVE');
    this.scheduleSpawn(this.props.spawnInterval);
  }

  // --------------------------------------------------------------- watchdog

  private markProgress() {
    this.lastProgressAt = Date.now();
  }

  /**
   * A round that has spawned everything and is waiting on kills can wait
   * forever if a defeat event went missing or a zombie is stuck somewhere
   * unreachable. Force it closed rather than leaving the game dead.
   */
  private watchdogTick() {
    if (!this.roundInProgress) {
      return;
    }

    const idleSeconds = (Date.now() - this.lastProgressAt) / 1000;

    if (idleSeconds < this.props.stallTimeoutSeconds) {
      return;
    }

    this.completeRound(true);
  }

  // ---------------------------------------------------------------- helpers

  private findAvailableZombie(): hz.Entity | null {
    for (const zombie of this.zombiePool) {
      if (!this.activeZombies.has(zombie)) {
        return zombie;
      }
    }

    return null;
  }

  private chooseSpawnPoint(): hz.Entity | null {
    const unlocked: hz.Entity[] = [];
    const spawnPoints = this.props.spawnPoints;
    const unlockRounds = this.props.spawnUnlockRounds;

    for (let index = 0; index < spawnPoints.length; index++) {
      const spawnPoint = spawnPoints[index];
      if (!spawnPoint) {
        continue;
      }

      const configured = unlockRounds ? unlockRounds[index] : null;

      const unlockRound =
        configured == null ? 1 : Math.max(1, Math.floor(configured));

      if (this.currentRound >= unlockRound) {
        unlocked.push(spawnPoint);
      }
    }

    if (unlocked.length === 0) {
      return null;
    }

    return unlocked[Math.floor(Math.random() * unlocked.length)];
  }

  private remainingEnemies(): number {
    return this.remainingToSpawn + this.activeZombies.size;
  }

  private broadcastState(enemiesRemaining: number, message: string) {
    this.sendLocalBroadcastEvent(roundStateEvent, {
      round: this.currentRound,
      enemiesRemaining,
      message,
    });
  }

  private log(message: string) {
    if (this.props.debug) {
      console.log(`[RoundManager] ${message}`);
    }
  }
}

hz.Component.register(RoundManager);
