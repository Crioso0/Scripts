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
 * Attach to the EMPTY root object of a target ("Target"), which must be set
 * to Motion: Animated. Expects two collidable children tagged "head" and
 * "body", plus a health bar fill object.
 *
 * Health and chasing live in one component because this editor build only
 * allows a single script per entity. That also makes death stop the walk
 * without needing an event between scripts.
 */
class TargetHealth extends hz.Component<typeof TargetHealth> {
  static propsDefinition = {
    // --- health ---------------------------------------------------------
    maxHealth: { type: hz.PropTypes.Number, default: 100 },

    // Coloured cube that shrinks. Sibling of the bar background, both
    // parented to an unscaled empty so the local maths stays clean.
    healthBarFill: { type: hz.PropTypes.Entity },
    // Optional Text gizmo showing "80 / 100".
    healthText: { type: hz.PropTypes.Entity },

    // Plays on EVERY successful hit, head or body.
    hitMarkerSfx: { type: hz.PropTypes.Entity },
    // Plays only when a headshot is the killing blow.
    headshotKillSfx: { type: hz.PropTypes.Entity },

    // Seconds after death before the target resets to full health.
    respawnDelay: { type: hz.PropTypes.Number, default: 2 },

    // --- chasing --------------------------------------------------------
    chaseEnabled: { type: hz.PropTypes.Boolean, default: true },
    moveSpeed: { type: hz.PropTypes.Number, default: 1.5 }, // metres/second
    // How close it gets before it stops walking.
    stopDistance: { type: hz.PropTypes.Number, default: 2 },

    faceThePlayer: { type: hz.PropTypes.Boolean, default: true },
    // If the model ends up facing sideways, correct it here (try 90/180/270).
    facingOffsetDegrees: { type: hz.PropTypes.Number, default: 0 },
  };

  private health = 0;
  private isDead = false;

  // Cached full-health transform of the bar fill, captured once at start.
  private fillFullScale: hz.Vec3 | null = null;
  private fillFullPosition: hz.Vec3 | null = null;

  // Height is pinned here so the target cannot drift up or sink.
  private startY = 0;

  start() {
    this.health = this.props.maxHealth;
    this.startY = this.entity.position.get().y;

    const fill = this.props.healthBarFill;
    if (fill) {
      this.fillFullScale = fill.transform.localScale.get().clone();
      this.fillFullPosition = fill.transform.localPosition.get().clone();
    } else {
      console.warn('TargetHealth: healthBarFill prop is not set.');
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

  // --------------------------------------------------------------- chasing

  private chaseTick(deltaTime: number) {
    // Dead targets stand still until they respawn.
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

    this.entity.position.set(
      new hz.Vec3(myPos.x + nx * step, this.startY, myPos.z + nz * step),
    );
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
