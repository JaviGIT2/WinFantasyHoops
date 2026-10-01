import type { PlayerData } from '../data/types';
import type { CatId } from './categories';
import { isOut, type EngineCtx } from './context';
import { openSpots, playerWeekAgg, type ReplacementFill } from './league';
import { rosterSize, type SlotCounts } from './lineup';
import { addAgg, emptyAgg } from './matchup';
import { availability, perGameFor, type Basis } from './projection';
import { scaleLine, zeroLine } from './stats';
import { computeZ, zOf, type ZResult } from './zscore';

/**
 * Value over replacement, the Trade Analyzer's verdict on a trade:
 *
 *   Trade value = Σ (player's value − replacement value)
 *
 * over the players a team gets, minus the same over the players it sends away or drops. Counting each player only for
 * what he adds over a free agent keeps uneven trades honest: the team getting more players gives up a roster spot (a
 * free agent's worth) for each extra one, and the team getting fewer fills its open spots from waivers.
 *
 * A player's value is his z-score total across the league's categories, measured against every player with minutes,
 * for his expected production per game on the stat basis discounted for missed games: the production the team impact
 * credits him with. The replacement value is the average value of the players ranked just past the league's roster
 * spots (teams × roster size), the best players nobody has room for.
 */
export interface TradeValues {
  /** Value by player id. */
  value: Map<string, number>;
  /** Average value of the replacement tier. */
  replacement: number;
  /** Ranks the replacement tier spans (1-based, inclusive). */
  tier: [number, number];
  /** Value of a player who produces nothing (out injured). */
  nothing: number;
  /** A replacement-level player's weekly production, for open roster spots. */
  fill: ReplacementFill;
  /** What the values are measured against, for valuing what-if projections the same way. */
  norms: ZResult['norms'];
  cats: CatId[];
  basis: Basis;
}

/** Expected production per game on the basis, discounted for missed games. */
const valueLine = (ctx: EngineCtx, p: PlayerData, basis: Basis) => scaleLine(perGameFor(ctx, p, basis), availability(ctx, p));

export function tradeValues(ctx: EngineCtx, cats: CatId[], basis: Basis, teams: number, slots: SlotCounts): TradeValues {
  const lines = ctx.data.players.map((p) => ({ id: p.id, line: valueLine(ctx, p, basis) }));
  const spots = teams * rosterSize(slots);
  const { rows, norms } = computeZ(lines, cats, spots);
  const value = new Map(lines.map((l) => [l.id, rows.get(l.id)!.total]));
  // One player per team past the roster spots, among players who'd play; in a small player pool, the last ones.
  const ranked = lines.filter((l) => l.line.min > 0).map((l) => l.id).sort((a, b) => value.get(b)! - value.get(a)!);
  const size = Math.min(Math.max(1, teams), ranked.length);
  const start = Math.max(0, Math.min(spots, ranked.length - size));
  const tier = ranked.slice(start, start + size);
  const agg = emptyAgg();
  for (const id of tier) addAgg(agg, playerWeekAgg(ctx, ctx.byId.get(id)!, basis), 1 / tier.length);
  const replacement = tier.length ? tier.reduce((s, id) => s + value.get(id)!, 0) / tier.length : 0;
  const nothing = zOf(zeroLine(), cats, norms).total;
  return { value, replacement, tier: [start + 1, start + tier.length], nothing, fill: { slots, agg }, norms, cats, basis };
}

/**
 * The same values with the what-if projections `ctx` carries (the Trade Analyzer's edits) for the players edited. They
 * are measured against the same league: what-ifs never move the norms or the replacement level.
 */
export function withEdits(values: TradeValues, ctx: EngineCtx): TradeValues {
  const edited = Object.keys(ctx.projEdits ?? {});
  if (!edited.length) return values;
  const value = new Map(values.value);
  for (const id of edited) {
    const p = ctx.byId.get(id);
    if (p) value.set(id, zOf(valueLine(ctx, p, values.basis), values.cats, values.norms).total);
  }
  return { ...values, value };
}

export interface ValueLine {
  player: PlayerData;
  /** His value; null while he's out injured. */
  value: number | null;
  /**
   * What he counts for in the team's trade value: value − replacement value, positive coming in and negative going
   * out. A player out injured counts ±0: he waits on IL while a free agent takes his spot.
   */
  net: number;
}

export interface TeamTradeValue {
  gets: ValueLine[];
  sends: ValueLine[];
  drops: ValueLine[];
  /** Players the team still has to drop to get within its limit, each counted as a replacement-level player (±0). */
  toDrop: number;
  /** Injured players who don't fit on IL take a roster spot and produce nothing: the change in what that costs. */
  injured: number;
  /** The trade value: every net plus `injured`. */
  total: number;
}

/** A team's trade value, from its roster before the trade, right after it (`traded`) and after its drops (`after`). */
export function teamTradeValue(ctx: EngineCtx, values: TradeValues, before: PlayerData[], traded: PlayerData[], after: PlayerData[]): TeamTradeValue {
  const { value, replacement, nothing, fill } = values;
  const ids = (r: PlayerData[]) => new Set(r.map((p) => p.id));
  const [inBefore, inTraded, inAfter] = [ids(before), ids(traded), ids(after)];
  const line = (p: PlayerData, sign: number): ValueLine => {
    if (isOut(ctx, p)) return { player: p, value: null, net: 0 };
    const v = value.get(p.id) ?? nothing;
    return { player: p, value: v, net: sign * (v - replacement) };
  };
  const gets = traded.filter((p) => !inBefore.has(p.id)).map((p) => line(p, 1));
  const sends = before.filter((p) => !inTraded.has(p.id)).map((p) => line(p, -1));
  const drops = traded.filter((p) => !inAfter.has(p.id)).map((p) => line(p, -1));
  // Injured players past the IL slots sit in a spot a free agent could fill.
  const stuck = (r: PlayerData[]) => Math.max(0, r.filter((p) => isOut(ctx, p)).length - (fill.slots.IL ?? 0));
  const injured = (stuck(after) - stuck(before)) * (nothing - replacement);
  const total = [...gets, ...sends, ...drops].reduce((s, l) => s + l.net, 0) + injured;
  return { gets, sends, drops, toDrop: Math.max(0, -openSpots(ctx, fill.slots, after)), injured, total };
}
