import * as hz from 'horizon/core';

/**
 * Shared events. Kept in their own file so scripts depend on the contract
 * rather than on each other - SimpleGun no longer has to import TargetHealth
 * just to reach an event.
 */

/** Gun -> target. The attacker is carried so rewards reach the right player. */
export const damageEvent = new hz.LocalEvent<{
  attacker: hz.Player;
  amount: number;
  isHeadshot: boolean;
}>('damage');

/** Anything -> ScoreHud. Broadcast, so any system can pay a player. */
export const awardMoneyEvent = new hz.LocalEvent<{
  player: hz.Player;
  amount: number;
  reason: string;
}>('awardMoney');

/**
 * Anything -> ScoreHud. Charge a player. Purchases should check they can
 * afford it first; ScoreHud clamps at zero rather than going negative.
 */
export const spendMoneyEvent = new hz.LocalEvent<{
  player: hz.Player;
  amount: number;
  reason: string;
}>('spendMoney');
