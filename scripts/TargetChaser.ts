import * as hz from 'horizon/core';

/**
 * TargetChaser
 * ------------
 * Attach to the SAME empty root as TargetHealth ("Target").
 *
 * Walks straight at the nearest player each frame. No pathfinding, so it will
 * happily walk into walls - fine for an open shooting range, and the point
 * where NavMesh becomes worth the setup cost.
 *
 * Height is pinned to wherever the target started, so it cannot drift up or
 * sink through the floor.
 */
class TargetChaser extends hz.Component<typeof TargetChaser> {
  static propsDefinition = {
    moveSpeed: { type: hz.PropTypes.Number, default: 1.5 }, // metres/second
    // How close it gets before it stops walking.
    stopDistance: { type: hz.PropTypes.Number, default: 2 },

    faceThePlayer: { type: hz.PropTypes.Boolean, default: true },
    // If the model ends up facing sideways, correct it here (try 90/180/270).
    facingOffsetDegrees: { type: hz.PropTypes.Number, default: 0 },

    chaseEnabled: { type: hz.PropTypes.Boolean, default: true },
  };

  private startY = 0;

  start() {
    this.startY = this.entity.position.get().y;

    this.connectLocalBroadcastEvent(
      hz.World.onUpdate,
      (data: { deltaTime: number }) => {
        this.tick(data.deltaTime);
      },
    );
  }

  private tick(deltaTime: number) {
    if (!this.props.chaseEnabled) {
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

hz.Component.register(TargetChaser);
