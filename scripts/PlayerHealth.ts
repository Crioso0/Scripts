import * as hz from 'horizon/core';

export const playerDamageEvent = new hz.LocalEvent<{
  player: hz.Player;
  amount: number;
}>('playerDamage');

class PlayerHealth extends hz.Component<typeof PlayerHealth> {
  static propsDefinition = {
    maxHealth: { type: hz.PropTypes.Number, default: 100 },

    healthText: { type: hz.PropTypes.Entity },

    damageSfx: { type: hz.PropTypes.Entity },
    deathSfx: { type: hz.PropTypes.Entity },

    respawnPoint: { type: hz.PropTypes.Entity },
    respawnDelay: { type: hz.PropTypes.Number, default: 2 },

    invulnerabilitySeconds: { type: hz.PropTypes.Number, default: 0.25 },

    debug: { type: hz.PropTypes.Boolean, default: true },
  };

  private healthByPlayer = new Map<hz.Player, number>();
  private invulnerableUntil = new Map<hz.Player, number>();
  private deadPlayers = new Set<hz.Player>();

  preStart() {
    this.connectLocalEvent(this.entity, playerDamageEvent, (data) => {
      this.takeDamage(data.player, data.amount);
    });
  }

  start() {
    this.updateHealthText(null, this.props.maxHealth);

    if (!this.props.respawnPoint) {
      console.warn(
        'PlayerHealth: respawnPoint is not assigned. Dead players will reset in place.',
      );
    }

    console.log('PlayerHealth: system ready');
  }

  private takeDamage(player: hz.Player, requestedAmount: number) {
    if (this.deadPlayers.has(player)) {
      return;
    }

    const now = Date.now();
    const protectedUntil = this.invulnerableUntil.get(player) ?? 0;

    if (now < protectedUntil) {
      return;
    }

    const amount = Math.max(0, requestedAmount);
    if (amount <= 0) {
      return;
    }

    const maxHealth = Math.max(1, this.props.maxHealth);
    const currentHealth = this.healthByPlayer.get(player) ?? maxHealth;
    const newHealth = Math.max(0, currentHealth - amount);

    this.healthByPlayer.set(player, newHealth);

    this.invulnerableUntil.set(
      player,
      now + this.props.invulnerabilitySeconds * 1000,
    );

    this.props.damageSfx?.as(hz.AudioGizmo)?.play();

    this.updateHealthText(player, newHealth);

    if (this.props.debug) {
      console.log(
        `PlayerHealth: "${player.name.get()}" took ${amount} damage -> ` +
          `${newHealth}/${maxHealth}`,
      );
    }

    if (newHealth <= 0) {
      this.killPlayer(player);
    }
  }

  private killPlayer(player: hz.Player) {
    if (this.deadPlayers.has(player)) {
      return;
    }

    this.deadPlayers.add(player);
    this.props.deathSfx?.as(hz.AudioGizmo)?.play();

    console.log(`PlayerHealth: "${player.name.get()}" DIED`);

    this.async.setTimeout(() => {
      if (!this.world.getPlayers().includes(player)) {
        this.healthByPlayer.delete(player);
        this.invulnerableUntil.delete(player);
        this.deadPlayers.delete(player);
        return;
      }

      const maxHealth = Math.max(1, this.props.maxHealth);

      this.healthByPlayer.set(player, maxHealth);
      this.invulnerableUntil.set(
        player,
        Date.now() + this.props.invulnerabilitySeconds * 1000,
      );
      this.deadPlayers.delete(player);

      const spawnPoint = this.props.respawnPoint?.as(hz.SpawnPointGizmo);

      if (spawnPoint) {
        spawnPoint.teleportPlayer(player);
      } else {
        console.warn(
          'PlayerHealth: player reset, but respawnPoint is not assigned.',
        );
      }

      this.updateHealthText(player, maxHealth);

      console.log(
        `PlayerHealth: "${player.name.get()}" respawned with full health`,
      );
    }, this.props.respawnDelay * 1000);
  }

  private updateHealthText(player: hz.Player | null, currentHealth: number) {
    const textEntity = this.props.healthText;
    if (!textEntity) {
      return;
    }

    const maxHealth = Math.max(1, this.props.maxHealth);
    const label = player ? player.name.get() : 'PLAYER';

    textEntity
      .as(hz.TextGizmo)
      ?.text.set(`${label} HEALTH: ${currentHealth} / ${maxHealth}`);
  }
}

hz.Component.register(PlayerHealth);
