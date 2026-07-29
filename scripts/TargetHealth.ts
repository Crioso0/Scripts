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
 * Attach to the EMPTY root object of a target. Expects two collidable
 * children tagged "head" and "body", plus a health bar fill object.
 */
class TargetHealth extends hz.Component<typeof TargetHealth> {
  static propsDefinition = {
    maxHealth: { type: hz.PropTypes.Number, default: 100 },

    // Coloured cube that shrinks. Must be a child of the bar background.
    healthBarFill: { type: hz.PropTypes.Entity },
    // Optional Text gizmo showing "80 / 100".
    healthText: { type: hz.PropTypes.Entity },

    // Plays on EVERY successful hit, head or body.
    hitMarkerSfx: { type: hz.PropTypes.Entity },
    // Plays only when a headshot is the killing blow.
    headshotKillSfx: { type: hz.PropTypes.Entity },

    // Seconds after death before the target resets to full health.
    respawnDelay: { type: hz.PropTypes.Number, default: 2 },
  };

  private health = 0;
  private isDead = false;

  // Cached full-health transform of the bar fill, captured once at start.
  private fillFullScale: hz.Vec3 | null = null;
  private fillFullPosition: hz.Vec3 | null = null;

  start() {
    this.health = this.props.maxHealth;

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

    this.refreshBar();
  }

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
}

hz.Component.register(TargetHealth);
