import * as hz from 'horizon/core';
import { playerDamageEvent } from 'PlayerHealth';
import {
  activateZombieEvent,
  awardMoneyEvent,
  damageEvent,
  zombieDefeatedEvent,
} from 'GameEvents';

/** Whisker angles tried in order, smallest deviation first. */
const STEER_ANGLES = [30, 60, 90, 120, 150];

/**
 * TargetHealth
 * ------------
 * Enemy health, rewards, locomotion and melee attack.
 *
 * IMPORTANT: this component resolves its own body, head and health bar by
 * walking its own descendants at runtime rather than trusting the editor
 * props. Copies produced by world.spawnAsset() do not reliably rewire entity
 * props to the new instance's children, so prop-based references had every
 * pooled zombie manipulating the ORIGINAL template's mesh - which read as the
 * original enemy going invisible while still chasing and attacking.
 *
 * The props are kept as a fallback for a hand-placed enemy whose children are
 * not tagged.
 */
class TargetHealth extends hz.Component<typeof TargetHealth> {
  static propsDefinition = {
    maxHealth: { type: hz.PropTypes.Number, default: 100 },

    // Fallbacks only. Runtime resolution by tag/name wins when it succeeds.
    healthBarFill: { type: hz.PropTypes.Entity },
    healthText: { type: hz.PropTypes.Entity },
    healthBarRoot: { type: hz.PropTypes.Entity },
    enemyVisual: { type: hz.PropTypes.Entity },
    bodyHitbox: { type: hz.PropTypes.Entity },
    headHitbox: { type: hz.PropTypes.Entity },

    hitMarkerSfx: { type: hz.PropTypes.Entity },
    headshotKillSfx: { type: hz.PropTypes.Entity },
    deathSfx: { type: hz.PropTypes.Entity },

    hideOnDeath: { type: hz.PropTypes.Boolean, default: true },
    respawnDelay: { type: hz.PropTypes.Number, default: 3 },

    playerHealthManager: { type: hz.PropTypes.Entity },
    attackSfx: { type: hz.PropTypes.Entity },

    attackDamage: { type: hz.PropTypes.Number, default: 20 },
    attackRange: { type: hz.PropTypes.Number, default: 2.1 },
    /**
     * Maximum height difference for a melee hit to land. Without this, the
     * horizontal-only chase distance let zombies punch through floors and
     * ceilings from many metres above or below the player.
     */
    attackVerticalRange: { type: hz.PropTypes.Number, default: 2.5 },
    attackCooldown: { type: hz.PropTypes.Number, default: 1 },

    moneyPerHit: { type: hz.PropTypes.Number, default: 10 },
    moneyPerKill: { type: hz.PropTypes.Number, default: 50 },
    moneyPerHeadshotKill: { type: hz.PropTypes.Number, default: 100 },

    chaseEnabled: { type: hz.PropTypes.Boolean, default: true },
    moveSpeed: { type: hz.PropTypes.Number, default: 1.5 },
    stopDistance: { type: hz.PropTypes.Number, default: 1.8 },

    faceThePlayer: { type: hz.PropTypes.Boolean, default: true },
    facingOffsetDegrees: { type: hz.PropTypes.Number, default: 0 },

    sideCommitSeconds: { type: hz.PropTypes.Number, default: 1.2 },
    /**
     * Seconds of being fully blocked before shoving forward anyway. Stops a
     * zombie spawned inside geometry from freezing there permanently.
     */
    unstickAfterSeconds: { type: hz.PropTypes.Number, default: 2 },
    /** Seconds between heading re-evaluations. Each one costs up to 22 rays. */
    steerInterval: { type: hz.PropTypes.Number, default: 0.2 },

    groundRaycast: { type: hz.PropTypes.Entity },
    probeAhead: { type: hz.PropTypes.Number, default: 0.6 },
    probeHeight: { type: hz.PropTypes.Number, default: 1.5 },
    maxDrop: { type: hz.PropTypes.Number, default: 5 },

    bodyRadius: { type: hz.PropTypes.Number, default: 0.5 },
    wallProbeDistance: { type: hz.PropTypes.Number, default: 0.8 },
    wallProbeHeight: { type: hz.PropTypes.Number, default: 0.3 },

    maxStepUp: { type: hz.PropTypes.Number, default: 0.5 },
    maxStepDown: { type: hz.PropTypes.Number, default: 1 },

    /**
     * Distance from this entity's pivot down to the feet. Replaces the old
     * auto-calibrated offset, which measured itself AFTER the zombie had been
     * teleported to a spawn point - so a spawn point floating above or below
     * the terrain baked that error in permanently and the zombie flew or
     * burrowed for the rest of its life.
     */
    footHeight: { type: hz.PropTypes.Number, default: 0.9 },

    debugMovement: { type: hz.PropTypes.Boolean, default: false },

    roundManaged: { type: hz.PropTypes.Boolean, default: false },
  };

  private health = 0;
  private isDead = false;
  private isActive = true;

  private lastAttackTime = 0;

  private fillFullScale: hz.Vec3 | null = null;
  private fillFullPosition: hz.Vec3 | null = null;

  private spawnPosition: hz.Vec3 | null = null;
  private spawnRotation: hz.Quaternion | null = null;

  private preferredSide = 0;
  private sideCommitCountdown = 0;

  // Resolved from our own descendants at start.
  private ownBody: hz.Entity | null = null;
  private ownHead: hz.Entity | null = null;
  private ownBarRoot: hz.Entity | null = null;
  private ownBarFill: hz.Entity | null = null;
  private ownGroundRaycast: hz.Entity | null = null;

  private blockedSeconds = 0;
  private lastBlockedLogAt = 0;
  private steerCountdown = 0;
  private cachedHeading: {
    x: number;
    z: number;
    groundY: number | null;
  } | null = null;

  private runtimePlayerHealthManager: hz.Entity | null = null;

  preStart() {
    this.connectLocalEvent(this.entity, damageEvent, (data) => {
      this.takeDamage(data.attacker, data.amount, data.isHeadshot);
    });

    this.connectLocalEvent(this.entity, activateZombieEvent, (data) => {
      this.activateForRound(
        data.position,
        data.rotation,
        data.playerHealthManager,
      );
    });

    this.connectLocalBroadcastEvent(
      hz.World.onUpdate,
      (data: { deltaTime: number }) => {
        this.chaseTick(data.deltaTime);
      },
    );
  }

  start() {
    this.health = Math.max(1, this.props.maxHealth);

    this.spawnPosition = this.entity.position.get().clone();
    this.spawnRotation = this.entity.rotation.get().clone();

    this.resolveOwnParts();

    const fill = this.ownBarFill;
    if (fill) {
      this.fillFullScale = fill.transform.localScale.get().clone();
      this.fillFullPosition = fill.transform.localPosition.get().clone();
    } else {
      console.warn('TargetHealth: could not resolve a health bar fill.');
    }

    if (!this.ownGroundRaycast) {
      console.warn(
        'TargetHealth: no Raycast gizmo found among my children and no ' +
          'groundRaycast prop set. Ground snapping and wall detection are ' +
          'both disabled - this zombie will spawn at the marker height.',
      );
    }

    const roundManaged = this.props.roundManaged;

    this.isDead = false;
    this.isActive = !roundManaged;

    this.setEnemyAlive(this.isActive);
    this.refreshBar();

    console.log(
      roundManaged
        ? 'TargetHealth: pooled zombie waiting for a round.'
        : 'TargetHealth: standalone enemy ready.',
    );
  }

  // ----------------------------------------------------------- own children

  /**
   * Finds this instance's own body, head and health bar. Tags identify the
   * hitboxes; names identify the bar. Props are only consulted when a part
   * cannot be found among our descendants.
   */
  private resolveOwnParts() {
    const descendants = this.collectDescendants(this.entity, 3);

    for (const entity of descendants) {
      const name = entity.name.get();

      if (!this.ownBody && entity.tags.contains('body')) {
        this.ownBody = entity;
      } else if (!this.ownHead && entity.tags.contains('head')) {
        this.ownHead = entity;
      }

      if (!this.ownBarFill && name.indexOf('Bar_Fill') >= 0) {
        this.ownBarFill = entity;
      } else if (!this.ownBarRoot && name.indexOf('HealthBar') >= 0) {
        this.ownBarRoot = entity;
      }

      // Same reasoning as the mesh: a spawned copy's prop may still point at
      // the template's gizmo, or at nothing at all.
      if (!this.ownGroundRaycast && name.indexOf('Raycast') >= 0) {
        this.ownGroundRaycast = entity;
      }
    }

    this.ownBody = this.ownBody ?? this.props.bodyHitbox ?? null;
    this.ownHead = this.ownHead ?? this.props.headHitbox ?? null;
    this.ownBarRoot = this.ownBarRoot ?? this.props.healthBarRoot ?? null;
    this.ownBarFill = this.ownBarFill ?? this.props.healthBarFill ?? null;
    this.ownGroundRaycast =
      this.ownGroundRaycast ?? this.props.groundRaycast ?? null;

    if (this.props.debugMovement) {
      console.log(
        `TargetHealth: resolved parts body=${this.ownBody?.name.get() ?? 'none'} ` +
          `head=${this.ownHead?.name.get() ?? 'none'} ` +
          `barRoot=${this.ownBarRoot?.name.get() ?? 'none'} ` +
          `barFill=${this.ownBarFill?.name.get() ?? 'none'} ` +
          `raycast=${this.ownGroundRaycast?.name.get() ?? 'NONE'}`,
      );
    }
  }

  private collectDescendants(root: hz.Entity, depth: number): hz.Entity[] {
    if (depth <= 0) {
      return [];
    }

    const found: hz.Entity[] = [];
    const children = root.children.get();

    for (const child of children) {
      found.push(child);

      for (const nested of this.collectDescendants(child, depth - 1)) {
        found.push(nested);
      }
    }

    return found;
  }

  private activateForRound(
    position: hz.Vec3,
    rotation: hz.Quaternion,
    playerHealthManager: hz.Entity,
  ) {
    if (!this.props.roundManaged) {
      return;
    }

    this.runtimePlayerHealthManager = playerHealthManager;

    this.health = Math.max(1, this.props.maxHealth);

    this.preferredSide = 0;
    this.sideCommitCountdown = 0;
    this.lastAttackTime = 0;
    this.blockedSeconds = 0;
    this.steerCountdown = 0;
    this.cachedHeading = null;

    // The spawn point's own height is not trusted; find the real ground
    // beneath it so a badly placed marker cannot bury or levitate a zombie.
    const placed = this.groundedSpawnPosition(position);

    this.entity.position.set(placed);
    this.entity.rotation.set(rotation);

    this.isDead = false;
    this.isActive = true;

    this.setEnemyAlive(true);
    this.refreshBar();

    // Log where it actually ended up, not the marker we were handed.
    console.log(`TargetHealth: zombie activated at ${placed.toString()}`);
  }

  // ---------------------------------------------------------------- health

  /**
   * Places a spawn position on the real ground. Spawn markers get dragged
   * around in the editor and end up at arbitrary heights; without this, a
   * marker below the terrain spawns the zombie inside the map.
   */
  private groundedSpawnPosition(requested: hz.Vec3): hz.Vec3 {
    const gizmo = this.ownGroundRaycast?.as(hz.RaycastGizmo);
    if (!gizmo) {
      return requested;
    }

    // Search generously above and below - a marker may sit either side of the
    // surface, and we have no idea which.
    const searchAbove = 20;
    const searchTotal = searchAbove + 60;

    const hit = gizmo.raycast(
      new hz.Vec3(requested.x, requested.y + searchAbove, requested.z),
      new hz.Vec3(0, -1, 0),
      { layerType: hz.LayerType.Both, maxDistance: searchTotal },
    );

    if (hit == null || this.isHitbox(hit)) {
      console.warn(
        `TargetHealth: no ground found near spawn ${requested.toString()}; ` +
          'using the marker height as-is.',
      );
      return requested;
    }

    const grounded = new hz.Vec3(
      requested.x,
      hit.hitPoint.y + this.props.footHeight,
      requested.z,
    );

    // Always printed: one line per spawn, and it is the single most useful
    // thing when a zombie ends up in the floor.
    console.log(
      `TargetHealth: SPAWN marker Y ${requested.y.toFixed(2)} -> ` +
        `ground ${hit.hitPoint.y.toFixed(2)} -> ` +
        `placed ${grounded.y.toFixed(2)} (footHeight ${this.props.footHeight})`,
    );

    return grounded;
  }

  private takeDamage(
    attacker: hz.Player,
    amount: number,
    isHeadshot: boolean,
  ) {
    if (this.isDead || !this.isActive) {
      return;
    }

    const actualDamage = Math.max(0, amount);
    if (actualDamage <= 0) {
      return;
    }

    this.props.hitMarkerSfx?.as(hz.AudioGizmo)?.play();

    this.health = Math.max(0, this.health - actualDamage);

    console.log(
      `TargetHealth: ${isHeadshot ? 'head' : 'body'} for ${actualDamage} -> ` +
        `${this.health}/${this.props.maxHealth}`,
    );

    this.pay(attacker, this.props.moneyPerHit, 'hit');

    this.refreshBar();

    if (this.health <= 0) {
      this.die(attacker, isHeadshot);
    }
  }

  private die(killer: hz.Player, killedByHeadshot: boolean) {
    if (this.isDead) {
      return;
    }

    this.isDead = true;
    this.isActive = false;

    this.setEnemyAlive(false);

    if (killedByHeadshot) {
      this.props.headshotKillSfx?.as(hz.AudioGizmo)?.play();
      console.log('TargetHealth: HEADSHOT KILL');
      this.pay(killer, this.props.moneyPerHeadshotKill, 'headshot kill');
    } else {
      this.props.deathSfx?.as(hz.AudioGizmo)?.play();
      console.log('TargetHealth: TARGET DOWN');
      this.pay(killer, this.props.moneyPerKill, 'kill');
    }

    if (this.props.roundManaged) {
      // Small delay so the death audio starts before the manager reuses us.
      this.async.setTimeout(() => {
        this.sendLocalBroadcastEvent(zombieDefeatedEvent, {
          zombie: this.entity,
          killer,
        });
      }, 100);

      return;
    }

    this.async.setTimeout(() => {
      this.resetStandaloneEnemy();
    }, this.props.respawnDelay * 1000);
  }

  private resetStandaloneEnemy() {
    this.health = Math.max(1, this.props.maxHealth);

    this.preferredSide = 0;
    this.sideCommitCountdown = 0;
    this.lastAttackTime = 0;
    this.blockedSeconds = 0;
    this.steerCountdown = 0;
    this.cachedHeading = null;

    if (this.spawnPosition) {
      this.entity.position.set(this.spawnPosition);
    }

    if (this.spawnRotation) {
      this.entity.rotation.set(this.spawnRotation);
    }

    this.isDead = false;
    this.isActive = true;

    this.setEnemyAlive(true);
    this.refreshBar();

    console.log('TargetHealth: standalone target respawned.');
  }

  private pay(player: hz.Player, amount: number, reason: string) {
    if (amount <= 0) {
      return;
    }

    this.sendLocalBroadcastEvent(awardMoneyEvent, { player, amount, reason });
  }

  private setEnemyAlive(alive: boolean) {
    // Only the body's visibility is touched. The head is an intentionally
    // invisible hitbox, so showing it would put a floating sphere on screen.
    if (this.props.hideOnDeath) {
      this.ownBody?.visible.set(alive);
    }

    this.ownBarRoot?.visible.set(alive);

    this.ownBody?.collidable.set(alive);
    this.ownHead?.collidable.set(alive);
  }

  private refreshBar() {
    const maxHealth = Math.max(1, this.props.maxHealth);
    const fraction = Math.max(0, Math.min(1, this.health / maxHealth));

    const fill = this.ownBarFill;

    if (fill && this.fillFullScale && this.fillFullPosition) {
      const scale = this.fillFullScale.clone();
      scale.x = this.fillFullScale.x * fraction;
      fill.transform.localScale.set(scale);

      const position = this.fillFullPosition.clone();
      position.x =
        this.fillFullPosition.x - (this.fillFullScale.x * (1 - fraction)) / 2;
      fill.transform.localPosition.set(position);
    }

    const text = this.props.healthText;
    if (text) {
      text.as(hz.TextGizmo)?.text.set(`${this.health} / ${maxHealth}`);
    }
  }

  // -------------------------------------------------------------- movement

  private chaseTick(deltaTime: number) {
    if (!this.props.chaseEnabled || this.isDead || !this.isActive) {
      return;
    }

    const myPos = this.entity.position.get();
    const player = this.nearestPlayer(myPos);
    if (!player) {
      return;
    }

    const playerPos = player.position.get();

    const dx = playerPos.x - myPos.x;
    const dy = playerPos.y - myPos.y;
    const dz = playerPos.z - myPos.z;

    // Horizontal for steering; full 3D for deciding whether we can reach.
    const flatDistance = Math.sqrt(dx * dx + dz * dz);
    if (flatDistance < 0.001) {
      return;
    }

    const toPlayerX = dx / flatDistance;
    const toPlayerZ = dz / flatDistance;

    this.tryAttack(player, flatDistance, dy);

    if (flatDistance <= this.props.stopDistance) {
      this.faceDirection(toPlayerX, toPlayerZ);
      this.preferredSide = 0;
      this.sideCommitCountdown = 0;
      this.blockedSeconds = 0;
      return;
    }

    const heading = this.currentHeading(
      myPos,
      toPlayerX,
      toPlayerZ,
      deltaTime,
    );

    if (!heading) {
      this.faceDirection(toPlayerX, toPlayerZ);
      this.blockedSeconds += deltaTime;

      if (this.blockedSeconds < this.props.unstickAfterSeconds) {
        // Throttled: this used to print every frame for every zombie and
        // buried every other line in the console.
        const now = Date.now();
        if (this.props.debugMovement && now - this.lastBlockedLogAt > 1000) {
          this.lastBlockedLogAt = now;
          console.log(
            `TargetHealth: blocked at ${myPos.toString()} ` +
              `(${this.blockedSeconds.toFixed(1)}s)`,
          );
        }
        return;
      }

      // Fully boxed in for too long - shove straight at the player rather
      // than stand still forever. A zombie spawned inside geometry would
      // otherwise never move again.
      const now = Date.now();
      if (this.props.debugMovement && now - this.lastBlockedLogAt > 1000) {
        this.lastBlockedLogAt = now;
        console.log('TargetHealth: unsticking - forcing a step forward.');
      }

      const forcedStep = this.props.moveSpeed * deltaTime;
      this.entity.position.set(
        new hz.Vec3(
          myPos.x + toPlayerX * forcedStep,
          myPos.y,
          myPos.z + toPlayerZ * forcedStep,
        ),
      );
      return;
    }

    this.blockedSeconds = 0;
    this.faceDirection(heading.x, heading.z);

    const step = Math.min(
      this.props.moveSpeed * deltaTime,
      flatDistance - this.props.stopDistance,
    );

    const nextX = myPos.x + heading.x * step;
    const nextZ = myPos.z + heading.z * step;

    if (heading.groundY == null) {
      // No ground reading: hold height. If a zombie is stuck in the floor and
      // never rises, this is the branch it is taking.
      const now = Date.now();
      if (this.props.debugMovement && now - this.lastBlockedLogAt > 1000) {
        this.lastBlockedLogAt = now;
        console.log(
          `TargetHealth: no ground under me at ${myPos.toString()} - ` +
            'holding height. footHeight cannot apply here.',
        );
      }

      this.entity.position.set(new hz.Vec3(nextX, myPos.y, nextZ));
      return;
    }

    const desiredY = heading.groundY + this.props.footHeight;

    this.entity.position.set(new hz.Vec3(nextX, desiredY, nextZ));
  }

  /**
   * Re-evaluates the heading on an interval and reuses it in between. Each
   * evaluation is up to 22 raycasts, which at 60fps across a full wave of
   * zombies is far more than the behaviour needs.
   */
  private currentHeading(
    from: hz.Vec3,
    toPlayerX: number,
    toPlayerZ: number,
    deltaTime: number,
  ): { x: number; z: number; groundY: number | null } | null {
    this.steerCountdown -= deltaTime;

    if (this.steerCountdown > 0 && this.cachedHeading) {
      return this.cachedHeading;
    }

    this.steerCountdown = this.props.steerInterval;
    this.cachedHeading = this.chooseHeading(
      from,
      toPlayerX,
      toPlayerZ,
      deltaTime,
    );

    return this.cachedHeading;
  }

  private tryAttack(
    player: hz.Player,
    flatDistance: number,
    heightDifference: number,
  ) {
    if (flatDistance > this.props.attackRange) {
      return;
    }

    // Reject swings through floors and ceilings.
    if (Math.abs(heightDifference) > this.props.attackVerticalRange) {
      return;
    }

    const now = Date.now();
    if (now - this.lastAttackTime < this.props.attackCooldown * 1000) {
      return;
    }

    this.lastAttackTime = now;

    const manager =
      this.runtimePlayerHealthManager ?? this.props.playerHealthManager;

    if (!manager) {
      console.warn('TargetHealth: no player health manager.');
      return;
    }

    this.props.attackSfx?.as(hz.AudioGizmo)?.play();

    this.sendLocalEvent(manager, playerDamageEvent, {
      player,
      amount: this.props.attackDamage,
    });

    console.log(
      `TargetHealth: attacked "${player.name.get()}" for ` +
        `${this.props.attackDamage}`,
    );
  }

  private chooseHeading(
    from: hz.Vec3,
    toPlayerX: number,
    toPlayerZ: number,
    deltaTime: number,
  ): { x: number; z: number; groundY: number | null } | null {
    this.sideCommitCountdown -= deltaTime;

    if (this.sideCommitCountdown <= 0) {
      this.preferredSide = 0;
    }

    for (const angle of this.buildAngles()) {
      const heading = this.rotateHeading(toPlayerX, toPlayerZ, angle);
      const probe = this.evaluateHeading(from, heading.x, heading.z);

      if (!probe.walkable) {
        continue;
      }

      if (angle === 0) {
        this.preferredSide = 0;
        this.sideCommitCountdown = 0;
      } else {
        this.preferredSide = angle > 0 ? 1 : -1;
        this.sideCommitCountdown = this.props.sideCommitSeconds;
      }

      return { x: heading.x, z: heading.z, groundY: probe.groundY };
    }

    return null;
  }

  private buildAngles(): number[] {
    const side = this.preferredSide === 0 ? 1 : this.preferredSide;
    const angles: number[] = [0];

    for (const magnitude of STEER_ANGLES) {
      angles.push(magnitude * side);
      angles.push(-magnitude * side);
    }

    return angles;
  }

  private rotateHeading(
    x: number,
    z: number,
    degrees: number,
  ): { x: number; z: number } {
    const radians = (degrees * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);

    return {
      x: x * cos + z * sin,
      z: -x * sin + z * cos,
    };
  }

  private evaluateHeading(
    from: hz.Vec3,
    dirX: number,
    dirZ: number,
  ): { walkable: boolean; groundY: number | null } {
    if (this.isWallAhead(from, dirX, dirZ)) {
      return { walkable: false, groundY: null };
    }

    const groundY = this.probeGround(from, dirX, dirZ);

    if (groundY == null) {
      return { walkable: true, groundY: null };
    }

    const desiredY = groundY + this.props.footHeight;
    const rise = desiredY - from.y;

    if (rise > this.props.maxStepUp || rise < -this.props.maxStepDown) {
      return { walkable: false, groundY };
    }

    return { walkable: true, groundY };
  }

  private probeGround(
    from: hz.Vec3,
    dirX: number,
    dirZ: number,
  ): number | null {
    const gizmo = this.ownGroundRaycast?.as(hz.RaycastGizmo);
    if (!gizmo) {
      return null;
    }

    const origin = new hz.Vec3(
      from.x + dirX * this.props.probeAhead,
      from.y + this.props.probeHeight,
      from.z + dirZ * this.props.probeAhead,
    );

    const hit = gizmo.raycast(origin, new hz.Vec3(0, -1, 0), {
      layerType: hz.LayerType.Both,
      maxDistance: this.props.probeHeight + this.props.maxDrop,
    });

    if (hit == null || this.isHitbox(hit)) {
      return null;
    }

    return hit.hitPoint.y;
  }

  private isWallAhead(from: hz.Vec3, dirX: number, dirZ: number): boolean {
    const gizmo = this.ownGroundRaycast?.as(hz.RaycastGizmo);
    if (!gizmo) {
      return false;
    }

    const origin = new hz.Vec3(
      from.x + dirX * this.props.bodyRadius,
      from.y + this.props.wallProbeHeight,
      from.z + dirZ * this.props.bodyRadius,
    );

    const hit = gizmo.raycast(origin, new hz.Vec3(dirX, 0, dirZ), {
      layerType: hz.LayerType.Both,
      maxDistance: this.props.wallProbeDistance,
    });

    if (hit == null) {
      return false;
    }

    if (hit.targetType === hz.RaycastTargetType.Player) {
      return false;
    }

    return !this.isHitbox(hit);
  }

  /** Any zombie's hitbox, ours or another's - never treated as a wall. */
  private isHitbox(hit: hz.RaycastHit): boolean {
    if (hit.targetType !== hz.RaycastTargetType.Entity) {
      return false;
    }

    return (
      hit.target.tags.contains('head') || hit.target.tags.contains('body')
    );
  }

  private faceDirection(dirX: number, dirZ: number) {
    if (!this.props.faceThePlayer) {
      return;
    }

    const yaw =
      (Math.atan2(dirX, dirZ) * 180) / Math.PI +
      this.props.facingOffsetDegrees;

    this.entity.rotation.set(
      hz.Quaternion.fromEuler(new hz.Vec3(0, yaw, 0)),
    );
  }

  private nearestPlayer(from: hz.Vec3): hz.Player | null {
    const players = this.world.getPlayers();

    let nearest: hz.Player | null = null;
    let nearestDistanceSq = Number.MAX_VALUE;

    for (const player of players) {
      const position = player.position.get();
      const dx = position.x - from.x;
      const dz = position.z - from.z;
      const distanceSq = dx * dx + dz * dz;

      if (distanceSq < nearestDistanceSq) {
        nearestDistanceSq = distanceSq;
        nearest = player;
      }
    }

    return nearest;
  }
}

hz.Component.register(TargetHealth);
