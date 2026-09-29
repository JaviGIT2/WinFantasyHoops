import type { PlayerData, Role } from '../data/types';
import { memo, type EngineCtx } from './context';
import { MODEL_STATS, perGame, type ModelStat, type SeasonLine, type StatLine, zeroLine } from './stats';

/**
 * Season-level projections: per-minute production rates, expected minutes and
 * games, built by shrinking each season's sample toward a prior:
 *
 *   positional average → 2 seasons ago → last season (+ aging) → current season
 *
 * Each step is a Bayesian blend `(sample + K·prior) / (minutes + K)`, so a
 * 60-game season dominates while a 3-game start barely moves the estimate.
 */

/**
 * Typical year-over-year change for a player entering a season at `age`.
 * Deliberately conservative; production rates and minutes are adjusted separately.
 */
export function ageFactor(age: number, stat: ModelStat | 'min'): number {
  if (!age) return 1;
  if (stat === 'min') {
    if (age <= 23) return 1.05;
    if (age <= 25) return 1.02;
    if (age <= 29) return 1;
    if (age <= 31) return 0.98;
    if (age <= 33) return 0.96;
    return 0.93;
  }
  let d =
    age <= 21 ? 0.06 : age === 22 ? 0.045 : age === 23 ? 0.035 : age === 24 ? 0.025 : age === 25 ? 0.015 :
    age <= 28 ? 0 : age === 29 ? -0.01 : age === 30 ? -0.02 : age === 31 ? -0.03 : age === 32 ? -0.035 : -0.045;
  if ((stat === 'stl' || stat === 'blk') && age >= 27) d -= 0.01; // defensive stats age earlier
  if ((stat === 'tpm' || stat === 'tpa') && age <= 27) d += 0.01; // shooting range keeps developing
  return 1 + d;
}

export function roleOf(ctx: EngineCtx, p: PlayerData): Role {
  const o = ctx.overrides[p.id]?.role;
  if (o) return o;
  const s = p.cur && p.cur.gp >= 5 ? p.cur : p.last ?? p.prev;
  return s && s.gp > 0 && s.gs / s.gp >= 0.5 ? 'S' : 'B';
}

const hasMinutes = (s?: SeasonLine) => !!s && s.min > 0;

export interface PlayerRates {
  /** Per-minute rates in MODEL_STATS order. */
  rates: number[];
  /** Expected minutes per game before game-specific context. */
  min: number;
  role: Role;
  /** No NBA minutes at all: projections come from positional baselines. */
  noData: boolean;
}

function blend(line: SeasonLine | undefined, prior: number[], K: number): number[] {
  if (!line || line.min <= 0) return prior;
  return MODEL_STATS.map((s, i) => (line[s] + K * prior[i]) / (line.min + K));
}

export function playerRates(ctx: EngineCtx, p: PlayerData): PlayerRates {
  return memo(ctx, `rates:${p.id}`, () => {
    const { model } = ctx.data;
    const K = model.rateShrinkMinutes;
    const role = roleOf(ctx, p);
    const pos = model.posRates[p.pos][role];
    const noData = !hasMinutes(p.cur) && !hasMinutes(p.last) && !hasMinutes(p.prev);

    // Rates: positional prior → prev → last, aged one year → current season.
    const prevR = blend(p.prev, pos.rates, K);
    const lastR = blend(p.last, prevR, K);
    const ageAdj = hasMinutes(p.last) || hasMinutes(p.prev);
    const base = ageAdj ? lastR.map((r, i) => r * ageFactor(p.age, MODEL_STATS[i])) : lastR;
    const rates = blend(p.cur, base, K);

    // Minutes per game follow the same idea with games as the unit.
    const mpg = (s?: SeasonLine) => (s && s.gp > 0 ? s.min / s.gp : undefined);
    const prevM = mpg(p.prev);
    const lastM = mpg(p.last);
    let hist: number;
    if (p.last && p.last.gp > 0) {
      const prior = prevM ?? lastM!;
      hist = (p.last.min + 8 * prior) / (p.last.gp + 8);
    } else if (prevM !== undefined) hist = prevM;
    // No NBA history: rookies get a bench role by default; unknown veterans are usually deep bench.
    else hist = role === 'S' ? 28 : p.twoWay ? 6 : p.rookie ? 16 : 8;
    if (ageAdj) hist *= ageFactor(p.age, 'min');
    let min = p.cur && p.cur.gp > 0 ? (p.cur.min + 6 * hist) / (p.cur.gp + 6) : hist;
    const override = ctx.overrides[p.id]?.min;
    if (override !== undefined) min = override;

    return { rates, min: Math.max(0, Math.min(44, min)), role, noData };
  });
}

/** Probability of playing a given game, after injury notes and manual overrides. */
export function availability(ctx: EngineCtx, p: PlayerData): number {
  const o = ctx.overrides[p.id];
  if (o?.status === 'out') return 0;
  if (o?.avail !== undefined) return o.avail;
  if (o?.status !== 'healthy' && p.injury?.status === 'out') return 0;
  return p.avail;
}

export interface SeasonProjection {
  perGame: StatLine;
  gp: number;
  totals: StatLine;
}

/** Remaining regular-season games for a team strictly after `today`. */
function remainingTeamGames(ctx: EngineCtx, team: string) {
  return (ctx.sched.byTeam.get(team) ?? []).filter((g) => g.date > ctx.today).length;
}

/** Projection for the current season: games to date plus expected remaining games. */
export function seasonProjection(ctx: EngineCtx, p: PlayerData): SeasonProjection {
  return memo(ctx, `proj:${p.id}`, () => {
    const r = playerRates(ctx, p);
    const pg = zeroLine();
    pg.min = r.min;
    MODEL_STATS.forEach((s, i) => (pg[s] = r.rates[i] * r.min));
    const remaining = remainingTeamGames(ctx, p.team) || (p.cur ? 0 : 82);
    const gp = (p.cur?.gp ?? 0) + remaining * availability(ctx, p);
    const totals = zeroLine();
    for (const k of Object.keys(pg) as (keyof StatLine)[]) {
      // Totals = actual stats so far + projected per-game × projected remaining games.
      totals[k] = (p.cur?.[k] ?? 0) + pg[k] * (gp - (p.cur?.gp ?? 0));
    }
    return { perGame: pg, gp, totals };
  });
}

export type Basis = 'last' | 'proj' | 'cur';

/**
 * Per-game line for a basis:
 * - last: last season's actual averages
 * - proj: current-season projection (blended, aged)
 * - cur:  current-season averages once a player has `minGames`, otherwise last season
 */
export function perGameFor(ctx: EngineCtx, p: PlayerData, basis: Basis, minGames = 5): StatLine {
  if (basis === 'last') return perGame(p.last);
  if (basis === 'cur') {
    if (p.cur && p.cur.gp >= minGames) return perGame(p.cur);
    if (p.last && p.last.gp > 0) return perGame(p.last);
  }
  return seasonProjection(ctx, p).perGame;
}

export function totalsFor(ctx: EngineCtx, p: PlayerData, basis: Basis): StatLine {
  if (basis === 'last') return p.last ? { ...p.last } : zeroLine();
  if (basis === 'cur' && p.cur) return { ...p.cur };
  return seasonProjection(ctx, p).totals;
}
