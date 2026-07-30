import * as hz from 'horizon/core';
import { NavMeshAgent } from 'horizon/navmesh';

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
 * Editor requirements:
 *   - Navigation Locomotion -> Enabled = ON
 *   - Navigation -> Include in Bakes = OFF on this entity and all children,
 *     or the target is baked into the navmesh as an obstacle
 *   - A baked navigation profile named to match navProfileName, whose volume
 *     actually covers the floor the target stands on
 *
 * Destinations are the player's raw position, matching Meta's own NPCMonster
 * sample. An earlier version ran them through NavMesh.getNearestPoint first,
 * which made the target chase a snapped point metres away whenever the player
 * stood on unbaked ground.
 *
 * The raycast steering version (terrain probes, no navmesh) is preserved in
 * git at commit e29c930 if this needs to be swapped back out.
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
    // Teleport back to the spawn point on respawn, as NPCMonster does.
    returnToStartOnRespawn: { type: hz.PropTypes.Boolean, default: true },

    // --- movement -------------------------------------------------------
    chaseEnabled: { type: hz.PropTypes.Boolean, default: true },
    // Must match a baked profile in Systems > Navigation.
    navProfileName: { type: hz.PropTypes.String, default: 'Zombie' },

    moveSpeed: { type: hz.PropTypes.Number, default: 1.5 }, // metres/second
    // The agent decelerates into this distance and stops.
    stopDistance: { type: hz.PropTypes.Number, default: 2 },
    // Reissuing the destination every frame is wasteful; interval in seconds.
    repathInterval: { type: hz.PropTypes.Number, default: 0.25 },

    /**
     * Degrees of misalignment tolerated before the agent will walk forward.
     * The default of 360 lets it slide off in any direction regardless of
     * facing; 90 is what Meta's NPCAgent uses, and it turns convincingly.
     */
    requiredForwardAlignment: { type: hz.PropTypes.Number, default: 90 },

    /**
     * Distance from this entity's pivot to the navmesh surface. At 0 the pivot
     * itself sits on the mesh, so a model whose pivot is at the waist sinks
     * into the floor. Raise until the feet land.
     */
    baseOffset: { type: hz.PropTypes.Number, default: 0 },

    /**
     * Follow the real collision surface rather than the navmesh, which is a
     * simplified approximation and drifts on slopes and curves. Costs a
     * per-frame check, so leave off unless height looks wrong on inclines.
     */
    usePhysicalSurfaceSnapping: { type: hz.PropTypes.Boolean, default: false },

    debugMovement: { type: hz.PropTypes.Boolean, default: false },
  };

  private health = 0;
  private isDead = false;

  // Cached full-health transform of the bar fill, captured once at start.
  private fillFullScale: hz.Vec3 | null = null;
  private fillFullPosition: hz.Vec3 | null = null;

  private agent: NavMeshAgent | null = null;
  private startLocation: hz.Vec3 | null = null;
  private repathCountdown = 0;

  start() {
    this.health = this.props.maxHealth;
    this.startLocation = this.entity.position.get().clone();

    const fill = this.props.healthBarFill;
    if (fill) {
      this.fillFullScale = fill.transform.localScale.get().clone();
      this.fillFullPosition = fill.transform.localPosition.get().clone();
    } else {
      console.warn('TargetHealth: healthBarFill prop is not set.');
    }

    this.setUpAgent();

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

  private setUpAgent() {
    // as() returns a wrapper whether or not Navigation Locomotion is enabled,
    // so this succeeding is not proof the editor side is set up.
    const agent = this.entity.as(NavMeshAgent);
    this.agent = agent;

    agent.profileName.set(this.props.navProfileName);
    agent.maxSpeed.set(this.props.moveSpeed);
    agent.stoppingDistance.set(this.props.stopDistance);
    agent.requiredForwardAlignment.set(this.props.requiredForwardAlignment);
    agent.baseOffset.set(this.props.baseOffset);
    agent.usePhysicalSurfaceSnapping.set(this.props.usePhysicalSurfaceSnapping);
    agent.isImmobile.set(false);
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

    // isImmobile plants the agent; clearing the destination drops its path.
    this.agent?.isImmobile.set(true);
    this.agent?.destination.set(null);

    this.async.setTimeout(() => {
      this.respawn();
    }, this.props.respawnDelay * 1000);
  }

  private respawn() {
    if (this.props.returnToStartOnRespawn && this.startLocation) {
      this.entity.position.set(this.startLocation);
    }

    this.health = this.props.maxHealth;
    this.isDead = false;
    this.agent?.isImmobile.set(false);
    this.refreshBar();

    console.log('TargetHealth: target reset to full health');
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
    const agent = this.agent;
    if (!agent || !this.props.chaseEnabled || this.isDead) {
      return;
    }

    this.repathCountdown -= deltaTime;
    if (this.repathCountdown > 0) {
      return;
    }
    this.repathCountdown = this.props.repathInterval;

    const player = this.nearestPlayerPosition(this.entity.position.get());
    if (!player) {
      return;
    }

    // Raw player position, no snapping. See the class comment.
    agent.destination.set(player);

    if (this.props.debugMovement) {
      console.log(
        `TargetHealth: speed ${agent.currentSpeed.get().toFixed(2)} ` +
          `remaining ${agent.remainingDistance.get().toFixed(2)} ` +
          `waypoints ${agent.path.get().length}`,
      );
    }
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
