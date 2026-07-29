import * as hz from 'horizon/core';

/**
 * SimpleGun
 * ---------
 * Attach to the grabbable gun root ("My Try").
 *
 * Behaviour:
 *   grab gun -> press primary action (VR index trigger / desktop left click)
 *   -> play gunshot audio
 *   -> raycast forward from Muzzle_point
 *   -> if the ray hit the Target entity, flash it red and log a message
 *   -> ignore further presses until fireCooldown seconds have passed
 */
class SimpleGun extends hz.Component<typeof SimpleGun> {
  static propsDefinition = {
    // Empty object at the barrel tip. Its FORWARD (+Z) axis is the shot direction.
    muzzle: { type: hz.PropTypes.Entity },
    // The Audio Graph / sound object parented to the gun.
    gunshotSfx: { type: hz.PropTypes.Entity },
    // A Raycast Gizmo placed anywhere in the world. Does the actual line trace.
    raycastGizmo: { type: hz.PropTypes.Entity },
    // The object we want to react when hit.
    target: { type: hz.PropTypes.Entity },

    fireCooldown: { type: hz.PropTypes.Number, default: 0.35 }, // seconds between shots
    maxRange: { type: hz.PropTypes.Number, default: 100 },      // metres
    flashDuration: { type: hz.PropTypes.Number, default: 0.3 }, // seconds target stays red
  };

  private holder: hz.Player | null = null;
  private lastFireTime = 0;
  private targetOriginalColor: hz.Color | null = null;
  private flashTimeoutId: number | null = null;

  start() {
    // Remember who is holding the gun (not strictly needed yet, useful later).
    this.connectCodeBlockEvent(
      this.entity,
      hz.CodeBlockEvents.OnGrabStart,
      (_isRightHand: boolean, player: hz.Player) => {
        this.holder = player;
      },
    );

    this.connectCodeBlockEvent(
      this.entity,
      hz.CodeBlockEvents.OnGrabEnd,
      (_player: hz.Player) => {
        this.holder = null;
      },
    );

    // Primary action while holding: VR index trigger, desktop left mouse button.
    this.connectCodeBlockEvent(
      this.entity,
      hz.CodeBlockEvents.OnIndexTriggerDown,
      (player: hz.Player) => {
        this.tryFire(player);
      },
    );
  }

  private tryFire(player: hz.Player) {
    // --- fire rate limit -------------------------------------------------
    const now = Date.now();
    if (now - this.lastFireTime < this.props.fireCooldown * 1000) {
      return;
    }
    this.lastFireTime = now;

    // --- audio -----------------------------------------------------------
    const sfx = this.props.gunshotSfx?.as(hz.AudioGizmo);
    if (sfx) {
      sfx.play();
    } else {
      console.warn('SimpleGun: gunshotSfx prop is not set (or is not an audio object).');
    }

    // --- raycast ---------------------------------------------------------
    const muzzle = this.props.muzzle;
    const gizmo = this.props.raycastGizmo?.as(hz.RaycastGizmo);
    if (!muzzle || !gizmo) {
      console.warn('SimpleGun: muzzle and/or raycastGizmo prop is not set.');
      return;
    }

    const origin = muzzle.position.get();
    const direction = muzzle.forward.get();
    console.log(
      `SimpleGun: shot by ${player.name.get()} from ${origin.toString()} dir ${direction.toString()}`,
    );

    const hit = gizmo.raycast(origin, direction, {
      layerType: hz.LayerType.Both,
      maxDistance: this.props.maxRange,
    });

    if (hit == null) {
      console.log('SimpleGun: miss (nothing in range).');
      return;
    }

    if (hit.targetType !== hz.RaycastTargetType.Entity) {
      console.log(`SimpleGun: hit something that is not an entity (${hit.targetType}).`);
      return;
    }

    const target = this.props.target;
    if (target && hit.target.id === target.id) {
      console.log(`SimpleGun: HIT TARGET at distance ${hit.distance.toFixed(2)}m`);
      this.flashTarget(target);
    } else {
      console.log(`SimpleGun: hit ${hit.target.name.get()} (not the target).`);
    }
  }

  private flashTarget(target: hz.Entity) {
    // Cache the original colour the first time so repeated hits restore correctly.
    if (this.targetOriginalColor == null) {
      this.targetOriginalColor = target.color.get();
    }
    if (this.flashTimeoutId != null) {
      this.async.clearTimeout(this.flashTimeoutId);
    }

    target.color.set(new hz.Color(1, 0, 0));

    this.flashTimeoutId = this.async.setTimeout(() => {
      if (this.targetOriginalColor != null) {
        target.color.set(this.targetOriginalColor);
      }
      this.flashTimeoutId = null;
    }, this.props.flashDuration * 1000);
  }
}

hz.Component.register(SimpleGun);
