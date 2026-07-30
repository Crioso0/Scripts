import * as hz from 'horizon/core';

import {
  activateZombieEvent,
  roundStateEvent,
  zombieDefeatedEvent,
} from 'GameEvents';

class RoundManager extends hz.Component<typeof RoundManager> {
  static propsDefinition = {
    zombieAsset: { type: hz.PropTypes.Asset },
    playerHealthManager: { type: hz.PropTypes.Entity },
    holdingPoint: { type: hz.PropTypes.Entity },

    spawnPoints: { type: hz.PropTypes.EntityArray },
    spawnUnlockRounds: { type: hz.PropTypes.NumberArray },

    startingRound: { type: hz.PropTypes.Number, default: 1 },
    baseZombies: { type: hz.PropTypes.Number, default: 3 },
    zombiesAddedPerRound: { type: hz.PropTypes.Number, default: 2 },

    /** Pool size. Also the cap on how many can be alive simultaneously. */
    maxAliveAtOnce: { type: hz.PropTypes.Number, default: 3 },

    spawnInterval: { type: hz.PropTypes.Number, default: 1 },
    firstRoundDelay: { type: hz.PropTypes.Number, default: 3 },
    betweenRoundDelay: { type: hz.PropTypes.Number, default: 5 },

    debug: { type: hz.PropTypes.Boolean, default: true },
  };

  private zombiePool: hz.Entity[] = [];
  private activeZombies = new Set<hz.Entity>();

  private currentRound = 0;
  private remainingToSpawn = 0;

  private completedPoolRequests = 0;
  private poolRequested = 0;

  private spawnTimerPending = false;
  private roundTimerPending = false;

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

    this.currentRound =
      Math.max(1, Math.floor(this.props.startingRound)) - 1;

    this.createZombiePool();
  }

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
            this.log(
              `pooled zombie ${this.zombiePool.length}/${requested}`,
            );
          } else {
            console.warn(
              'RoundManager: zombie asset spawned no root entity.',
            );
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
      console.error('RoundManager: zombie pool is empty.');
      return;
    }

    this.log(`pool ready with ${this.zombiePool.length} zombies`);

    this.broadcastState(0, 'GET READY');
    this.scheduleNextRound(this.props.firstRoundDelay);
  }

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

    const roundIndex =
      this.currentRound - Math.max(1, Math.floor(this.props.startingRound));

    this.remainingToSpawn = Math.max(
      1,
      Math.floor(
        this.props.baseZombies +
          Math.max(0, roundIndex) * this.props.zombiesAddedPerRound,
      ),
    );

    this.log(
      `ROUND ${this.currentRound}: ${this.remainingToSpawn} zombies`,
    );

    this.broadcastState(this.remainingEnemies(), 'ROUND ACTIVE');
    this.scheduleSpawn(0.25);
  }

  private scheduleSpawn(delaySeconds: number) {
    if (this.spawnTimerPending || this.remainingToSpawn <= 0) {
      return;
    }

    if (this.activeZombies.size >= this.zombiePool.length) {
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
      return;
    }

    const spawnPoint = this.chooseSpawnPoint();
    if (!spawnPoint) {
      console.error('RoundManager: no spawn point is unlocked.');
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

    this.log(`spawned zombie at "${spawnPoint.name.get()}"`);

    this.broadcastState(this.remainingEnemies(), 'ROUND ACTIVE');

    if (this.remainingToSpawn > 0) {
      this.scheduleSpawn(this.props.spawnInterval);
    }
  }

  private onZombieDefeated(zombie: hz.Entity, killer: hz.Player) {
    if (!this.activeZombies.has(zombie)) {
      return;
    }

    this.activeZombies.delete(zombie);

    this.log(`"${killer.name.get()}" defeated a zombie`);

    const remaining = this.remainingEnemies();

    if (remaining <= 0) {
      this.broadcastState(0, 'ROUND CLEAR');
      this.log(`ROUND ${this.currentRound} CLEAR`);
      this.scheduleNextRound(this.props.betweenRoundDelay);
      return;
    }

    this.broadcastState(remaining, 'ROUND ACTIVE');

    if (this.remainingToSpawn > 0) {
      this.scheduleSpawn(this.props.spawnInterval);
    }
  }

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

    for (let index = 0; index < this.props.spawnPoints.length; index++) {
      const spawnPoint = this.props.spawnPoints[index];
      if (!spawnPoint) {
        continue;
      }

      const configuredRound = this.props.spawnUnlockRounds[index];

      const unlockRound =
        configuredRound == null
          ? 1
          : Math.max(1, Math.floor(configuredRound));

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
