import { describe, expect, it } from 'vitest';
import type { PlayerData } from '../src/data/types';
import { FORMAT_PRESETS } from '../src/engine/categories';
import { createContext, isOut, withProjectionEdits, type EngineCtx, type PlayerOverride } from '../src/engine/context';
import { leagueReport, openSpots, playerWeekAgg, teamAgg, tradeImpact } from '../src/engine/league';
import type { SlotCounts } from '../src/engine/lineup';
import { addAgg, emptyAgg } from '../src/engine/matchup';
import { availability, perGameFor, seasonProjection } from '../src/engine/projection';
import { scaleLine } from '../src/engine/stats';
import { teamTradeValue, tradeValues, withEdits, type TradeValues } from '../src/engine/tradeValue';
import { computeZ, zOf } from '../src/engine/zscore';
import { makeBundle } from './fixtures';

const cats = FORMAT_PRESETS[0].cats;
/** Eight-man rosters (six active spots and two bench) with one IL slot: four teams fill 32 spots. */
const slots: SlotCounts = { PG: 1, SG: 1, G: 0, SF: 1, PF: 1, F: 0, C: 1, UTIL: 1, BN: 2, IL: 1 };

function league(overrides: Record<string, PlayerOverride> = {}, ilSlots = 1) {
  const { bundle } = makeBundle();
  const ctx = createContext(bundle, overrides, '2026-10-01');
  const rosters = ['AAA', 'BBB', 'CCC', 'DDD'].map((t) => bundle.players.filter((p) => p.team === t));
  const values = tradeValues(ctx, cats, 'last', 4, { ...slots, IL: ilSlots });
  const V = (p: PlayerData) => values.value.get(p.id)!;
  return { bundle, ctx, rosters, values, V };
}

/** Trade between teams 0 and 1 (with drops), returning both teams' trade values. */
function trade(ctx: EngineCtx, values: TradeValues, rosters: PlayerData[][], give: PlayerData[], get: PlayerData[], drops: PlayerData[] = []) {
  const t = tradeImpact(ctx, rosters, 0, 1, give.map((p) => p.id), get.map((p) => p.id), cats, 'last', drops.map((p) => p.id), values.fill);
  return { ...t, worth: [0, 1].map((i) => teamTradeValue(ctx, values, rosters[i], t.traded[i], t.rosters[i])) };
}

/**
 * A roster's worth the way the team impact counts it: its healthy players, injured players stuck in a roster spot
 * (no IL slot left) producing nothing, and a replacement-level player for each open spot (less one per extra player).
 */
function rosterWorth(ctx: EngineCtx, values: TradeValues, roster: PlayerData[]) {
  const out = roster.filter((p) => isOut(ctx, p)).length;
  const healthy = roster.filter((p) => !isOut(ctx, p)).reduce((s, p) => s + values.value.get(p.id)!, 0);
  return healthy + Math.max(0, out - values.fill.slots.IL) * values.nothing + openSpots(ctx, values.fill.slots, roster) * values.replacement;
}

describe('trade value: Σ (player value − replacement value)', () => {
  it('values players by z-score total of production per game, discounted for missed games; replacement is just past the roster spots', () => {
    const { bundle, ctx, values } = league({ p5: { avail: 0.5 }, p7: { status: 'out' } });
    const lines = bundle.players.map((p) => ({ id: p.id, line: scaleLine(perGameFor(ctx, p, 'last'), availability(ctx, p)) }));
    const z = computeZ(lines, cats, 32);
    for (const p of bundle.players) expect(values.value.get(p.id)).toBeCloseTo(z.rows.get(p.id)!.total, 12);
    // Missing half the games costs value; a player out injured produces nothing.
    expect(values.value.get('p5')).toBeLessThan(league().values.value.get('p5')!);
    expect(values.value.get('p7')).toBeCloseTo(values.nothing, 12);
    expect(values.nothing).toBeLessThan(Math.min(...bundle.players.filter((p) => p.id !== 'p7').map((p) => values.value.get(p.id)!)));

    // Replacement: four teams × eight spots = 32, so the next four players (one per team) among those who'd play.
    const ranked = bundle.players.filter((p) => p.id !== 'p7').sort((a, b) => values.value.get(b.id)! - values.value.get(a.id)!);
    const tier = ranked.slice(32, 36);
    expect(values.tier).toEqual([33, 36]);
    expect(values.replacement).toBeCloseTo(tier.reduce((s, p) => s + values.value.get(p.id)!, 0) / 4, 12);
    const agg = emptyAgg();
    for (const p of tier) addAgg(agg, playerWeekAgg(ctx, p, 'last'), 0.25);
    values.fill.agg.mean.forEach((m, i) => expect(m).toBeCloseTo(agg.mean[i], 12));
    values.fill.agg.var.forEach((v, i) => expect(v).toBeCloseTo(agg.var[i], 12));

    // A league with more spots than players: the last ones are replacement level.
    const deep = tradeValues(ctx, cats, 'last', 12, slots);
    expect(deep.tier).toEqual([36, 47]);
    expect(deep.replacement).toBeCloseTo(ranked.slice(35).reduce((s, p) => s + values.value.get(p.id)!, 0) / 12, 12);
  });

  it('adds up what each team gets, minus what it sends and drops: uneven trades included', () => {
    const { ctx, rosters, values, V } = league();
    const R = values.replacement;
    const [x, d] = [rosters[1][0], rosters[1][4]];
    const [y, z] = [rosters[0][1], rosters[0][2]];
    const ids = (lines: { player: PlayerData }[]) => lines.map((l) => l.player.id);

    // 1-for-1: replacement value cancels out, and what one team gains the other loses.
    let [a, b] = trade(ctx, values, rosters, [y], [x]).worth;
    expect(a.total).toBeCloseTo(V(x) - V(y), 12);
    expect(b.total).toBeCloseTo(-a.total, 12);
    expect(a.gets[0]).toEqual({ player: x, value: V(x), net: V(x) - R });
    expect(a.sends[0]).toEqual({ player: y, value: V(y), net: -(V(y) - R) });

    // 2-for-1: team 0's open spot is worth a free agent; team 1 is over its limit, charged a replacement-level drop.
    [a, b] = trade(ctx, values, rosters, [y, z], [x]).worth;
    expect(a.total).toBeCloseTo(V(x) - V(y) - V(z) + R, 12);
    expect([ids(a.gets), ids(a.sends), ids(a.drops), a.toDrop]).toEqual([[x.id], [y.id, z.id], [], 0]);
    expect(b.total).toBeCloseTo(-a.total, 12);
    expect(b.toDrop).toBe(1);

    // Once team 1 picks its drop, the replacement-level stand-in becomes the real player.
    [, b] = trade(ctx, values, rosters, [y, z], [x], [d]).worth;
    expect(b.total).toBeCloseTo(V(y) + V(z) - V(x) - V(d), 12);
    expect([ids(b.drops), b.toDrop]).toEqual([[d.id], 0]);
    // Dropping a player it just got cancels him out.
    [, b] = trade(ctx, values, rosters, [y, z], [x], [y]).worth;
    expect(b.total).toBeCloseTo(V(z) - V(x), 12);

    // Always the change in the roster's worth as the team impact counts it.
    for (const [give, get, drops] of [[[y], [x], []], [[y, z], [x], []], [[y, z], [x], [d]], [[y], [], []], [[], [x, d], [y]]] as PlayerData[][][]) {
      const t = trade(ctx, values, rosters, give, get, drops);
      for (const i of [0, 1]) expect(t.worth[i].total).toBeCloseTo(rosterWorth(ctx, values, t.rosters[i]) - rosterWorth(ctx, values, rosters[i]), 9);
    }
  });

  it('counts open roster spots at replacement level, so getting more players is no win by itself', () => {
    const { ctx, rosters, values, V } = league();
    // Team 0's least valuable player is below replacement level.
    const w = [...rosters[0]].sort((p, q) => V(p) - V(q))[0];
    expect(V(w)).toBeLessThan(values.replacement);

    // Counting rosters as they are, giving him away for nothing hurts team 0 and helps team 1, just for the extra body.
    const plain = tradeImpact(ctx, rosters, 0, 1, [w.id], [], cats, 'last');
    expect(plain.after[0].power).toBeLessThan(plain.before[0].power);
    expect(plain.after[1].power).toBeGreaterThan(plain.before[1].power);

    // At replacement level, team 0 fills his spot with a better free agent and team 1 has to cut someone to fit him.
    const fair = trade(ctx, values, rosters, [w], []);
    expect(fair.after[0].power).toBeGreaterThan(fair.before[0].power);
    expect(fair.after[1].power).toBeLessThan(fair.before[1].power);
    expect(fair.worth[0].total).toBeCloseTo(values.replacement - V(w), 12);
    expect(fair.worth[0].total).toBeGreaterThan(0);
    expect(fair.worth[1].total).toBeCloseTo(-fair.worth[0].total, 12);

    // Exactly: a team's production is its players' plus a replacement-level player per open spot, less one per extra player.
    const short = addAgg(teamAgg(ctx, fair.rosters[0], 'last'), values.fill.agg, 1);
    const long = addAgg(teamAgg(ctx, fair.rosters[1], 'last'), values.fill.agg, -1);
    fair.after[0].agg.mean.forEach((m, i) => expect(m).toBeCloseTo(short.mean[i], 9));
    fair.after[1].agg.mean.forEach((m, i) => expect(m).toBeCloseTo(long.mean[i], 9));
    // Full rosters before the trade: nothing to fill, the same report as the League tab's.
    expect(fair.before).toEqual(leagueReport(ctx, rosters, cats, 'last'));
  });

  it('an injured player counts ±0 while he waits on IL, and costs a roster spot when there is no IL slot for him', () => {
    const hurt = 'p9';
    const { ctx, rosters, values, V } = league({ [hurt]: { status: 'out' } });
    const o = ctx.byId.get(hurt)!;
    const h = rosters[0][2];
    expect(rosters[1]).toContain(o);
    // Team 1 had him on IL and a free agent in his spot.
    expect(openSpots(ctx, values.fill.slots, rosters[1])).toBe(1);

    // Team 0 gets him for a healthy player: he goes on IL and a free agent takes the open spot.
    let t = trade(ctx, values, rosters, [h], [o]);
    expect(t.worth[0].gets[0]).toEqual({ player: o, value: null, net: 0 });
    expect(t.worth[0].total).toBeCloseTo(values.replacement - V(h), 12);
    expect(t.worth[1].total).toBeCloseTo(V(h) - values.replacement, 12);
    expect(openSpots(ctx, values.fill.slots, t.rosters[0])).toBe(1);
    for (const i of [0, 1]) expect(t.worth[i].total).toBeCloseTo(rosterWorth(ctx, values, t.rosters[i]) - rosterWorth(ctx, values, rosters[i]), 9);

    // Without IL slots he sits in a roster spot, producing nothing.
    const noIL = league({ [hurt]: { status: 'out' } }, 0);
    t = trade(noIL.ctx, noIL.values, noIL.rosters, [h], [o]);
    expect(t.worth[0].injured).toBeCloseTo(noIL.values.nothing - noIL.values.replacement, 12);
    expect(t.worth[0].total).toBeCloseTo(noIL.values.nothing - noIL.V(h), 12);
    expect(t.worth[1].injured).toBeCloseTo(-t.worth[0].injured, 12);
    for (const i of [0, 1]) expect(t.worth[i].total).toBeCloseTo(rosterWorth(noIL.ctx, noIL.values, t.rosters[i]) - rosterWorth(noIL.ctx, noIL.values, noIL.rosters[i]), 9);
  });

  it('values what-if projections against the same league: the edited player moves, nothing else does', () => {
    const { ctx } = league();
    const p = ctx.byId.get('p3')!;
    const base = tradeValues(ctx, cats, 'proj', 4, slots);
    expect(withEdits(base, ctx)).toBe(base);
    const edits = withProjectionEdits(ctx, { [p.id]: { pts: seasonProjection(ctx, p).perGame.pts + 8 } });
    const edited = withEdits(base, edits);
    // Measured on the unedited league's norms: exactly his edited line's z-score total.
    const z = computeZ(ctx.data.players.map((q) => ({ id: q.id, line: scaleLine(perGameFor(ctx, q, 'proj'), availability(ctx, q)) })), cats, 32);
    expect(edited.value.get(p.id)).toBeCloseTo(zOf(scaleLine(perGameFor(edits, p, 'proj'), availability(ctx, p)), cats, z.norms).total, 12);
    expect(edited.value.get(p.id)!).toBeGreaterThan(base.value.get(p.id)! + 0.5);
    for (const q of ctx.data.players) if (q.id !== p.id) expect(edited.value.get(q.id)).toBe(base.value.get(q.id));
    expect([edited.replacement, edited.tier, edited.fill]).toEqual([base.replacement, base.tier, base.fill]);
  });
});
