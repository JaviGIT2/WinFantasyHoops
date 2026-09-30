import type { PlayerData } from '../data/types';
import { CATEGORIES, type CatId } from './categories';
import type { EngineCtx } from './context';
import { addAgg, catDist, catOdds, cloneAgg, compareAggs, emptyAgg, type Agg } from './matchup';
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

/** How much each category counts when scoring my moves (missing = 1). */
export type CatWeights = Partial<Record<CatId, number>>;

/** Targeted categories count this many times over when ranking trades and pickups. */
export const TARGET_WEIGHT = 2;

/** Weights for a category strategy: targets count double, given-up (punted) categories not at all. */
export function strategyWeights(targets: CatId[], punts: CatId[]): CatWeights {
  const w: CatWeights = {};
  for (const c of targets) w[c] = TARGET_WEIGHT;
  for (const c of punts) w[c] = 0;
  return w;
}

/** Expected categories won by A against B (ties count half), each category scaled by its weight. */
function weightedCats(a: Agg, b: Agg, cats: CatId[], weights: CatWeights): number {
  let s = 0;
  for (const c of cats) {
    const w = weights[c] ?? 1;
    if (!w) continue;
    const def = CATEGORIES[c];
    const o = catOdds(catDist(a, def), catDist(b, def), def);
    s += w * (o.win + 0.5 * o.tie);
  }
  return s;
}

function powerOf(agg: Agg, others: Agg[], cats: CatId[], weights: CatWeights = {}): number {
  if (!others.length) return 0;
  return others.reduce((s, o) => s + weightedCats(agg, o, cats, weights), 0) / others.length;
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
  /** Targeted offers only: whether the other team keeps its value (loses less than FAIR_LOSS). */
  fair?: boolean;
}

/** A trade is realistic when the other team gives up less than this many expected categories a week. */
const FAIR_LOSS = -0.1;
/** Ranks trades that help me without costing the other team much. */
const tradeScore = (t: TradeIdea) => t.myDelta + 0.5 * t.theirDelta;
/** Order for targeted offers: ones the other team shouldn't mind first, then best for both sides. */
const byOffer = (a: TradeIdea, b: TradeIdea) => Number(b.fair) - Number(a.fair) || tradeScore(b) - tradeScore(a);
/** Players ruled out go to an IL slot; offering them in trades or dropping them isn't realistic advice. */
const tradeable = (ctx: EngineCtx, p: PlayerData) => availability(ctx, p) > 0;

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
 * Scores moves for my team: trades (both teams re-rated against the rest of the league) and free-agent add/drops.
 * `weights` tilt my side toward a category strategy; the other team is always judged on every category.
 */
function moveScorer(ctx: EngineCtx, rosters: PlayerData[][], myIdx: number, cats: CatId[], basis: Basis, weights: CatWeights) {
  const pAgg = new Map<string, Agg>();
  const aggOf = (p: PlayerData) => {
    if (!pAgg.has(p.id)) pAgg.set(p.id, playerWeekAgg(ctx, p, basis));
    return pAgg.get(p.id)!;
  };
  const teamAggs = rosters.map((r) => r.reduce((acc, p) => addAgg(acc, aggOf(p)), emptyAgg()));
  const myAgg = teamAggs[myIdx];
  const othersOf = (idx: number, replace?: Map<number, Agg>) =>
    teamAggs.map((a, j) => replace?.get(j) ?? a).filter((_, j) => j !== idx);
  const others = othersOf(myIdx);
  const myPower = powerOf(myAgg, others, cats, weights);
  const basePower = teamAggs.map((a, i) => powerOf(a, othersOf(i), cats));

  const swap = (base: Agg, out: PlayerData[], inn: PlayerData[]) => {
    const a = cloneAgg(base);
    out.forEach((p) => addAgg(a, aggOf(p), -1));
    inn.forEach((p) => addAgg(a, aggOf(p), 1));
    return a;
  };

  const trade = (partner: number, give: PlayerData[], get: PlayerData[]): TradeIdea => {
    const newMine = swap(myAgg, give, get);
    const newTheirs = swap(teamAggs[partner], get, give);
    const mineOthers = othersOf(myIdx, new Map([[partner, newTheirs]]));
    const theirOthers = othersOf(partner, new Map([[myIdx, newMine]]));
    return {
      give: give.map((p) => p.id),
      get: get.map((p) => p.id),
      partner,
      myDelta: powerOf(newMine, mineOthers, cats, weights) - myPower,
      theirDelta: powerOf(newTheirs, theirOthers, cats) - basePower[partner],
      catDelta: {},
    };
  };

  const pickup = (drop: PlayerData, add: PlayerData): TradeIdea => {
    const newMine = swap(myAgg, [drop], [add]);
    return { give: [drop.id], get: [add.id], partner: -1, myDelta: powerOf(newMine, others, cats, weights) - myPower, theirDelta: 0, catDelta: {} };
  };

  /** Fill in the per-category change of an idea worth showing. */
  const withBreakdown = (t: TradeIdea): TradeIdea => {
    const give = t.give.map((id) => ctx.byId.get(id)!);
    const get = t.get.map((id) => ctx.byId.get(id)!);
    return { ...t, catDelta: catBreakdown(myAgg, swap(myAgg, give, get), others, cats) };
  };

  return { trade, pickup, withBreakdown };
}

/**
 * Trade and pickup finder. For every 1-for-1 swap (and 2-for-2 swaps among the
 * most promising players) it recomputes both teams' expected categories won
 * against the rest of the league. Free agents are evaluated as add/drop pairs.
 * `weights` tilt my side of the scoring toward a category strategy; the other
 * team is always judged on every category.
 */
export function findTrades(
  ctx: EngineCtx,
  rosters: PlayerData[][],
  myIdx: number,
  freeAgents: PlayerData[],
  cats: CatId[],
  basis: Basis,
  opts: { maxResults?: number; twoForTwo?: boolean; weights?: CatWeights } = {},
): { trades: TradeIdea[]; pickups: TradeIdea[]; targets: (TradeIdea & { target: string })[] } {
  const { maxResults = 30, twoForTwo = true, weights = {} } = opts;
  const { trade, pickup, withBreakdown } = moveScorer(ctx, rosters, myIdx, cats, basis, weights);
  const myGive = rosters[myIdx].filter((p) => tradeable(ctx, p));

  const trades: TradeIdea[] = [];
  const bestTarget = new Map<string, TradeIdea & { target: string }>();
  const consider = (t: TradeIdea, target: PlayerData) => {
    const prev = bestTarget.get(target.id);
    if (!prev || t.myDelta > prev.myDelta) bestTarget.set(target.id, { ...t, target: target.id });
  };

  rosters.forEach((roster, partner) => {
    if (partner === myIdx) return;
    const singles: TradeIdea[] = [];
    for (const m of myGive) for (const o of roster.filter((p) => tradeable(ctx, p))) {
      const t = trade(partner, [m], [o]);
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
        trades.push(trade(partner, [myGive[a], myGive[b]], [theirs[c], theirs[d]]));
  });

  const pickups: TradeIdea[] = [];
  for (const fa of freeAgents.filter((p) => tradeable(ctx, p))) for (const m of myGive) {
    const t = pickup(m, fa);
    pickups.push(t);
    consider(t, fa);
  }

  // Realistic trades: I gain and the partner doesn't lose much.
  const fair = trades
    .filter((t) => t.myDelta > 0.02 && t.theirDelta > FAIR_LOSS)
    .sort((a, b) => tradeScore(b) - tradeScore(a))
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

/**
 * Offers for one player. If another team has him: every 1-for-1 swap, and every 2-for-2 where he comes along with a
 * teammate. Offers his team shouldn't mind (losing less than FAIR_LOSS) come first, best for both sides first, with
 * one offer per package of mine so the options differ, and always the best 1-for-1. A free agent gets the best drops to
 * make room instead. No offers when he's already on my team.
 */
export function offersFor(
  ctx: EngineCtx,
  rosters: PlayerData[][],
  myIdx: number,
  target: PlayerData,
  cats: CatId[],
  basis: Basis,
  opts: { maxResults?: number; weights?: CatWeights } = {},
): { partner: number; offers: TradeIdea[] } {
  const { maxResults = 5, weights = {} } = opts;
  const partner = rosters.findIndex((r) => r.some((p) => p.id === target.id));
  if (partner === myIdx) return { partner, offers: [] };
  const { trade, pickup, withBreakdown } = moveScorer(ctx, rosters, myIdx, cats, basis, weights);
  const myGive = rosters[myIdx].filter((p) => tradeable(ctx, p));
  if (partner < 0) {
    const drops = myGive.map((m) => pickup(m, target)).sort((a, b) => b.myDelta - a.myDelta);
    return { partner, offers: drops.slice(0, maxResults).map(withBreakdown) };
  }

  const mates = rosters[partner].filter((p) => p.id !== target.id && tradeable(ctx, p));
  const all = myGive.map((m) => trade(partner, [m], [target]));
  for (let a = 0; a < myGive.length; a++) for (let b = a + 1; b < myGive.length; b++)
    for (const o of mates) all.push(trade(partner, [myGive[a], myGive[b]], [target, o]));
  for (const t of all) t.fair = t.theirDelta > FAIR_LOSS;
  all.sort(byOffer);
  const seen = new Set<string>();
  const offers = all.filter((t) => {
    const key = [...t.give].sort().join();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const top = offers.slice(0, maxResults);
  // There are far more 2-for-2 packages than 1-for-1 swaps; keep the best simple swap in the list.
  const single = offers.find((t) => t.give.length === 1);
  if (single && !top.includes(single)) top.splice(maxResults - 1, 1, single);
  return { partner, offers: top.map(withBreakdown) };
}

/** Every way to pick `k` items from `items`, in order. */
function* combinations<T>(items: T[], k: number, start = 0): Generator<T[]> {
  if (k === 0) {
    yield [];
    return;
  }
  for (let i = start; i <= items.length - k; i++) for (const rest of combinations(items, k - 1, i + 1)) yield [items[i], ...rest];
}

/**
 * Offers for players of mine I want to move: every team's best package of as many of its players, one offer per team
 * so the list shows who'd pay most. Ordered like offersFor. Players not on my roster are ignored.
 */
export function offersAway(
  ctx: EngineCtx,
  rosters: PlayerData[][],
  myIdx: number,
  give: PlayerData[],
  cats: CatId[],
  basis: Basis,
  opts: { maxResults?: number; weights?: CatWeights } = {},
): TradeIdea[] {
  const { maxResults = 5, weights = {} } = opts;
  const out = give.filter((p) => rosters[myIdx].some((q) => q.id === p.id));
  if (!out.length) return [];
  const { trade, withBreakdown } = moveScorer(ctx, rosters, myIdx, cats, basis, weights);
  const best: TradeIdea[] = [];
  rosters.forEach((roster, partner) => {
    if (partner === myIdx) return;
    let top: TradeIdea | undefined;
    for (const get of combinations(roster.filter((p) => tradeable(ctx, p)), out.length)) {
      const t = trade(partner, out, get);
      t.fair = t.theirDelta > FAIR_LOSS;
      if (!top || byOffer(t, top) < 0) top = t;
    }
    if (top) best.push(top);
  });
  return best.sort(byOffer).slice(0, maxResults).map(withBreakdown);
}
