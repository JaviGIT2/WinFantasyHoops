import type { PlayerData } from '../data/types';
import { isOut, type EngineCtx } from './context';
import { rosterSize, type SlotCounts } from './lineup';

/**
 * How many players a roster can hold: every active and bench slot, plus an IL slot for each player who is out injured
 * (Yahoo only lets injured players use IL).
 */
export function rosterCapacity(ctx: EngineCtx, slots: SlotCounts, roster: PlayerData[]): number {
  const injured = roster.filter((p) => isOut(ctx, p)).length;
  return rosterSize(slots) + Math.min(slots.IL ?? 0, injured);
}

/**
 * What bringing a player onto a team takes: `add` a free agent there's room for; `drop` someone to fit a free agent on a
 * full roster; or `trade` 1-for-1 with the `partner` team that has him.
 */
export type AddMove = { kind: 'on-team' } | { kind: 'add' } | { kind: 'drop' } | { kind: 'trade'; partner: number };

export function addMove(ctx: EngineCtx, slots: SlotCounts, rosters: string[][], team: number, pid: string): AddMove {
  const owner = rosters.findIndex((r) => r.includes(pid));
  if (owner === team) return { kind: 'on-team' };
  if (owner >= 0) return { kind: 'trade', partner: owner };
  const roster = (rosters[team] ?? []).map((id) => ctx.byId.get(id)).filter((p): p is PlayerData => !!p);
  return roster.length < rosterCapacity(ctx, slots, roster) ? { kind: 'add' } : { kind: 'drop' };
}
