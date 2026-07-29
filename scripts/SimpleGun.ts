import * as hz from 'horizon/core';
import { damageEvent } from 'TargetHealth';

/**
 * SimpleGun
 * ---------
 * Attach to the grabbable gun root ("My Try").
 *
 * Fires a ray from Muzzle_point on the primary action, then looks at the
 * tag on whatever it hit:
 *   "head" -> damagePerShot * headshotMultiplier
 *   "body" -> damagePerShot
 * and sends a damage event to that hitbox's parent.
 */
class SimpleGun extends hz.Component<typeof SimpleGun> {
  static propsDefinition = {
    muzzle: { type: hz.PropTypes.Entity },
    gunshotSfx: { type: hz.PropTypes.Entity },
    raycastGizmo: { type: hz.PropTypes.Entity },

    damagePerShot: { type: hz.PropTypes.Number, default: 25 },
    headshotMultiplier: { type: hz.PropTypes.Number, default: 2 },

    fireCooldown: { type: hz.PropTypes.Number, default: 0.35 },
    maxRange: { type: hz.PropTypes.Number, default: 100 },
  };

  private lastFireTime = 0;

  start() {
    this.connectCodeBlockEvent(
      this.entity,
      hz.CodeBlockEvents.OnIndexTriggerDown,
      (player: hz.Player) => {
        this.tryFire(player);
      },
    );
  }

  private tryFire(player: hz.Player) {
    const now = Date.now();
    if (now - this.lastFireTime < this.props.fireCooldown * 1000) {
      return;
    }
    this.lastFireTime = now;

    this.props.gunshotSfx?.as(hz.AudioGizmo)?.play();

    const muzzle = this.props.muzzle;
    const gizmo = this.props.raycastGizmo?.as(hz.RaycastGizmo);
    if (!muzzle || !gizmo) {
      console.warn('SimpleGun: muzzle and/or raycastGizmo prop is not set.');
      return;
    }

    const hit = gizmo.raycast(muzzle.position.get(), muzzle.forward.get(), {
      layerType: hz.LayerType.Both,
      maxDistance: this.props.maxRange,
    });

    if (hit == null || hit.targetType !== hz.RaycastTargetType.Entity) {
      console.log('SimpleGun: miss');
      return;
    }

    const hitbox = hit.target;
    const isHead = hitbox.tags.contains('head');
    const isBody = hitbox.tags.contains('body');

    if (!isHead && !isBody) {
      console.log(`SimpleGun: hit ${hitbox.name.get()} (not a hitbox)`);
      return;
    }

    const amount = isHead
      ? this.props.damagePerShot * this.props.headshotMultiplier
      : this.props.damagePerShot;

    // The health script lives on the hitbox's parent, not the hitbox itself.
    const owner = hitbox.parent.get();
    if (!owner) {
      console.warn(
        `SimpleGun: ${hitbox.name.get()} is tagged as a hitbox but has no parent to damage.`,
      );
      return;
    }

    this.sendLocalEvent(owner, damageEvent, { amount, isHeadshot: isHead });
  }
}

hz.Component.register(SimpleGun);
