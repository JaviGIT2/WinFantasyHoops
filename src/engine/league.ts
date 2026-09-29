import type { PlayerData } from '../data/types';
import { CATEGORIES, type CatId } from './categories';
import type { EngineCtx } from './context';
import { addAgg, catDist, cloneAgg, compareAggs, emptyAgg, type Agg } from './matchup';
import { availability, perGameFor, type Basis } from './projection';
import { MODEL_STATS } from './stats';

/**
 * Season-long team strength without a specific schedule: every player is
 * credited with `gamesPerWeek` games at his per-game line for the chosen basis,
 * discounted by availability. Teams are compared by expected categories won per
 * week against each other team in the league.
 */
export const GAMES_PER_WEEK = 3.5;

export function playerWeekAgg(ctx: EngineCtx, p: PlayerData, basis: Basis, games = GAMES_PER_WEEK): Agg {
  const pg = perGameFor(ctx, p, basis);
  const a = availability(ctx, p);
  const { phi } = ctx.data.model;
  const agg = emptyAgg();
  MODEL_STATS.forEach((s, i) => {
    const m = pg[s];
    agg.mean[i] = games * a * m;
    agg.var[i] = games * (a * (phi[s] * m + m * m) - (a * m) ** 2);
    agg.pend[i] = agg.mean[i];
  });
  return agg;
}

export function teamAgg(ctx: EngineCtx, players: PlayerData[], basis: Basis): Agg {
  return players.reduce((acc, p) => addAgg(acc, playerWeekAgg(ctx, p, basis)), emptyAgg());
}

/** Expected categories won (ties count half) by A against B. */
export function expectedCats(a: Agg, b: Agg, cats: CatId[]): number {
  const { odds } = compareAggs(a, b, cats);
  return odds.expWins + 0.5 * odds.expTies;
}

export interface LeagueTeamReport {
  index: number;
  agg: Agg;
  /** Expected categories won vs each other team (NaN vs itself). */
  vs: number[];
  /** Average expected categories won per week against the league. */
  power: number;
  /** Average matchup win probability against the league. */
  winPct: number;
  /** League rank (1 = best) per category. */
  ranks: Record<string, number>;
}

export function leagueReport(ctx: EngineCtx, rosters: PlayerData[][], cats: CatId[], basis: Basis): LeagueTeamReport[] {
  const aggs = rosters.map((r) => teamAgg(ctx, r, basis));
  const reports = aggs.map((agg, i) => {
    const vs: number[] = [];
    let winSum = 0;
    aggs.forEach((other, j) => {
      if (i === j) return vs.push(NaN);
      const cmp = compareAggs(agg, other, cats);
      vs.push(cmp.odds.expWins + 0.5 * cmp.odds.expTies);
      winSum += cmp.odds.win + 0.5 * cmp.odds.tie;
    });
    const others = vs.filter((v) => !Number.isNaN(v));
    return {
      index: i,
      agg,
      vs,
      power: others.length ? others.reduce((a, b) => a + b, 0) / others.length : 0,
      winPct: others.length ? winSum / others.length : 0,
      ranks: {} as Record<string, number>,
    };
  });
  // Category ranks by projected weekly value.
  for (const c of cats) {
    const vals = reports.map((r) => catDist(r.agg, CATEGORIES[c]).mean);
    const lower = !!CATEGORIES[c].lowerIsBetter;
    const order = [...vals.keys()].sort((a, b) => (lower ? vals[a] - vals[b] : vals[b] - vals[a]));
    order.forEach((teamIdx, rank) => (reports[teamIdx].ranks[c] = rank + 1));
  }
  return reports;
}

function powerOf(agg: Agg, others: Agg[], cats: CatId[]): number {
  if (!others.length) return 0;
  return others.reduce((s, o) => s + expectedCats(agg, o, cats), 0) / others.length;
}

export interface TradeIdea {
  give: string[];
  get: string[];
  /** Other team index, or -1 for a free-agent pickup. */
  partner: number;
  myDelta: number;
  theirDelta: number;
  /** Change in my expected categories won per category (averaged over the league). */
  catDelta: Record<string, number>;
}

function catBreakdown(before: Agg, after: Agg, others: Agg[], cats: CatId[]) {
  const out: Record<string, number> = {};
  for (const c of cats) {
    const b = others.reduce((s, o) => s + expectedCats(before, o, [c]), 0) / others.length;
    const a = others.reduce((s, o) => s + expectedCats(after, o, [c]), 0) / others.length;
    out[c] = a - b;
  }
  return out;
}

/**
 * Trade and pickup finder. For every 1-for-1 swap (and 2-for-2 swaps among the
 * most promising players) it recomputes both teams' expected categories won
 * against the rest of the league. Free agents are evaluated as add/drop pairs.
 */
export function findTrades(
  ctx: EngineCtx,
  rosters: PlayerData[][],
  myIdx: number,
  freeAgents: PlayerData[],
  cats: CatId[],
  basis: Basis,
  opts: { maxResults?: number; twoForTwo?: boolean } = {},
): { trades: TradeIdea[]; pickups: TradeIdea[]; targets: (TradeIdea & { target: string })[] } {
  const { maxResults = 30, twoForTwo = true } = opts;
  const pAgg = new Map<string, Agg>();
  const aggOf = (p: PlayerData) => {
    if (!pAgg.has(p.id)) pAgg.set(p.id, playerWeekAgg(ctx, p, basis));
    return pAgg.get(p.id)!;
  };
  const teamAggs = rosters.map((r) => r.reduce((acc, p) => addAgg(acc, aggOf(p)), emptyAgg()));
  const mine = rosters[myIdx];
  // Players ruled out go to an IL slot; offering them in trades or dropping them isn't realistic advice.
  const tradeable = (p: PlayerData) => availability(ctx, p) > 0;
  const myGive = mine.filter(tradeable);
  const myAgg = teamAggs[myIdx];
  const othersOf = (idx: number, replace?: Map<number, Agg>) =>
    teamAggs.map((a, j) => replace?.get(j) ?? a).filter((_, j) => j !== idx);
  const myPower = powerOf(myAgg, othersOf(myIdx), cats);
  const basePower = teamAggs.map((a, i) => powerOf(a, othersOf(i), cats));

  const swap = (base: Agg, out: PlayerData[], inn: PlayerData[]) => {
    const a = cloneAgg(base);
    out.forEach((p) => addAgg(a, aggOf(p), -1));
    inn.forEach((p) => addAgg(a, aggOf(p), 1));
    return a;
  };

  const evalTrade = (partner: number, give: PlayerData[], get: PlayerData[]): TradeIdea => {
    const newMine = swap(myAgg, give, get);
    const newTheirs = swap(teamAggs[partner], get, give);
    const mineOthers = othersOf(myIdx, new Map([[partner, newTheirs]]));
    const theirOthers = othersOf(partner, new Map([[myIdx, newMine]]));
    return {
      give: give.map((p) => p.id),
      get: get.map((p) => p.id),
      partner,
      myDelta: powerOf(newMine, mineOthers, cats) - myPower,
      theirDelta: powerOf(newTheirs, theirOthers, cats) - basePower[partner],
      catDelta: {},
    };
  };

  const trades: TradeIdea[] = [];
  const bestTarget = new Map<string, TradeIdea & { target: string }>();
  const consider = (t: TradeIdea, target: PlayerData) => {
    const prev = bestTarget.get(target.id);
    if (!prev || t.myDelta > prev.myDelta) bestTarget.set(target.id, { ...t, target: target.id });
  };

  rosters.forEach((roster, partner) => {
    if (partner === myIdx) return;
    const singles: TradeIdea[] = [];
    for (const m of myGive) for (const o of roster.filter(tradeable)) {
      const t = evalTrade(partner, [m], [o]);
      singles.push(t);
      consider(t, o);
    }
    trades.push(...singles);
    if (!twoForTwo || myGive.length < 2 || roster.length < 2) return;
    // 2-for-2 among the partner's six most useful players to me.
    const useful = [...new Set(singles.sort((a, b) => b.myDelta - a.myDelta).map((t) => t.get[0]))].slice(0, 6);
    const theirs = roster.filter((p) => useful.includes(p.id));
    for (let a = 0; a < myGive.length; a++) for (let b = a + 1; b < myGive.length; b++)
      for (let c = 0; c < theirs.length; c++) for (let d = c + 1; d < theirs.length; d++)
        trades.push(evalTrade(partner, [myGive[a], myGive[b]], [theirs[c], theirs[d]]));
  });

  const pickups: TradeIdea[] = [];
  const others = othersOf(myIdx);
  for (const fa of freeAgents.filter(tradeable)) for (const m of myGive) {
    const newMine = swap(myAgg, [m], [fa]);
    const t: TradeIdea = { give: [m.id], get: [fa.id], partner: -1, myDelta: powerOf(newMine, others, cats) - myPower, theirDelta: 0, catDelta: {} };
    pickups.push(t);
    consider(t, fa);
  }

  const withBreakdown = (t: TradeIdea): TradeIdea => {
    const give = t.give.map((id) => ctx.byId.get(id)!);
    const get = t.get.map((id) => ctx.byId.get(id)!);
    const after = swap(myAgg, give, get);
    return { ...t, catDelta: catBreakdown(myAgg, after, others, cats) };
  };

  // Realistic trades: I gain and the partner doesn't lose much.
  const fair = trades
    .filter((t) => t.myDelta > 0.02 && t.theirDelta > -0.1)
    .sort((a, b) => b.myDelta + 0.5 * b.theirDelta - (a.myDelta + 0.5 * a.theirDelta))
    .slice(0, maxResults)
    .map(withBreakdown);
  const bestPickups = pickups
    .filter((t) => t.myDelta > 0.01)
    .sort((a, b) => b.myDelta - a.myDelta)
    .slice(0, maxResults)
    .map(withBreakdown);
  const targets = [...bestTarget.values()]
    .filter((t) => t.myDelta > 0)
    .sort((a, b) => b.myDelta - a.myDelta)
    .slice(0, maxResults)
    .map((t) => ({ ...withBreakdown(t), target: t.target }));
  return { trades: fair, pickups: bestPickups, targets };
}
