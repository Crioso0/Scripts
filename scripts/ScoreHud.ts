import * as hz from 'horizon/core';
import { Binding, Text, UIComponent, View } from 'horizon/ui';
import { awardMoneyEvent, spendMoneyEvent } from 'GameEvents';

/**
 * ScoreHud
 * --------
 * Attach to a Custom UI gizmo with Display Mode set to Screen Overlay.
 *
 * Holds each player's money and draws it on their screen. Money is per-player:
 * the Binding is written with a player list so one HUD serves everyone without
 * leaking one player's balance to another.
 *
 * Other systems pay and charge through the broadcast events in GameEvents,
 * so nothing else needs a reference to this component.
 */
class ScoreHud extends UIComponent<typeof ScoreHud> {
  static propsDefinition = {
    startingMoney: { type: hz.PropTypes.Number, default: 500 },
    debugMoney: { type: hz.PropTypes.Boolean, default: true },
  };

  // Panel size only matters for world-space UI; harmless for screen overlay.
  static panelWidth = 400;
  static panelHeight = 160;

  private balances = new Map<number, number>();
  private moneyLabel = new Binding<string>('$0');

  initializeUI() {
    return View({
      children: [
        Text({
          text: this.moneyLabel,
          style: {
            color: '#f5c542',
            fontSize: 42,
            fontWeight: 'bold',
          },
        }),
      ],
      style: {
        position: 'absolute',
        left: 40,
        bottom: 40,
        padding: 12,
      },
    });
  }

  start() {
    this.connectCodeBlockEvent(
      this.entity,
      hz.CodeBlockEvents.OnPlayerEnterWorld,
      (player: hz.Player) => {
        this.setBalance(player, this.props.startingMoney);
      },
    );

    this.connectCodeBlockEvent(
      this.entity,
      hz.CodeBlockEvents.OnPlayerExitWorld,
      (player: hz.Player) => {
        this.balances.delete(player.id);
      },
    );

    this.connectLocalBroadcastEvent(awardMoneyEvent, (data) => {
      this.setBalance(
        data.player,
        this.getBalance(data.player) + data.amount,
        data.reason,
        data.amount,
      );
    });

    this.connectLocalBroadcastEvent(spendMoneyEvent, (data) => {
      this.setBalance(
        data.player,
        Math.max(0, this.getBalance(data.player) - data.amount),
        data.reason,
        -data.amount,
      );
    });
  }

  private getBalance(player: hz.Player): number {
    const existing = this.balances.get(player.id);
    return existing == null ? this.props.startingMoney : existing;
  }

  private setBalance(
    player: hz.Player,
    value: number,
    reason?: string,
    delta?: number,
  ) {
    this.balances.set(player.id, value);

    // Writing with a player list keeps each HUD showing only its own balance.
    this.moneyLabel.set(`$${value}`, [player]);

    if (this.props.debugMoney && reason) {
      const sign = delta != null && delta >= 0 ? '+' : '';
      console.log(
        `ScoreHud: ${player.name.get()} ${sign}${delta} (${reason}) -> $${value}`,
      );
    }
  }
}

hz.Component.register(ScoreHud);
