import * as hz from 'horizon/core';

/**
 * Sent by the gun to whichever entity owns a TargetHealth component.
 * Exported so SimpleGun can import it.
 */
export const damageEvent = new hz.LocalEvent<{
  amount: number;
  isHeadshot: boolean;
}>('damage');

/**
 * TargetHealth
 * ------------
 * Attach to the EMPTY root object of a target ("Target"), Motion: Animated.
 * Expects two collidable children tagged "head" and "body", plus a health
 * bar fill object.
 *
 * Movement walks straight at the nearest player, but probes the ground just
 * ahead with a downward raycast each step. That one probe does two jobs:
 *
 *   - follows terrain height instead of floating at a fixed Y
 *   - refuses to step where the ground jumps up or drops away, which is what
 *     a wall or a cliff looks like from the walker's point of view
 *
 * There is no pathfinding here, so he presses against walls rather than
 * routing around them. The NavMeshAgent version lives in git history at
 * commit da2395a.
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

    // --- ground probe ---------------------------------------------------
    // The Raycast gizmo. Reusing the gun's is fine.
    groundRaycast: { type: hz.PropTypes.Entity },
    // How far ahead to look. Must clear his own body, or the probe hits him.
    probeAhead: { type: hz.PropTypes.Number, default: 0.6 },
    // Start the downward ray this far above him, to catch ground above too.
    probeHeight: { type: hz.PropTypes.Number, default: 1.5 },
    // How far below to keep looking before giving up.
    maxDrop: { type: hz.PropTypes.Number, default: 5 },

    // Ground rising more than this is treated as a wall - refuse to move.
    maxStepUp: { type: hz.PropTypes.Number, default: 0.5 },
    // Ground falling more than this is treated as a cliff - refuse to move.
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
   * feet, so we preserve whatever offset it was placed with instead of
   * dropping the pivot onto the surface.
   */
  private footOffset: number | null = null;

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
    const target = this.nearestPlayerPosition(myPos);
    if (!target) {
      return;
    }

    // Horizontal only - we never want it climbing towards a player's head.
    const dx = target.x - myPos.x;
    const dz = target.z - myPos.z;
    const distance = Math.sqrt(dx * dx + dz * dz);
    if (distance < 0.001) {
      return;
    }

    const nx = dx / distance;
    const nz = dz / distance;

    if (this.props.faceThePlayer) {
      const yaw =
        (Math.atan2(nx, nz) * 180) / Math.PI + this.props.facingOffsetDegrees;
      this.entity.rotation.set(hz.Quaternion.fromEuler(new hz.Vec3(0, yaw, 0)));
    }

    if (distance <= this.props.stopDistance) {
      return;
    }

    // Never overshoot past stopDistance in a single frame.
    const step = Math.min(
      this.props.moveSpeed * deltaTime,
      distance - this.props.stopDistance,
    );

    const nextX = myPos.x + nx * step;
    const nextZ = myPos.z + nz * step;

    const groundY = this.probeGround(myPos, nx, nz);

    if (groundY == null) {
      // No ground reading: hold height rather than guess.
      this.entity.position.set(new hz.Vec3(nextX, myPos.y, nextZ));
      return;
    }

    if (this.footOffset == null) {
      this.footOffset = myPos.y - groundY;
      if (this.props.debugMovement) {
        console.log(
          `TargetHealth: calibrated footOffset ${this.footOffset.toFixed(2)}m`,
        );
      }
    }

    const desiredY = groundY + this.footOffset + this.props.groundOffset;
    const rise = desiredY - myPos.y;

    if (rise > this.props.maxStepUp) {
      if (this.props.debugMovement) {
        console.log(
          `TargetHealth: blocked - ground ahead rises ${rise.toFixed(2)}m`,
        );
      }
      return;
    }

    if (rise < -this.props.maxStepDown) {
      if (this.props.debugMovement) {
        console.log(
          `TargetHealth: blocked - ground ahead drops ${(-rise).toFixed(2)}m`,
        );
      }
      return;
    }

    this.entity.position.set(new hz.Vec3(nextX, desiredY, nextZ));
  }

  /**
   * Casts down onto the ground a short way ahead of the target.
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

    if (hit == null) {
      return null;
    }

    // Guard against probing our own body if probeAhead is set too small.
    if (hit.targetType === hz.RaycastTargetType.Entity) {
      const name = hit.target.name.get();
      if (
        hit.target.tags.contains('head') ||
        hit.target.tags.contains('body')
      ) {
        if (this.props.debugMovement) {
          console.log(
            `TargetHealth: ground probe hit own hitbox "${name}" - ` +
              'increase probeAhead.',
          );
        }
        return null;
      }
    }

    return hit.hitPoint.y;
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
