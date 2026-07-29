import * as hz from 'horizon/core';
import * as nav from 'horizon/navmesh';

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
 * Movement has two modes:
 *   navmesh  - hands a destination to a NavMeshAgent, which follows terrain
 *              and paths around obstacles. Requires a baked navigation
 *              profile and Navigation Locomotion enabled on this entity.
 *   manual   - the old straight-line walk with height pinned to startY.
 *              Kept as a fallback for when there is no agent.
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
    // Untick to force the old straight-line movement.
    useNavMesh: { type: hz.PropTypes.Boolean, default: true },

    // How close it gets before it stops walking.
    stopDistance: { type: hz.PropTypes.Number, default: 2 },
    // Repathing every frame is wasteful; this is the interval in seconds.
    repathInterval: { type: hz.PropTypes.Number, default: 0.25 },

    // Manual-mode only. The agent handles its own speed and facing.
    moveSpeed: { type: hz.PropTypes.Number, default: 1.5 },
    faceThePlayer: { type: hz.PropTypes.Boolean, default: true },
    facingOffsetDegrees: { type: hz.PropTypes.Number, default: 0 },
  };

  private health = 0;
  private isDead = false;

  // Cached full-health transform of the bar fill, captured once at start.
  private fillFullScale: hz.Vec3 | null = null;
  private fillFullPosition: hz.Vec3 | null = null;

  // Manual mode pins height here so the target cannot drift or sink.
  private startY = 0;

  private agent: nav.NavMeshAgent | null = null;
  private repathCountdown = 0;

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

    this.agent = this.entity.as(nav.NavMeshAgent);
    if (this.agent) {
      console.log('TargetHealth: NavMeshAgent found - using pathfinding.');
    } else {
      console.warn(
        'TargetHealth: no NavMeshAgent on this entity. Falling back to ' +
          'straight-line movement. Check Navigation Locomotion is enabled.',
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

    this.stopMoving();

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

    if (this.props.useNavMesh && this.agent) {
      this.navMeshTick(deltaTime);
    } else {
      this.manualTick(deltaTime);
    }
  }

  /** Parking the destination on our own position is how an agent is told to stop. */
  private stopMoving() {
    this.agent?.destination.set(this.entity.position.get());
  }

  private navMeshTick(deltaTime: number) {
    this.repathCountdown -= deltaTime;
    if (this.repathCountdown > 0) {
      return;
    }
    this.repathCountdown = this.props.repathInterval;

    const myPos = this.entity.position.get();
    const target = this.nearestPlayerPosition(myPos);
    if (!target) {
      return;
    }

    const dx = target.x - myPos.x;
    const dz = target.z - myPos.z;
    const distance = Math.sqrt(dx * dx + dz * dz);

    if (distance <= this.props.stopDistance) {
      this.stopMoving();
      return;
    }

    this.agent?.destination.set(target);
  }

  private manualTick(deltaTime: number) {
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
