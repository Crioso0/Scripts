import * as hz from 'horizon/core';
import { damageEvent } from 'GameEvents';

/**
 * SimpleGun
 * ---------
 * Attach to the grabbable gun root ("My Try").
 *
 * Primary action -> gunshot audio, raycast from Muzzle_point, impact particle
 * at the hit point, and a damage event to whatever tagged hitbox was hit.
 *
 * NOTE: the Raycast gizmo's "Collide With" property must include Objects.
 * Set to Players only, every hit comes back as static geometry and no
 * entity is ever reported.
 */
class SimpleGun extends hz.Component<typeof SimpleGun> {
  static propsDefinition = {
    muzzle: { type: hz.PropTypes.Entity },
    gunshotSfx: { type: hz.PropTypes.Entity },
    raycastGizmo: { type: hz.PropTypes.Entity },

    // One permanent particle gizmo, repositioned per shot. Spawning copies
    // per shot rendered unreliably, so a single reused emitter it is.
    impactParticle: { type: hz.PropTypes.Entity },

    damagePerShot: { type: hz.PropTypes.Number, default: 25 },
    headshotMultiplier: { type: hz.PropTypes.Number, default: 2 },

    fireCooldown: { type: hz.PropTypes.Number, default: 0.35 },
    maxRange: { type: hz.PropTypes.Number, default: 100 },

    debug: { type: hz.PropTypes.Boolean, default: false },
    // Diagnostic only: reports how far off the muzzle is from the target.
    aimCheckTarget: { type: hz.PropTypes.Entity },
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
    this.logAimError(origin, direction);

    const hit = gizmo.raycast(origin, direction, {
      layerType: hz.LayerType.Both,
      maxDistance: this.props.maxRange,
    });

    if (hit == null) {
      this.log('MISS - ray hit nothing at all');
      return;
    }

    this.playImpact(hit.hitPoint, direction, muzzle.rotation.get());

    if (hit.targetType !== hz.RaycastTargetType.Entity) {
      this.log(
        `hit a non-entity (targetType=${hit.targetType}) at ` +
          `${hit.hitPoint.toString()}, ${hit.distance.toFixed(2)}m away`,
      );
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
      attacker: player,
      amount,
      isHeadshot: found.isHead,
    });
  }

  /** Reposition the shared emitter just off the surface, then fire it. */
  private playImpact(
    hitPoint: hz.Vec3,
    direction: hz.Vec3,
    rotation: hz.Quaternion,
  ) {
    const impact = this.props.impactParticle;
    if (!impact) {
      this.log('impactParticle is not assigned.');
      return;
    }

    // Pull back along the ray so the effect is not buried inside the surface.
    const visiblePosition = new hz.Vec3(
      hitPoint.x - direction.x * 0.08,
      hitPoint.y - direction.y * 0.08,
      hitPoint.z - direction.z * 0.08,
    );

    impact.position.set(visiblePosition);
    impact.rotation.set(rotation);

    // Let the new transform land before playback, or the burst renders at the
    // emitter's previous position.
    this.async.setTimeout(() => {
      impact.as(hz.ParticleGizmo)?.play();
    }, 100);
  }

  /** Diagnostic: angle between the muzzle's forward axis and the target. */
  private logAimError(origin: hz.Vec3, direction: hz.Vec3) {
    const check = this.props.aimCheckTarget;
    if (!check || !this.props.debug) {
      return;
    }

    const targetPos = check.position.get();
    const dx = targetPos.x - origin.x;
    const dy = targetPos.y - origin.y;
    const dz = targetPos.z - origin.z;

    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (distance < 0.001) {
      return;
    }

    const dot =
      (direction.x * dx + direction.y * dy + direction.z * dz) / distance;
    const angle = (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;

    this.log(
      `aim check: target ${distance.toFixed(2)}m away, muzzle is ` +
        `${angle.toFixed(1)} degrees off from pointing at it`,
    );
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
        this.log(`tag "${isHead ? 'head' : 'body'}" on "${current.name.get()}"`);

        const owner = current.parent.get();
        if (!owner) {
          console.warn(
            `[Gun] "${current.name.get()}" is tagged but has no parent to damage.`,
          );
          return null;
        }
        return { owner, isHead };
      }

      this.log(`no tag on "${current.name.get()}", checking its parent`);
      current = current.parent.get();
    }

    return null;
  }
}

hz.Component.register(SimpleGun);
