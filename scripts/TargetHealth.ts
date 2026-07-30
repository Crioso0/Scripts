import * as hz from 'horizon/core';
import { playerDamageEvent } from 'PlayerHealth';
import { awardMoneyEvent, damageEvent } from 'GameEvents';

/** Whisker angles tried in order, smallest deviation first. */
const STEER_ANGLES = [30, 60, 90, 120, 150];

/**
 * TargetHealth
 * ------------
 * Enemy health, rewards, locomotion and melee attack.
 *
 * damageEvent comes from GameEvents rather than being declared here. Horizon
 * matches local events by object identity, not by name, so a second
 * `new LocalEvent('damage')` in this file would be a different event from the
 * one SimpleGun sends and no damage would ever arrive.
 */
class TargetHealth extends hz.Component<typeof TargetHealth> {
  static propsDefinition = {
    maxHealth: { type: hz.PropTypes.Number, default: 100 },

    healthBarFill: { type: hz.PropTypes.Entity },
    healthText: { type: hz.PropTypes.Entity },
    healthBarRoot: { type: hz.PropTypes.Entity },

    hitMarkerSfx: { type: hz.PropTypes.Entity },
    headshotKillSfx: { type: hz.PropTypes.Entity },
    deathSfx: { type: hz.PropTypes.Entity },

    enemyVisual: { type: hz.PropTypes.Entity },
    bodyHitbox: { type: hz.PropTypes.Entity },
    headHitbox: { type: hz.PropTypes.Entity },

    hideOnDeath: { type: hz.PropTypes.Boolean, default: true },
    respawnDelay: { type: hz.PropTypes.Number, default: 3 },

    playerHealthManager: { type: hz.PropTypes.Entity },
    attackSfx: { type: hz.PropTypes.Entity },

    attackDamage: { type: hz.PropTypes.Number, default: 20 },
    attackRange: { type: hz.PropTypes.Number, default: 2.1 },
    attackCooldown: { type: hz.PropTypes.Number, default: 1 },

    // --- rewards --------------------------------------------------------
    // Call of Duty Zombies pays per hit, then a bonus on the kill.
    moneyPerHit: { type: hz.PropTypes.Number, default: 10 },
    moneyPerKill: { type: hz.PropTypes.Number, default: 50 },
    moneyPerHeadshotKill: { type: hz.PropTypes.Number, default: 100 },

    chaseEnabled: { type: hz.PropTypes.Boolean, default: true },
    moveSpeed: { type: hz.PropTypes.Number, default: 1.5 },
    stopDistance: { type: hz.PropTypes.Number, default: 1.8 },

    faceThePlayer: { type: hz.PropTypes.Boolean, default: true },
    facingOffsetDegrees: { type: hz.PropTypes.Number, default: 0 },

    sideCommitSeconds: { type: hz.PropTypes.Number, default: 1.2 },

    groundRaycast: { type: hz.PropTypes.Entity },
    probeAhead: { type: hz.PropTypes.Number, default: 0.6 },
    probeHeight: { type: hz.PropTypes.Number, default: 1.5 },
    maxDrop: { type: hz.PropTypes.Number, default: 5 },

    bodyRadius: { type: hz.PropTypes.Number, default: 0.5 },
    wallProbeDistance: { type: hz.PropTypes.Number, default: 0.8 },
    wallProbeHeight: { type: hz.PropTypes.Number, default: 0.3 },

    maxStepUp: { type: hz.PropTypes.Number, default: 0.5 },
    maxStepDown: { type: hz.PropTypes.Number, default: 1 },
    groundOffset: { type: hz.PropTypes.Number, default: 0 },

    debugMovement: { type: hz.PropTypes.Boolean, default: false },
  };

  private health = 0;
  private isDead = false;
  private lastAttackTime = 0;

  private fillFullScale: hz.Vec3 | null = null;
  private fillFullPosition: hz.Vec3 | null = null;

  private spawnPosition: hz.Vec3 | null = null;
  private spawnRotation: hz.Quaternion | null = null;

  private footOffset: number | null = null;

  private preferredSide = 0;
  private sideCommitCountdown = 0;

  preStart() {
    this.connectLocalEvent(this.entity, damageEvent, (data) => {
      this.takeDamage(data.attacker, data.amount, data.isHeadshot);
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

    const fill = this.props.healthBarFill;
    if (fill) {
      this.fillFullScale = fill.transform.localScale.get().clone();
      this.fillFullPosition = fill.transform.localPosition.get().clone();
    } else {
      console.warn('TargetHealth: healthBarFill prop is not set.');
    }

    if (!this.props.groundRaycast) {
      console.warn(
        'TargetHealth: groundRaycast prop is not set. The target will walk ' +
          'at a fixed height and may clip through terrain.',
      );
    }

    if (!this.props.playerHealthManager) {
      console.warn(
        'TargetHealth: playerHealthManager is not assigned. ' +
          'The enemy cannot damage the player.',
      );
    }

    this.setEnemyAlive(true);
    this.refreshBar();

    console.log('TargetHealth: enemy health and attack system ready');
  }

  // ---------------------------------------------------------------- health

  private takeDamage(
    attacker: hz.Player,
    amount: number,
    isHeadshot: boolean,
  ) {
    if (this.isDead) {
      return;
    }

    this.props.hitMarkerSfx?.as(hz.AudioGizmo)?.play();

    this.health = Math.max(0, this.health - Math.max(0, amount));

    console.log(
      `TargetHealth: ${isHeadshot ? 'head' : 'body'} for ${amount} -> ` +
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

    this.async.setTimeout(() => {
      this.health = Math.max(1, this.props.maxHealth);
      this.footOffset = null;
      this.preferredSide = 0;
      this.sideCommitCountdown = 0;
      this.lastAttackTime = 0;

      if (this.spawnPosition) {
        this.entity.position.set(this.spawnPosition);
      }

      if (this.spawnRotation) {
        this.entity.rotation.set(this.spawnRotation);
      }

      this.isDead = false;
      this.setEnemyAlive(true);
      this.refreshBar();

      console.log('TargetHealth: target respawned with full health');
    }, this.props.respawnDelay * 1000);
  }

  /** Broadcast so ScoreHud - or anything else keeping score - can react. */
  private pay(player: hz.Player, amount: number, reason: string) {
    if (amount <= 0) {
      return;
    }

    this.sendLocalBroadcastEvent(awardMoneyEvent, { player, amount, reason });
  }

  private setEnemyAlive(alive: boolean) {
    if (this.props.hideOnDeath) {
      this.props.enemyVisual?.visible.set(alive);
    }

    this.props.healthBarRoot?.visible.set(alive);

    this.props.bodyHitbox?.collidable.set(alive);
    this.props.headHitbox?.collidable.set(alive);
  }

  private refreshBar() {
    const maxHealth = Math.max(1, this.props.maxHealth);
    const fraction = Math.max(0, Math.min(1, this.health / maxHealth));

    const fill = this.props.healthBarFill;

    if (fill && this.fillFullScale && this.fillFullPosition) {
      const scale = this.fillFullScale.clone();
      scale.x = this.fillFullScale.x * fraction;
      fill.transform.localScale.set(scale);

      const position = this.fillFullPosition.clone();
      position.x =
        this.fillFullPosition.x -
        (this.fillFullScale.x * (1 - fraction)) / 2;

      fill.transform.localPosition.set(position);
    }

    const text = this.props.healthText;

    if (text) {
      text
        .as(hz.TextGizmo)
        ?.text.set(`${this.health} / ${maxHealth}`);
    }
  }

  // -------------------------------------------------------------- movement

  private chaseTick(deltaTime: number) {
    if (!this.props.chaseEnabled || this.isDead) {
      return;
    }

    const myPos = this.entity.position.get();
    const player = this.nearestPlayer(myPos);

    if (!player) {
      return;
    }

    const playerPos = player.position.get();

    const dx = playerPos.x - myPos.x;
    const dz = playerPos.z - myPos.z;
    const distance = Math.sqrt(dx * dx + dz * dz);

    if (distance < 0.001) {
      return;
    }

    const toPlayerX = dx / distance;
    const toPlayerZ = dz / distance;

    this.tryAttack(player, distance);

    if (distance <= this.props.stopDistance) {
      this.faceDirection(toPlayerX, toPlayerZ);
      this.preferredSide = 0;
      this.sideCommitCountdown = 0;
      return;
    }

    const heading = this.chooseHeading(
      myPos,
      toPlayerX,
      toPlayerZ,
      deltaTime,
    );

    if (!heading) {
      this.faceDirection(toPlayerX, toPlayerZ);

      if (this.props.debugMovement) {
        console.log('TargetHealth: no walkable heading - fully blocked.');
      }

      return;
    }

    this.faceDirection(heading.x, heading.z);

    const step = Math.min(
      this.props.moveSpeed * deltaTime,
      distance - this.props.stopDistance,
    );

    const nextX = myPos.x + heading.x * step;
    const nextZ = myPos.z + heading.z * step;

    if (heading.groundY == null) {
      this.entity.position.set(new hz.Vec3(nextX, myPos.y, nextZ));
      return;
    }

    if (this.footOffset == null) {
      this.footOffset = myPos.y - heading.groundY;

      if (this.props.debugMovement) {
        console.log(
          `TargetHealth: calibrated footOffset ` +
            `${this.footOffset.toFixed(2)}m`,
        );
      }
    }

    const desiredY =
      heading.groundY + this.footOffset + this.props.groundOffset;

    this.entity.position.set(new hz.Vec3(nextX, desiredY, nextZ));
  }

  private tryAttack(player: hz.Player, distance: number) {
    if (distance > this.props.attackRange) {
      return;
    }

    const now = Date.now();

    if (now - this.lastAttackTime < this.props.attackCooldown * 1000) {
      return;
    }

    this.lastAttackTime = now;

    const manager = this.props.playerHealthManager;

    if (!manager) {
      console.warn(
        'TargetHealth: enemy tried to attack, but ' +
          'playerHealthManager is not assigned.',
      );
      return;
    }

    this.props.attackSfx?.as(hz.AudioGizmo)?.play();

    this.sendLocalEvent(manager, playerDamageEvent, {
      player,
      amount: this.props.attackDamage,
    });

    console.log(
      `TargetHealth: attacked "${player.name.get()}" for ` +
        `${this.props.attackDamage} damage`,
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

        if (this.props.debugMovement) {
          console.log(
            `TargetHealth: detouring ${angle} degrees off-target.`,
          );
        }
      }

      return {
        x: heading.x,
        z: heading.z,
        groundY: probe.groundY,
      };
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
      return {
        walkable: false,
        groundY: null,
      };
    }

    const groundY = this.probeGround(from, dirX, dirZ);

    if (groundY == null) {
      return {
        walkable: true,
        groundY: null,
      };
    }

    if (this.footOffset == null) {
      return {
        walkable: true,
        groundY,
      };
    }

    const desiredY =
      groundY + this.footOffset + this.props.groundOffset;

    const rise = desiredY - from.y;

    if (
      rise > this.props.maxStepUp ||
      rise < -this.props.maxStepDown
    ) {
      return {
        walkable: false,
        groundY,
      };
    }

    return {
      walkable: true,
      groundY,
    };
  }

  private probeGround(
    from: hz.Vec3,
    dirX: number,
    dirZ: number,
  ): number | null {
    const gizmo = this.props.groundRaycast?.as(hz.RaycastGizmo);

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

    if (hit == null || this.isOwnHitbox(hit)) {
      return null;
    }

    return hit.hitPoint.y;
  }

  private isWallAhead(
    from: hz.Vec3,
    dirX: number,
    dirZ: number,
  ): boolean {
    const gizmo = this.props.groundRaycast?.as(hz.RaycastGizmo);

    if (!gizmo) {
      return false;
    }

    const origin = new hz.Vec3(
      from.x + dirX * this.props.bodyRadius,
      from.y + this.props.wallProbeHeight,
      from.z + dirZ * this.props.bodyRadius,
    );

    const hit = gizmo.raycast(
      origin,
      new hz.Vec3(dirX, 0, dirZ),
      {
        layerType: hz.LayerType.Both,
        maxDistance: this.props.wallProbeDistance,
      },
    );

    if (hit == null) {
      return false;
    }

    if (hit.targetType === hz.RaycastTargetType.Player) {
      return false;
    }

    return !this.isOwnHitbox(hit);
  }

  private isOwnHitbox(hit: hz.RaycastHit): boolean {
    if (hit.targetType !== hz.RaycastTargetType.Entity) {
      return false;
    }

    return (
      hit.target.tags.contains('head') ||
      hit.target.tags.contains('body')
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
