import * as hz from 'horizon/core';

/**
 * Sent by the gun to whichever entity owns a TargetHealth component.
 * Exported so SimpleGun can import it.
 */
export const damageEvent = new hz.LocalEvent<{
  amount: number;
  isHeadshot: boolean;
}>('damage');

/** Whisker angles tried in order, smallest deviation first. */
const STEER_ANGLES = [30, 60, 90, 120, 150];

/**
 * TargetHealth
 * ------------
 * Attach to the EMPTY root object of a target ("Target"), Motion: Animated.
 * Expects two collidable children tagged "head" and "body", plus a health
 * bar fill object.
 *
 * Movement steers toward the nearest player using whisker probes. Each
 * candidate heading is tested with two raycasts:
 *
 *   - a downward probe just ahead, giving terrain height and rejecting steps
 *     that rise or fall too sharply
 *   - a short horizontal ray at chest height, catching walls the downward
 *     probe passes over
 *
 * The closest walkable heading to "straight at the player" wins, so a blocked
 * target slides along a wall until it clears. Once it has committed to going
 * around one side it sticks with that side briefly, otherwise it oscillates
 * left-right against a flat wall.
 *
 * This handles convex obstacles. It has no memory of where it has been, so a
 * concave dead-end can still trap it - that is where a NavMeshAgent earns its
 * setup cost. That implementation is preserved in git at commit da2395a.
 */
class TargetHealth extends hz.Component<typeof TargetHealth> {
  static propsDefinition = {
    // --- health ---------------------------------------------------------
    maxHealth: { type: hz.PropTypes.Number, default: 100 },

    healthBarFill: { type: hz.PropTypes.Entity },
    healthText: { type: hz.PropTypes.Entity },

    hitMarkerSfx: { type: hz.PropTypes.Entity },
    headshotKillSfx: { type: hz.PropTypes.Entity },

    respawnDelay: { type: hz.PropTypes.Number, default: 2 },

    // --- movement -------------------------------------------------------
    chaseEnabled: { type: hz.PropTypes.Boolean, default: true },
    moveSpeed: { type: hz.PropTypes.Number, default: 1.5 }, // metres/second
    stopDistance: { type: hz.PropTypes.Number, default: 2 },

    faceThePlayer: { type: hz.PropTypes.Boolean, default: true },
    // If the model faces sideways, correct it here (try 90/180/270).
    facingOffsetDegrees: { type: hz.PropTypes.Number, default: 0 },

    // Seconds to keep detouring the same way before reconsidering. Too low
    // and he jitters against a flat wall.
    sideCommitSeconds: { type: hz.PropTypes.Number, default: 1.2 },

    // --- probes ---------------------------------------------------------
    // The Raycast gizmo. Reusing the gun's is fine.
    groundRaycast: { type: hz.PropTypes.Entity },
    // How far ahead to look. Must clear his own body.
    probeAhead: { type: hz.PropTypes.Number, default: 0.6 },
    // Start the downward ray this far above him.
    probeHeight: { type: hz.PropTypes.Number, default: 1.5 },
    // How far below to keep looking before giving up.
    maxDrop: { type: hz.PropTypes.Number, default: 5 },

    // Horizontal wall ray starts this far out, to clear his own collider.
    bodyRadius: { type: hz.PropTypes.Number, default: 0.5 },
    // And reaches this much further.
    wallProbeDistance: { type: hz.PropTypes.Number, default: 0.8 },
    // Height above the root pivot to cast the wall ray from.
    wallProbeHeight: { type: hz.PropTypes.Number, default: 0.3 },

    // Ground rising more than this is a wall - refuse to step.
    maxStepUp: { type: hz.PropTypes.Number, default: 0.5 },
    // Ground falling more than this is a cliff - refuse to step.
    maxStepDown: { type: hz.PropTypes.Number, default: 1 },
    // Trim if he sinks into or floats above the ground.
    groundOffset: { type: hz.PropTypes.Number, default: 0 },

    debugMovement: { type: hz.PropTypes.Boolean, default: false },
  };

  private health = 0;
  private isDead = false;

  // Cached full-health transform of the bar fill, captured once at start.
  private fillFullScale: hz.Vec3 | null = null;
  private fillFullPosition: hz.Vec3 | null = null;

  /**
   * Height of this entity's origin above the ground, measured on the first
   * successful probe. The root's pivot may sit at the waist rather than the
   * feet, so we preserve whatever offset it was placed with.
   */
  private footOffset: number | null = null;

  /** +1 or -1 once committed to detouring around one side; 0 when going straight. */
  private preferredSide = 0;
  private sideCommitCountdown = 0;

  start() {
    this.health = this.props.maxHealth;

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
          'at a fixed height and clip through terrain.',
      );
    }

    this.connectLocalEvent(this.entity, damageEvent, (data) => {
      this.takeDamage(data.amount, data.isHeadshot);
    });

    this.connectLocalBroadcastEvent(
      hz.World.onUpdate,
      (data: { deltaTime: number }) => {
        this.chaseTick(data.deltaTime);
      },
    );

    this.refreshBar();
  }

  // ---------------------------------------------------------------- health

  private takeDamage(amount: number, isHeadshot: boolean) {
    if (this.isDead) {
      return;
    }

    // Hit marker fires on every connect, regardless of where it landed.
    this.props.hitMarkerSfx?.as(hz.AudioGizmo)?.play();

    this.health = Math.max(0, this.health - amount);

    console.log(
      `TargetHealth: ${isHeadshot ? 'head' : 'body'} for ${amount} -> ${this.health}/${this.props.maxHealth}`,
    );

    this.refreshBar();

    if (this.health <= 0) {
      this.die(isHeadshot);
    }
  }

  /** killedByHeadshot: was the FINAL shot a headshot? */
  private die(killedByHeadshot: boolean) {
    this.isDead = true;

    if (killedByHeadshot) {
      this.props.headshotKillSfx?.as(hz.AudioGizmo)?.play();
      console.log('TargetHealth: HEADSHOT KILL');
    } else {
      console.log('TargetHealth: TARGET DOWN');
    }

    this.async.setTimeout(() => {
      this.health = this.props.maxHealth;
      this.isDead = false;
      this.refreshBar();
      console.log('TargetHealth: target reset to full health');
    }, this.props.respawnDelay * 1000);
  }

  private refreshBar() {
    const fraction = this.health / this.props.maxHealth;

    const fill = this.props.healthBarFill;
    if (fill && this.fillFullScale && this.fillFullPosition) {
      // Shrink along local X.
      const scale = this.fillFullScale.clone();
      scale.x = this.fillFullScale.x * fraction;
      fill.transform.localScale.set(scale);

      // Slide left by half of what we removed, so the bar drains from one
      // end instead of shrinking towards its own centre.
      const position = this.fillFullPosition.clone();
      position.x =
        this.fillFullPosition.x - (this.fillFullScale.x * (1 - fraction)) / 2;
      fill.transform.localPosition.set(position);
    }

    const text = this.props.healthText;
    if (text) {
      text.as(hz.TextGizmo)?.text.set(`${this.health} / ${this.props.maxHealth}`);
    }
  }

  // -------------------------------------------------------------- movement

  private chaseTick(deltaTime: number) {
    if (!this.props.chaseEnabled || this.isDead) {
      return;
    }

    const myPos = this.entity.position.get();
    const player = this.nearestPlayerPosition(myPos);
    if (!player) {
      return;
    }

    // Horizontal only - we never want it climbing towards a player's head.
    const dx = player.x - myPos.x;
    const dz = player.z - myPos.z;
    const distance = Math.sqrt(dx * dx + dz * dz);
    if (distance < 0.001) {
      return;
    }

    const toPlayerX = dx / distance;
    const toPlayerZ = dz / distance;

    if (distance <= this.props.stopDistance) {
      // Arrived: face the player and stand still.
      this.faceDirection(toPlayerX, toPlayerZ);
      this.preferredSide = 0;
      this.sideCommitCountdown = 0;
      return;
    }

    const heading = this.chooseHeading(myPos, toPlayerX, toPlayerZ, deltaTime);

    if (!heading) {
      // Boxed in on every whisker. Keep facing the player so he still reads
      // as hunting rather than idle.
      this.faceDirection(toPlayerX, toPlayerZ);
      if (this.props.debugMovement) {
        console.log('TargetHealth: no walkable heading - fully blocked.');
      }
      return;
    }

    // Face where he walks, not where the player is, or detours look wrong.
    this.faceDirection(heading.x, heading.z);

    const step = Math.min(
      this.props.moveSpeed * deltaTime,
      distance - this.props.stopDistance,
    );

    const nextX = myPos.x + heading.x * step;
    const nextZ = myPos.z + heading.z * step;

    if (heading.groundY == null) {
      // No ground reading: hold height rather than guess.
      this.entity.position.set(new hz.Vec3(nextX, myPos.y, nextZ));
      return;
    }

    if (this.footOffset == null) {
      this.footOffset = myPos.y - heading.groundY;
      if (this.props.debugMovement) {
        console.log(
          `TargetHealth: calibrated footOffset ${this.footOffset.toFixed(2)}m`,
        );
      }
    }

    const desiredY =
      heading.groundY + this.footOffset + this.props.groundOffset;

    this.entity.position.set(new hz.Vec3(nextX, desiredY, nextZ));
  }

  /**
   * Tries the direct heading first, then fans out to either side, returning
   * the first walkable one.
   */
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
        // Direct route is clear again; drop any detour commitment.
        this.preferredSide = 0;
        this.sideCommitCountdown = 0;
      } else {
        this.preferredSide = angle > 0 ? 1 : -1;
        this.sideCommitCountdown = this.props.sideCommitSeconds;

        if (this.props.debugMovement) {
          console.log(`TargetHealth: detouring ${angle} degrees off-target.`);
        }
      }

      return { x: heading.x, z: heading.z, groundY: probe.groundY };
    }

    return null;
  }

  /**
   * Straight ahead first, then paired angles outward. The committed side is
   * offered before its mirror so he keeps rounding an obstacle the same way.
   */
  private buildAngles(): number[] {
    const side = this.preferredSide === 0 ? 1 : this.preferredSide;
    const angles: number[] = [0];

    for (const magnitude of STEER_ANGLES) {
      angles.push(magnitude * side);
      angles.push(-magnitude * side);
    }

    return angles;
  }

  /** Rotates a horizontal unit heading about the Y axis. */
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

    // No ground reading at all - let him walk and hold height. Refusing here
    // would freeze him anywhere the probe cannot reach.
    if (groundY == null) {
      return { walkable: true, groundY: null };
    }

    // Until calibrated we have no baseline to compare a rise against.
    if (this.footOffset == null) {
      return { walkable: true, groundY };
    }

    const desiredY = groundY + this.footOffset + this.props.groundOffset;
    const rise = desiredY - from.y;

    if (rise > this.props.maxStepUp || rise < -this.props.maxStepDown) {
      return { walkable: false, groundY };
    }

    return { walkable: true, groundY };
  }

  /**
   * Casts down onto the ground a short way ahead.
   *
   * The probe starts ahead of and above him so it clears his own colliders;
   * a ray starting inside his body would just hit his own hitboxes.
   *
   * @returns the ground height, or null if nothing was found.
   */
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

  /**
   * Short horizontal ray at chest height. Catches walls standing on ground
   * level, which the downward probe reads as perfectly walkable floor.
   */
  private isWallAhead(from: hz.Vec3, dirX: number, dirZ: number): boolean {
    const gizmo = this.props.groundRaycast?.as(hz.RaycastGizmo);
    if (!gizmo) {
      return false;
    }

    // Start outside his own collider, or every ray hits himself.
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

    // Walking into the player is not an obstacle, it is the goal.
    if (hit.targetType === hz.RaycastTargetType.Player) {
      return false;
    }

    return !this.isOwnHitbox(hit);
  }

  /** True when a ray came back with one of our own tagged hitboxes. */
  private isOwnHitbox(hit: hz.RaycastHit): boolean {
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
      (Math.atan2(dirX, dirZ) * 180) / Math.PI + this.props.facingOffsetDegrees;
    this.entity.rotation.set(hz.Quaternion.fromEuler(new hz.Vec3(0, yaw, 0)));
  }

  private nearestPlayerPosition(from: hz.Vec3): hz.Vec3 | null {
    const players = this.world.getPlayers();

    let nearest: hz.Vec3 | null = null;
    let nearestDistanceSq = Number.MAX_VALUE;

    for (const player of players) {
      const position = player.position.get();
      const dx = position.x - from.x;
      const dz = position.z - from.z;
      const distanceSq = dx * dx + dz * dz;

      if (distanceSq < nearestDistanceSq) {
        nearestDistanceSq = distanceSq;
        nearest = position;
      }
    }

    return nearest;
  }
}

hz.Component.register(TargetHealth);
