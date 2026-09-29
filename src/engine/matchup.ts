import type { ModelData, PlayerData } from '../data/types';
import { CATEGORIES, type CatDef, type CatId } from './categories';
import { eligOf, type EngineCtx } from './context';
import { bestLineup, type Slot } from './lineup';
import { expectedContribution, predictGame, statIndex, type GameProjection } from './model';
import { normCdf, safeSqrt } from './mathx';
import { teamGameOn } from './schedule';
import { MODEL_STATS } from './stats';

/**
 * Additive weekly aggregate of MODEL_STATS: expected totals, their variances, and
 * the part of the expected totals still to be played (`pend`; 0 for final games).
 */
export interface Agg {
  mean: number[];
  var: number[];
  pend: number[];
}

export const emptyAgg = (): Agg => ({
  mean: MODEL_STATS.map(() => 0),
  var: MODEL_STATS.map(() => 0),
  pend: MODEL_STATS.map(() => 0),
});

export function addAgg(target: Agg, src: Agg, k = 1): Agg {
  for (let i = 0; i < target.mean.length; i++) {
    target.mean[i] += k * src.mean[i];
    target.var[i] += k * src.var[i];
    target.pend[i] += k * src.pend[i];
  }
  return target;
}

export const cloneAgg = (a: Agg): Agg => ({ mean: [...a.mean], var: [...a.var], pend: [...a.pend] });

export interface CatDist {
  mean: number;
  sd: number;
}

/** Distribution of a category's weekly result from a team aggregate. */
export function catDist(agg: Agg, cat: CatDef): CatDist {
  if (cat.kind === 'count') {
    const i = statIndex[cat.stat as keyof typeof statIndex];
    return { mean: agg.mean[i], sd: safeSqrt(agg.var[i]) };
  }
  const n = agg.mean[statIndex[cat.num as keyof typeof statIndex]];
  const d = agg.mean[statIndex[cat.den as keyof typeof statIndex]];
  if (d <= 0) return { mean: 0, sd: 0 };
  const r = n / d;
  if (cat.id === 'A/T') {
    const vn = agg.var[statIndex.ast];
    const vd = agg.var[statIndex.to];
    return { mean: r, sd: safeSqrt(vn + r * r * vd) / d };
  }
  // Shooting percentages: binomial noise on the attempts still to come, with mild overdispersion.
  const remaining = agg.pend[statIndex[cat.den as keyof typeof statIndex]];
  return { mean: r, sd: safeSqrt(r * (1 - r) * 1.15 * remaining) / d };
}

export interface CatOdds {
  win: number;
  tie: number;
  loss: number;
}

/** Probability that team A wins/ties/loses a category against team B (normal approximation). */
export function catOdds(a: CatDist, b: CatDist, cat: CatDef): CatOdds {
  const d = a.mean - b.mean;
  const s = Math.max(Math.hypot(a.sd, b.sd), 1e-6);
  let win: number;
  let loss: number;
  if (cat.kind === 'count') {
    // Integer totals: a difference within ±0.5 is a tie.
    win = 1 - normCdf((0.5 - d) / s);
    loss = normCdf((-0.5 - d) / s);
    if (s < 1e-3) {
      win = d > 0.25 ? 1 : 0;
      loss = d < -0.25 ? 1 : 0;
    }
  } else {
    win = normCdf(d / s);
    loss = 1 - win;
    if (s < 1e-6) {
      win = d > 1e-9 ? 1 : 0;
      loss = d < -1e-9 ? 1 : 0;
    }
  }
  const tie = Math.max(0, 1 - win - loss);
  return cat.lowerIsBetter ? { win: loss, tie, loss: win } : { win, tie, loss };
}

export interface MatchupOdds {
  win: number;
  tie: number;
  loss: number;
  expWins: number;
  expTies: number;
  expLosses: number;
}

/**
 * Exact head-to-head matchup odds from independent category odds: dynamic
 * programming over the distribution of (categories won − categories lost).
 */
export function matchupOdds(odds: CatOdds[]): MatchupOdds {
  const n = odds.length;
  let dist = new Array(2 * n + 1).fill(0);
  dist[n] = 1;
  for (const o of odds) {
    const next = new Array(2 * n + 1).fill(0);
    for (let k = 0; k < dist.length; k++) {
      if (!dist[k]) continue;
      if (k + 1 < next.length) next[k + 1] += dist[k] * o.win;
      next[k] += dist[k] * o.tie;
      if (k > 0) next[k - 1] += dist[k] * o.loss;
    }
    dist = next;
  }
  let win = 0;
  let loss = 0;
  dist.forEach((p, k) => {
    if (k > n) win += p;
    else if (k < n) loss += p;
  });
  return {
    win,
    loss,
    tie: Math.max(0, 1 - win - loss),
    expWins: odds.reduce((s, o) => s + o.win, 0),
    expTies: odds.reduce((s, o) => s + o.tie, 0),
    expLosses: odds.reduce((s, o) => s + o.loss, 0),
  };
}

export function compareAggs(a: Agg, b: Agg, cats: CatId[]) {
  const perCat = cats.map((c) => {
    const def = CATEGORIES[c];
    const da = catDist(a, def);
    const db = catDist(b, def);
    return { cat: c, a: da, b: db, odds: catOdds(da, db, def) };
  });
  return { perCat, odds: matchupOdds(perCat.map((p) => p.odds)) };
}

/**
 * Per-stat weights that turn a stat line into one fantasy value for a set of
 * categories: counting stats are scaled by their per-game spread, shooting
 * percentages use volume-weighted impact (makes − league% × attempts), turnovers
 * count against. Used to decide who starts when more players have games than slots.
 */
export function valueWeights(model: ModelData, cats: CatId[], catWeight: Partial<Record<CatId, number>> = {}): number[] {
  const w = MODEL_STATS.map(() => 0);
  for (const c of cats) {
    const def = CATEGORIES[c];
    const k = catWeight[c] ?? 1;
    if (!k) continue;
    if (def.kind === 'count') {
      const i = statIndex[def.stat as keyof typeof statIndex];
      w[i] += ((def.lowerIsBetter ? -1 : 1) * k) / model.statSd[def.stat as keyof typeof model.statSd];
    } else {
      const r = model.ratio[c as keyof ModelData['ratio']];
      w[statIndex[def.num as keyof typeof statIndex]] += k / r.sd;
      w[statIndex[def.den as keyof typeof statIndex]] -= (k * r.ref) / r.sd;
    }
  }
  return w;
}

export const lineValue = (mean: number[], w: number[]) => mean.reduce((s, m, i) => s + m * w[i], 0);

export interface PlayerWeek {
  id: string;
  games: (GameProjection & { started: boolean })[];
  agg: Agg;
}

export interface TeamWeek {
  agg: Agg;
  players: PlayerWeek[];
  days: { date: string; started: string[]; benched: string[] }[];
  /** Games that count after daily lineup limits. */
  starts: number;
}

/**
 * Project a roster over a set of days: predict every scheduled game, set the
 * best legal lineup each day (players beyond the active slots sit), and sum the
 * expected stats of started games.
 */
export function projectWeek(
  ctx: EngineCtx,
  roster: PlayerData[],
  days: string[],
  slots: Slot[],
  weights: number[],
  opts: { joinDate?: Record<string, string>; leaveDate?: Record<string, string> } = {},
): TeamWeek {
  const agg = emptyAgg();
  const players = new Map<string, PlayerWeek>(roster.map((p) => [p.id, { id: p.id, games: [], agg: emptyAgg() }]));
  const outDays: TeamWeek['days'] = [];
  let starts = 0;
  for (const date of days) {
    const candidates: { id: string; elig: PlayerData['elig']; value: number; g: GameProjection }[] = [];
    for (const p of roster) {
      if (opts.joinDate?.[p.id] && date < opts.joinDate[p.id]) continue;
      if (opts.leaveDate?.[p.id] && date >= opts.leaveDate[p.id]) continue;
      const tg = teamGameOn(ctx.sched, p.team, date);
      if (!tg) continue;
      const g = predictGame(ctx, p, tg);
      if (g.avail <= 0) {
        players.get(p.id)!.games.push({ ...g, started: false });
        continue;
      }
      const c = expectedContribution(g);
      candidates.push({ id: p.id, elig: eligOf(ctx, p), value: Math.max(0.01, 6 + lineValue(c.mean, weights)), g });
    }
    const lineup = bestLineup(candidates, slots);
    const startedSet = new Set(lineup.started);
    for (const c of candidates) {
      const started = startedSet.has(c.id);
      const pw = players.get(c.id)!;
      pw.games.push({ ...c.g, started });
      if (!started) continue;
      const contrib = expectedContribution(c.g);
      addAgg(agg, contrib);
      addAgg(pw.agg, contrib);
      starts += c.g.avail;
    }
    outDays.push({ date, started: lineup.started, benched: lineup.benched });
  }
  return { agg, players: [...players.values()], days: outDays, starts };
}
