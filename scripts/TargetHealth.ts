import * as hz from 'horizon/core';
import { playerDamageEvent } from 'PlayerHealth';
import {
  activateZombieEvent,
  awardMoneyEvent,
  damageEvent,
  zombieDefeatedEvent,
} from 'GameEvents';

/** Whisker angles tried in order, smallest deviation from straight-on first. */
const STEER_ANGLES = [30, 60, 90, 120, 150];

/** Compass offsets used to sample the ground around the body. */
const GROUND_SAMPLE_DIRECTIONS = [
  { x: 1, z: 0 },
  { x: -1, z: 0 },
  { x: 0, z: 1 },
  { x: 0, z: -1 },
];

/**
 * TargetHealth
 * ============
 * One enemy: health, rewards, presentation, locomotion and melee.
 *
 * Two design rules worth keeping, both learned the hard way:
 *
 * 1. Every child reference is resolved at runtime by walking our own
 *    descendants. Copies made by world.spawnAsset() do not reliably rewire
 *    entity props, so prop-based references had pooled zombies driving the
 *    original template's mesh. Props remain only as a fallback.
 *
 * 2. There is exactly one ground authority: groundBeneath(). Spawn placement,
 *    standing height and walkability all ask it. When that logic was
 *    duplicated across three probes with different search ranges, they
 *    disagreed - one would find a tree canopy while another found terrain
 *    five metres lower.
 */
class TargetHealth extends hz.Component<typeof TargetHealth> {
  static propsDefinition = {
    // ---- health -------------------------------------------------------
    maxHealth: { type: hz.PropTypes.Number, default: 100 },
    respawnDelay: { type: hz.PropTypes.Number, default: 3 },
    /** Hide the mesh while dead. Off is useful when debugging placement. */
    hideOnDeath: { type: hz.PropTypes.Boolean, default: true },

    // ---- child references (fallback only; resolved at runtime) ---------
    healthBarFill: { type: hz.PropTypes.Entity },
    healthBarRoot: { type: hz.PropTypes.Entity },
    healthText: { type: hz.PropTypes.Entity },
    bodyHitbox: { type: hz.PropTypes.Entity },
    headHitbox: { type: hz.PropTypes.Entity },
    groundRaycast: { type: hz.PropTypes.Entity },

    // ---- audio --------------------------------------------------------
    hitMarkerSfx: { type: hz.PropTypes.Entity },
    headshotKillSfx: { type: hz.PropTypes.Entity },
    deathSfx: { type: hz.PropTypes.Entity },
    attackSfx: { type: hz.PropTypes.Entity },
    spawnSfx: { type: hz.PropTypes.Entity },

    // ---- particles ----------------------------------------------------
    // All optional. Each is a Particle gizmo; it gets moved to the relevant
    // spot and played. Leave any of them empty and that beat is silent.
    hitVfx: { type: hz.PropTypes.Entity },
    headshotVfx: { type: hz.PropTypes.Entity },
    deathVfx: { type: hz.PropTypes.Entity },
    spawnVfx: { type: hz.PropTypes.Entity },
    /** Height above the pivot where hit and headshot effects play. */
    hitVfxHeight: { type: hz.PropTypes.Number, default: 1 },

    // ---- rewards ------------------------------------------------------
    moneyPerHit: { type: hz.PropTypes.Number, default: 10 },
    moneyPerKill: { type: hz.PropTypes.Number, default: 50 },
    moneyPerHeadshotKill: { type: hz.PropTypes.Number, default: 100 },

    // ---- combat -------------------------------------------------------
    playerHealthManager: { type: hz.PropTypes.Entity },
    attackDamage: { type: hz.PropTypes.Number, default: 20 },
    attackRange: { type: hz.PropTypes.Number, default: 2.1 },
    /** Melee also needs the player within this height, or it reaches through
     *  floors: chase distance is horizontal only by design. */
    attackVerticalRange: { type: hz.PropTypes.Number, default: 2.5 },
    attackCooldown: { type: hz.PropTypes.Number, default: 1 },

    // ---- locomotion ---------------------------------------------------
    chaseEnabled: { type: hz.PropTypes.Boolean, default: true },
    moveSpeed: { type: hz.PropTypes.Number, default: 1.5 },
    stopDistance: { type: hz.PropTypes.Number, default: 1.8 },
    faceThePlayer: { type: hz.PropTypes.Boolean, default: true },
    /** Correct a model whose mesh does not face along its own +Z. */
    facingOffsetDegrees: { type: hz.PropTypes.Number, default: 0 },

    /** Seconds to keep detouring the same way, so it stops oscillating. */
    sideCommitSeconds: { type: hz.PropTypes.Number, default: 1.2 },
    /** Seconds fully blocked before shoving forward regardless. */
    unstickAfterSeconds: { type: hz.PropTypes.Number, default: 2 },
    /** Seconds between heading re-evaluations; each costs up to 22 rays. */
    steerInterval: { type: hz.PropTypes.Number, default: 0.2 },

    // ---- ground and obstacles -----------------------------------------
    /** Distance from this entity's pivot down to the model's feet. */
    footHeight: { type: hz.PropTypes.Number, default: 0.9 },
    /** How far above the pivot ground rays start. */
    probeHeight: { type: hz.PropTypes.Number, default: 2 },
    /** How far below that they keep looking. */
    maxDrop: { type: hz.PropTypes.Number, default: 20 },
    /** Half the body's width. Ground is sampled at this radius. */
    bodyRadius: { type: hz.PropTypes.Number, default: 0.5 },
    /** How far ahead walkability is tested. */
    probeAhead: { type: hz.PropTypes.Number, default: 0.6 },
    wallProbeDistance: { type: hz.PropTypes.Number, default: 0.8 },
    wallProbeHeight: { type: hz.PropTypes.Number, default: 0.3 },
    /** Ground rising more than this ahead is a wall. */
    maxStepUp: { type: hz.PropTypes.Number, default: 0.5 },
    /** Ground falling more than this ahead is a cliff. */
    maxStepDown: { type: hz.PropTypes.Number, default: 1 },

    // ---- mode and diagnostics -----------------------------------------
    /** On: wait for RoundManager. Off: standalone, self-respawning dummy. */
    roundManaged: { type: hz.PropTypes.Boolean, default: false },
    debugMovement: { type: hz.PropTypes.Boolean, default: false },
  };

  // ---- state ----------------------------------------------------------
  private health = 0;
  private isDead = false;
  private isActive = true;

  private lastAttackTime = 0;

  private homePosition: hz.Vec3 | null = null;
  private homeRotation: hz.Quaternion | null = null;

  private barFullScale: hz.Vec3 | null = null;
  private barFullPosition: hz.Vec3 | null = null;

  private preferredSide = 0;
  private sideCommitCountdown = 0;
  private blockedSeconds = 0;
  private steerCountdown = 0;
  private cachedHeading: { x: number; z: number } | null = null;

  // Resolved from our own descendants at start.
  private ownBody: hz.Entity | null = null;
  private ownHead: hz.Entity | null = null;
  private ownBarRoot: hz.Entity | null = null;
  private ownBarFill: hz.Entity | null = null;
  private ownRaycast: hz.RaycastGizmo | null = null;

  private runtimeHealthManager: hz.Entity | null = null;

  private lastDebugLogAt = 0;

  // =====================================================================
  // lifecycle
  // =====================================================================

  preStart() {
    this.connectLocalEvent(this.entity, damageEvent, (data) => {
      this.takeDamage(data.attacker, data.amount, data.isHeadshot);
    });

    this.connectLocalEvent(this.entity, activateZombieEvent, (data) => {
      this.activate(data.position, data.rotation, data.playerHealthManager);
    });

    this.connectLocalBroadcastEvent(
      hz.World.onUpdate,
      (data: { deltaTime: number }) => {
        this.tick(data.deltaTime);
      },
    );
  }

  start() {
    this.health = this.maxHealth();
    this.homePosition = this.entity.position.get().clone();
    this.homeRotation = this.entity.rotation.get().clone();

    this.resolveOwnParts();
    this.captureBarGeometry();

    this.isDead = false;
    this.isActive = !this.props.roundManaged;

    this.setAlive(this.isActive);
    this.refreshBar();

    if (this.props.roundManaged) {
      console.log('TargetHealth: pooled, waiting for a round.');
      return;
    }

    console.log('TargetHealth: standalone enemy ready.');
    this.reportCalibration();
  }

  // =====================================================================
  // own children
  // =====================================================================

  /**
   * Identifies this instance's own parts. Hitboxes are found by tag, the bar
   * and raycast by name. Props are consulted only when a part is missing.
   */
  private resolveOwnParts() {
    for (const entity of this.descendants(this.entity, 3)) {
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

      if (!this.ownRaycast && name.indexOf('Raycast') >= 0) {
        this.ownRaycast = entity.as(hz.RaycastGizmo);
      }
    }

    this.ownBody = this.ownBody ?? this.props.bodyHitbox ?? null;
    this.ownHead = this.ownHead ?? this.props.headHitbox ?? null;
    this.ownBarRoot = this.ownBarRoot ?? this.props.healthBarRoot ?? null;
    this.ownBarFill = this.ownBarFill ?? this.props.healthBarFill ?? null;
    this.ownRaycast =
      this.ownRaycast ?? this.props.groundRaycast?.as(hz.RaycastGizmo) ?? null;

    if (!this.ownRaycast) {
      console.warn(
        'TargetHealth: no Raycast gizmo found. Ground height and wall ' +
          'detection are both disabled for this enemy.',
      );
    }

    if (this.props.debugMovement) {
      console.log(
        'TargetHealth: parts ' +
          `body=${this.nameOf(this.ownBody)} ` +
          `head=${this.nameOf(this.ownHead)} ` +
          `barRoot=${this.nameOf(this.ownBarRoot)} ` +
          `barFill=${this.nameOf(this.ownBarFill)} ` +
          `raycast=${this.ownRaycast ? 'yes' : 'NONE'}`,
      );
    }
  }

  private descendants(root: hz.Entity, depth: number): hz.Entity[] {
    if (depth <= 0) {
      return [];
    }

    const found: hz.Entity[] = [];

    for (const child of root.children.get()) {
      found.push(child);
      for (const nested of this.descendants(child, depth - 1)) {
        found.push(nested);
      }
    }

    return found;
  }

  private captureBarGeometry() {
    const fill = this.ownBarFill;
    if (!fill) {
      console.warn('TargetHealth: no health bar fill found.');
      return;
    }

    this.barFullScale = fill.transform.localScale.get().clone();
    this.barFullPosition = fill.transform.localPosition.get().clone();
  }

  // =====================================================================
  // ground - the single source of truth for height
  // =====================================================================

  /**
   * Height of the walkable surface at an X/Z, or null if nothing was found.
   *
   * Samples at four points on a ring of bodyRadius rather than straight down
   * at the centre. A ray starting inside the body just hits the body, and
   * stop-on-first-hit gives no way to see past it. The highest sample wins,
   * which keeps the model on top of a ledge rather than sinking at its edge.
   *
   * Every other part of this script asks this one method, so spawn placement,
   * standing height and walkability can never disagree.
   */
  private groundBeneath(x: number, z: number, fromY: number): number | null {
    const gizmo = this.ownRaycast;
    if (!gizmo) {
      return null;
    }

    const startY = fromY + this.props.probeHeight;
    const range = this.props.probeHeight + this.props.maxDrop;

    let highest: number | null = null;

    for (const direction of GROUND_SAMPLE_DIRECTIONS) {
      const hit = gizmo.raycast(
        new hz.Vec3(
          x + direction.x * this.props.bodyRadius,
          startY,
          z + direction.z * this.props.bodyRadius,
        ),
        new hz.Vec3(0, -1, 0),
        { layerType: hz.LayerType.Both, maxDistance: range },
      );

      if (hit == null || this.isAnyHitbox(hit)) {
        continue;
      }

      if (highest == null || hit.hitPoint.y > highest) {
        highest = hit.hitPoint.y;
      }
    }

    return highest;
  }

  /** Where this entity's pivot belongs, given the ground at an X/Z. */
  private restingY(groundY: number): number {
    return groundY + this.props.footHeight;
  }

  /** Calibration aid: prints the footHeight matching the current pose. */
  private reportCalibration() {
    const here = this.entity.position.get();
    const groundY = this.groundBeneath(here.x, here.z, here.y);

    if (groundY == null) {
      console.log(
        'TargetHealth: CALIBRATION - no ground beneath me. Stand me on ' +
          'solid ground to get a footHeight reading.',
      );
      return;
    }

    console.log(
      `TargetHealth: CALIBRATION - pivot Y ${here.y.toFixed(2)}, ground ` +
        `${groundY.toFixed(2)} -> footHeight ${(here.y - groundY).toFixed(2)} ` +
        `(currently ${this.props.footHeight})`,
    );
  }

  // =====================================================================
  // activation and respawn
  // =====================================================================

  private activate(
    position: hz.Vec3,
    rotation: hz.Quaternion,
    healthManager: hz.Entity,
  ) {
    if (!this.props.roundManaged) {
      return;
    }

    this.runtimeHealthManager = healthManager;
    this.resetRuntimeState();

    // The marker's own height is not trusted - markers get dragged around and
    // end up above the treeline or below the terrain.
    const groundY = this.groundBeneath(position.x, position.z, position.y);

    const placed =
      groundY == null
        ? position
        : new hz.Vec3(position.x, this.restingY(groundY), position.z);

    if (groundY == null) {
      console.warn(
        `TargetHealth: no ground near spawn ${position.toString()}; using ` +
          'the marker height as-is.',
      );
    }

    this.entity.position.set(placed);
    this.entity.rotation.set(rotation);

    this.isDead = false;
    this.isActive = true;

    this.setAlive(true);
    this.refreshBar();

    this.playSfx(this.props.spawnSfx);
    this.playVfx(this.props.spawnVfx, placed);

    console.log(`TargetHealth: activated at ${placed.toString()}`);
  }

  private resetToHome() {
    this.resetRuntimeState();

    if (this.homePosition) {
      this.entity.position.set(this.homePosition);
    }

    if (this.homeRotation) {
      this.entity.rotation.set(this.homeRotation);
    }

    this.isDead = false;
    this.isActive = true;

    this.setAlive(true);
    this.refreshBar();

    console.log('TargetHealth: standalone enemy respawned.');
  }

  private resetRuntimeState() {
    this.health = this.maxHealth();
    this.lastAttackTime = 0;
    this.preferredSide = 0;
    this.sideCommitCountdown = 0;
    this.blockedSeconds = 0;
    this.steerCountdown = 0;
    this.cachedHeading = null;
  }

  // =====================================================================
  // damage and death
  // =====================================================================

  private takeDamage(
    attacker: hz.Player,
    amount: number,
    isHeadshot: boolean,
  ) {
    if (this.isDead || !this.isActive) {
      return;
    }

    const damage = Math.max(0, amount);
    if (damage <= 0) {
      return;
    }

    this.health = Math.max(0, this.health - damage);

    this.playSfx(this.props.hitMarkerSfx);
    this.playVfx(
      isHeadshot ? this.props.headshotVfx : this.props.hitVfx,
      this.impactPoint(),
    );

    console.log(
      `TargetHealth: ${isHeadshot ? 'head' : 'body'} for ${damage} -> ` +
        `${this.health}/${this.maxHealth()}`,
    );

    this.pay(attacker, this.props.moneyPerHit, 'hit');
    this.refreshBar();

    if (this.health <= 0) {
      this.die(attacker, isHeadshot);
    }
  }

  private die(killer: hz.Player, byHeadshot: boolean) {
    if (this.isDead) {
      return;
    }

    this.isDead = true;
    this.isActive = false;

    const where = this.entity.position.get();
    this.setAlive(false);

    if (byHeadshot) {
      this.playSfx(this.props.headshotKillSfx);
      this.playVfx(this.props.headshotVfx, this.impactPoint());
      this.pay(killer, this.props.moneyPerHeadshotKill, 'headshot kill');
      console.log('TargetHealth: HEADSHOT KILL');
    } else {
      this.playSfx(this.props.deathSfx);
      this.pay(killer, this.props.moneyPerKill, 'kill');
      console.log('TargetHealth: TARGET DOWN');
    }

    this.playVfx(this.props.deathVfx, where);

    if (this.props.roundManaged) {
      // Brief delay so the death beat plays before the manager reuses us.
      this.async.setTimeout(() => {
        this.sendLocalBroadcastEvent(zombieDefeatedEvent, {
          zombie: this.entity,
          killer,
        });
      }, 100);
      return;
    }

    this.async.setTimeout(() => {
      this.resetToHome();
    }, this.props.respawnDelay * 1000);
  }

  private pay(player: hz.Player, amount: number, reason: string) {
    if (amount <= 0) {
      return;
    }

    this.sendLocalBroadcastEvent(awardMoneyEvent, { player, amount, reason });
  }

  // =====================================================================
  // presentation
  // =====================================================================

  private setAlive(alive: boolean) {
    // Only the body's visibility is touched. The head is an intentionally
    // invisible hitbox; showing it would put a floating sphere on screen.
    if (this.props.hideOnDeath) {
      this.ownBody?.visible.set(alive);
    }

    this.ownBarRoot?.visible.set(alive);

    this.ownBody?.collidable.set(alive);
    this.ownHead?.collidable.set(alive);
  }

  private refreshBar() {
    const max = this.maxHealth();
    const fraction = Math.max(0, Math.min(1, this.health / max));

    const fill = this.ownBarFill;

    if (fill && this.barFullScale && this.barFullPosition) {
      const scale = this.barFullScale.clone();
      scale.x = this.barFullScale.x * fraction;
      fill.transform.localScale.set(scale);

      // Slide by half of what was removed so the bar drains from one end
      // rather than shrinking towards its own centre.
      const position = this.barFullPosition.clone();
      position.x =
        this.barFullPosition.x - (this.barFullScale.x * (1 - fraction)) / 2;
      fill.transform.localPosition.set(position);
    }

    this.props.healthText?.as(hz.TextGizmo)?.text.set(`${this.health} / ${max}`);
  }

  private playSfx(sfx: hz.Entity | undefined) {
    sfx?.as(hz.AudioGizmo)?.play();
  }

  /** Moves a particle gizmo to a point and plays it. Safe when unassigned. */
  private playVfx(vfx: hz.Entity | undefined, at: hz.Vec3) {
    if (!vfx) {
      return;
    }

    vfx.position.set(at);

    // Let the transform land before playback, or the burst renders at the
    // emitter's previous position.
    this.async.setTimeout(() => {
      vfx.as(hz.ParticleGizmo)?.play();
    }, 50);
  }

  /** Roughly chest height - where hit effects look right. */
  private impactPoint(): hz.Vec3 {
    const here = this.entity.position.get();
    return new hz.Vec3(here.x, here.y + this.props.hitVfxHeight, here.z);
  }

  // =====================================================================
  // per-frame
  // =====================================================================

  /**
   * One read, one write, per frame.
   *
   * Height and movement used to be two separate position.set() calls. A set()
   * is not guaranteed to be visible to a get() on the same frame, so the
   * movement write kept resurrecting the pre-correction Y and burying the
   * model - but only while it was actually moving, which is why standing
   * still looked perfect.
   */
  private tick(deltaTime: number) {
    if (this.isDead || !this.isActive) {
      return;
    }

    const here = this.entity.position.get();

    const destination = this.props.chaseEnabled
      ? this.planMove(deltaTime, here)
      : null;

    const nextX = destination ? destination.x : here.x;
    const nextZ = destination ? destination.z : here.z;

    // Ground is sampled at where we are going, not where we were.
    const groundY = this.groundBeneath(nextX, nextZ, here.y);

    if (groundY == null) {
      this.debug(
        `no ground at ${nextX.toFixed(1)}, ${nextZ.toFixed(1)} - holding height`,
      );
    }

    const nextY = groundY == null ? here.y : this.restingY(groundY);

    this.entity.position.set(new hz.Vec3(nextX, nextY, nextZ));
  }

  /**
   * Decides where to stand next, horizontally. Returns null to stay put.
   * Never writes position - that is tick's job, once.
   */
  private planMove(
    deltaTime: number,
    here: hz.Vec3,
  ): { x: number; z: number } | null {
    const player = this.nearestPlayer(here);
    if (!player) {
      return null;
    }

    const playerPos = player.position.get();

    const dx = playerPos.x - here.x;
    const dy = playerPos.y - here.y;
    const dz = playerPos.z - here.z;

    // Steering is horizontal by design so enemies never climb towards a
    // player's head; melee gets the height difference separately.
    const distance = Math.sqrt(dx * dx + dz * dz);
    if (distance < 0.001) {
      return null;
    }

    const toPlayerX = dx / distance;
    const toPlayerZ = dz / distance;

    this.tryAttack(player, distance, dy);

    if (distance <= this.props.stopDistance) {
      this.face(toPlayerX, toPlayerZ);
      this.preferredSide = 0;
      this.sideCommitCountdown = 0;
      this.blockedSeconds = 0;
      return null;
    }

    const heading = this.currentHeading(
      here,
      toPlayerX,
      toPlayerZ,
      deltaTime,
    );

    if (!heading) {
      this.face(toPlayerX, toPlayerZ);
      this.blockedSeconds += deltaTime;

      if (this.blockedSeconds < this.props.unstickAfterSeconds) {
        this.debug(
          `blocked at ${here.toString()} (${this.blockedSeconds.toFixed(1)}s)`,
        );
        return null;
      }

      // Boxed in on every whisker for too long. Shove forward rather than
      // stand still forever - a spawn inside geometry would never recover.
      this.debug('unsticking - forcing a step');

      const forced = this.props.moveSpeed * deltaTime;
      return {
        x: here.x + toPlayerX * forced,
        z: here.z + toPlayerZ * forced,
      };
    }

    this.blockedSeconds = 0;
    this.face(heading.x, heading.z);

    const step = Math.min(
      this.props.moveSpeed * deltaTime,
      distance - this.props.stopDistance,
    );

    return {
      x: here.x + heading.x * step,
      z: here.z + heading.z * step,
    };
  }

  // =====================================================================
  // melee
  // =====================================================================

  private tryAttack(
    player: hz.Player,
    flatDistance: number,
    heightDifference: number,
  ) {
    if (flatDistance > this.props.attackRange) {
      return;
    }

    if (Math.abs(heightDifference) > this.props.attackVerticalRange) {
      return;
    }

    const now = Date.now();
    if (now - this.lastAttackTime < this.props.attackCooldown * 1000) {
      return;
    }

    this.lastAttackTime = now;

    const manager =
      this.runtimeHealthManager ?? this.props.playerHealthManager;

    if (!manager) {
      console.warn('TargetHealth: no player health manager assigned.');
      return;
    }

    this.playSfx(this.props.attackSfx);

    this.sendLocalEvent(manager, playerDamageEvent, {
      player,
      amount: this.props.attackDamage,
    });

    console.log(
      `TargetHealth: attacked "${player.name.get()}" for ` +
        `${this.props.attackDamage}`,
    );
  }

  // =====================================================================
  // steering
  // =====================================================================

  /** Re-evaluates on an interval; each evaluation costs up to 22 raycasts. */
  private currentHeading(
    from: hz.Vec3,
    toPlayerX: number,
    toPlayerZ: number,
    deltaTime: number,
  ): { x: number; z: number } | null {
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

  /**
   * Straight at the player first, then fanning out to either side. Handles
   * convex obstacles; a concave dead end can still trap it, since there is no
   * memory of where it has been.
   */
  private chooseHeading(
    from: hz.Vec3,
    toPlayerX: number,
    toPlayerZ: number,
    deltaTime: number,
  ): { x: number; z: number } | null {
    this.sideCommitCountdown -= deltaTime;

    if (this.sideCommitCountdown <= 0) {
      this.preferredSide = 0;
    }

    for (const angle of this.candidateAngles()) {
      const heading = this.rotate(toPlayerX, toPlayerZ, angle);

      if (!this.canWalk(from, heading.x, heading.z)) {
        continue;
      }

      if (angle === 0) {
        this.preferredSide = 0;
        this.sideCommitCountdown = 0;
      } else {
        this.preferredSide = angle > 0 ? 1 : -1;
        this.sideCommitCountdown = this.props.sideCommitSeconds;
      }

      return heading;
    }

    return null;
  }

  /** Straight ahead, then paired angles - committed side offered first. */
  private candidateAngles(): number[] {
    const side = this.preferredSide === 0 ? 1 : this.preferredSide;
    const angles: number[] = [0];

    for (const magnitude of STEER_ANGLES) {
      angles.push(magnitude * side);
      angles.push(-magnitude * side);
    }

    return angles;
  }

  private rotate(
    x: number,
    z: number,
    degrees: number,
  ): { x: number; z: number } {
    const radians = (degrees * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);

    return { x: x * cos + z * sin, z: -x * sin + z * cos };
  }

  private canWalk(from: hz.Vec3, dirX: number, dirZ: number): boolean {
    if (this.isWallAhead(from, dirX, dirZ)) {
      return false;
    }

    const aheadX = from.x + dirX * this.props.probeAhead;
    const aheadZ = from.z + dirZ * this.props.probeAhead;

    const groundY = this.groundBeneath(aheadX, aheadZ, from.y);

    // No reading is not a refusal - a gap in coverage should not freeze it.
    if (groundY == null) {
      return true;
    }

    const rise = this.restingY(groundY) - from.y;

    return rise <= this.props.maxStepUp && rise >= -this.props.maxStepDown;
  }

  /**
   * Short horizontal ray at chest height. The ground sampler reads a wall
   * standing on level floor as perfectly walkable, so this catches it.
   */
  private isWallAhead(from: hz.Vec3, dirX: number, dirZ: number): boolean {
    const gizmo = this.ownRaycast;
    if (!gizmo) {
      return false;
    }

    const hit = gizmo.raycast(
      new hz.Vec3(
        from.x + dirX * this.props.bodyRadius,
        from.y + this.props.wallProbeHeight,
        from.z + dirZ * this.props.bodyRadius,
      ),
      new hz.Vec3(dirX, 0, dirZ),
      {
        layerType: hz.LayerType.Both,
        maxDistance: this.props.wallProbeDistance,
      },
    );

    if (hit == null) {
      return false;
    }

    // Walking into the player is the goal, not an obstacle.
    if (hit.targetType === hz.RaycastTargetType.Player) {
      return false;
    }

    return !this.isAnyHitbox(hit);
  }

  // =====================================================================
  // helpers
  // =====================================================================

  /** Any enemy's hitbox, ours or another's - never ground, never a wall. */
  private isAnyHitbox(hit: hz.RaycastHit): boolean {
    if (hit.targetType !== hz.RaycastTargetType.Entity) {
      return false;
    }

    return (
      hit.target.tags.contains('head') || hit.target.tags.contains('body')
    );
  }

  private face(dirX: number, dirZ: number) {
    if (!this.props.faceThePlayer) {
      return;
    }

    const yaw =
      (Math.atan2(dirX, dirZ) * 180) / Math.PI +
      this.props.facingOffsetDegrees;

    this.entity.rotation.set(hz.Quaternion.fromEuler(new hz.Vec3(0, yaw, 0)));
  }

  private nearestPlayer(from: hz.Vec3): hz.Player | null {
    let nearest: hz.Player | null = null;
    let nearestDistanceSq = Number.MAX_VALUE;

    for (const player of this.world.getPlayers()) {
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

  private maxHealth(): number {
    return Math.max(1, this.props.maxHealth);
  }

  private nameOf(entity: hz.Entity | null): string {
    return entity ? entity.name.get() : 'none';
  }

  /** Throttled - per-frame movement logging drowns everything else. */
  private debug(message: string) {
    if (!this.props.debugMovement) {
      return;
    }

    const now = Date.now();
    if (now - this.lastDebugLogAt < 1000) {
      return;
    }

    this.lastDebugLogAt = now;
    console.log(`TargetHealth: ${message}`);
  }
}

hz.Component.register(TargetHealth);
