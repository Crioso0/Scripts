import * as hz from 'horizon/core';
import { damageEvent } from 'TargetHealth';

class SimpleGun extends hz.Component<typeof SimpleGun> {
  static propsDefinition = {
    muzzle: { type: hz.PropTypes.Entity },
    gunshotSfx: { type: hz.PropTypes.Entity },
    raycastGizmo: { type: hz.PropTypes.Entity },

    damagePerShot: { type: hz.PropTypes.Number, default: 25 },
    headshotMultiplier: { type: hz.PropTypes.Number, default: 2 },

    fireCooldown: { type: hz.PropTypes.Number, default: 0.35 },
    maxRange: { type: hz.PropTypes.Number, default: 100 },

    // Set false once everything works to quieten the console.
    debug: { type: hz.PropTypes.Boolean, default: true },
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

  private log(message: string) {
    if (this.props.debug) {
      console.log(`[Gun] ${message}`);
    }
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
      console.warn('[Gun] muzzle and/or raycastGizmo prop is not set.');
      return;
    }

    const origin = muzzle.position.get();
    const direction = muzzle.forward.get();
    this.log(`fire from ${origin.toString()} dir ${direction.toString()}`);

    const hit = gizmo.raycast(origin, direction, {
      layerType: hz.LayerType.Both,
      maxDistance: this.props.maxRange,
    });

    if (hit == null) {
      this.log('MISS - ray hit nothing at all');
      return;
    }

    if (hit.targetType !== hz.RaycastTargetType.Entity) {
      this.log(`hit a non-entity, targetType=${hit.targetType}`);
      return;
    }

    this.log(
      `ray hit entity "${hit.target.name.get()}" at ${hit.distance.toFixed(2)}m`,
    );

    const found = this.findHitbox(hit.target);
    if (!found) {
      this.log('...but no "head"/"body" tag found on it or any parent');
      return;
    }

    const amount = found.isHead
      ? this.props.damagePerShot * this.props.headshotMultiplier
      : this.props.damagePerShot;

    this.log(
      `${found.isHead ? 'HEAD' : 'BODY'} -> sending ${amount} damage to "${found.owner.name.get()}"`,
    );

    this.sendLocalEvent(found.owner, damageEvent, {
      amount,
      isHeadshot: found.isHead,
    });
  }

  /**
   * The raycast can land on a sub-mesh inside an imported model rather than
   * the object we tagged, so walk up the parent chain looking for the tag.
   * Returns the tagged hitbox's PARENT, which is what owns TargetHealth.
   */
  private findHitbox(
    hitEntity: hz.Entity,
  ): { owner: hz.Entity; isHead: boolean } | null {
    let current: hz.Entity | null = hitEntity;

    for (let depth = 0; current != null && depth < 6; depth++) {
      const isHead = current.tags.contains('head');
      const isBody = current.tags.contains('body');

      if (isHead || isBody) {
        this.log(`  tag "${isHead ? 'head' : 'body'}" on "${current.name.get()}"`);

        const owner = current.parent.get();
        if (!owner) {
          console.warn(
            `[Gun] "${current.name.get()}" is tagged but has no parent to damage.`,
          );
          return null;
        }
        return { owner, isHead };
      }

      this.log(`  no tag on "${current.name.get()}", checking its parent`);
      current = current.parent.get();
    }

    return null;
  }
}

hz.Component.register(SimpleGun);
