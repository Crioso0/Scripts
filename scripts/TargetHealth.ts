import * as hz from 'horizon/core';
import NavMeshManager, { NavMesh, NavMeshAgent } from 'horizon/navmesh';

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
 * Editor requirements for pathfinding:
 *   - Navigation Locomotion -> Enabled = ON
 *   - Navigation -> Include in Bakes = OFF  (otherwise the agent is baked
 *     into the navmesh as an obstacle and blocks its own path)
 *   - A baked navigation profile whose name matches navProfileName
 *
 * Movement has two modes:
 *   navmesh - hands a destination to a NavMeshAgent, which follows terrain
 *             and paths around obstacles.
 *   manual  - straight-line walk with height pinned to startY. Fallback for
 *             when the navmesh is unavailable.
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
    // Must match a baked profile in Systems > Navigation.
    navProfileName: { type: hz.PropTypes.String, default: 'Zombie' },

    moveSpeed: { type: hz.PropTypes.Number, default: 1.5 },
    // How close it gets before it stops. The agent decelerates into this.
    stopDistance: { type: hz.PropTypes.Number, default: 2 },
    // Repathing every frame is wasteful; interval in seconds.
    repathInterval: { type: hz.PropTypes.Number, default: 0.25 },
    // How far to search for a navmesh point near an off-mesh player.
    snapRange: { type: hz.PropTypes.Number, default: 8 },

    // Manual-mode only. The agent handles its own facing.
    faceThePlayer: { type: hz.PropTypes.Boolean, default: true },
    facingOffsetDegrees: { type: hz.PropTypes.Number, default: 0 },

    debugMovement: { type: hz.PropTypes.Boolean, default: false },
  };

  private health = 0;
  private isDead = false;

  // Cached full-health transform of the bar fill, captured once at start.
  private fillFullScale: hz.Vec3 | null = null;
  private fillFullPosition: hz.Vec3 | null = null;

  // Manual mode pins height here so the target cannot drift or sink.
  private startY = 0;

  private agent: NavMeshAgent | null = null;
  private navMesh: NavMesh | null = null;
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

    if (this.props.useNavMesh) {
      this.setUpAgent();
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

  // -------------------------------------------------------------- navmesh

  private setUpAgent() {
    // Note: as() returns a wrapper whether or not Navigation Locomotion is
    // enabled, so this succeeding is not proof the editor side is set up.
    this.agent = this.entity.as(NavMeshAgent);

    const profileName = this.props.navProfileName;

    this.agent.profileName.set(profileName);
    this.agent.isImmobile.set(false);
    this.agent.maxSpeed.set(this.props.moveSpeed);
    this.agent.stoppingDistance.set(this.props.stopDistance);

    // The mesh reference is only needed for getNearestPoint, which is what
    // lets us chase a player standing on unbaked ground.
    NavMeshManager.getInstance(this.world)
      .getByName(profileName)
      .then((mesh) => {
        this.navMesh = mesh;
        if (mesh) {
          console.log(`TargetHealth: navmesh "${profileName}" ready.`);
        } else {
          console.warn(
            `TargetHealth: no navigation profile named "${profileName}". ` +
              'Check the name in Systems > Navigation matches exactly.',
          );
        }
      });
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

    // Clearing the destination is the documented way to halt an agent.
    this.agent?.destination.set(null);

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

  private navMeshTick(deltaTime: number) {
    this.repathCountdown -= deltaTime;
    if (this.repathCountdown > 0) {
      return;
    }
    this.repathCountdown = this.props.repathInterval;

    const agent = this.agent;
    if (!agent) {
      return;
    }

    const playerPosition = this.nearestPlayerPosition(this.entity.position.get());
    if (!playerPosition) {
      return;
    }

    // A destination off the navigable surface yields no path at all, so snap
    // it onto the mesh first. Players stand on decks, boxes, and stairs that
    // were never baked.
    let destination: hz.Vec3 | null = playerPosition;
    if (this.navMesh) {
      destination = this.navMesh.getNearestPoint(
        playerPosition,
        this.props.snapRange,
      );
    }

    if (!destination) {
      if (this.props.debugMovement) {
        console.log(
          'TargetHealth: no navmesh point within snapRange of the player.',
        );
      }
      return;
    }

    agent.destination.set(destination);

    if (this.props.debugMovement) {
      console.log(
        `TargetHealth: speed ${agent.currentSpeed.get().toFixed(2)} ` +
          `remaining ${agent.remainingDistance.get().toFixed(2)} ` +
          `waypoints ${agent.path.get().length}`,
      );
    }
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
