import type { GbmTree, ModelData, PlayerData } from '../data/types';
import { memo, type EngineCtx } from './context';
import { dot } from './glm';
import { availability, playerRates } from './projection';
import type { TeamGame } from './schedule';
import { MODEL_STATS } from './stats';

/**
 * Per-game stat prediction for one player in one scheduled game.
 *
 *   minutes  = minutes model(baseline minutes, recent minutes, back-to-back, home)
 *   E[stat]  = usual minutes × per-minute rate
 *              × exp(β · [1, dvp, pace, h2h, home, b2b, log(minutes / usual minutes)])
 *
 * where dvp is the opponent's opponent-adjusted defense vs. the player's position,
 * pace the expected game pace relative to the player's own team, and h2h the
 * player's shrunk over/under-performance against this specific opponent in past
 * seasons. Players with no NBA minutes get the opponent's positional allowance
 * instead (e.g. what the Bulls allowed to starting point guards), scaled to their
 * expected minutes.
 */
export interface GameProjection {
  date: string;
  opp: string;
  home: boolean;
  b2b: boolean;
  /** Expected minutes if he plays. */
  min: number;
  /** Probability he plays (1 for completed games with a box score). */
  avail: number;
  /** Mean line if he plays, MODEL_STATS order. */
  mean: number[];
  /** Per-game variance if he plays, MODEL_STATS order. */
  var: number[];
  source: 'model' | 'positional' | 'actual' | 'dnp';
  factors?: { dvp: number[]; pace: number; h2h?: number[]; h2hGames: number; minRatio: number };
}

const IDX = Object.fromEntries(MODEL_STATS.map((s, i) => [s, i])) as Record<(typeof MODEL_STATS)[number], number>;
export const statIndex = IDX;

/** Sum of a flattened LightGBM tree ensemble's outputs for one feature vector. */
export function evalTrees(trees: GbmTree[], x: number[]): number {
  let sum = 0;
  for (const tree of trees) {
    if (!tree.f.length) {
      sum += tree.v[0];
      continue;
    }
    let node = 0;
    while (node >= 0) node = x[tree.f[node]] <= tree.t[node] ? tree.l[node] : tree.r[node];
    sum += tree.v[~node];
  }
  return sum;
}

/**
 * Log-multiplier the model applies on top of a player's baseline for one stat, given the
 * matchup features [dvp, pace, h2h, home, b2b, minRatio]: GBM trees if that stat's
 * boosted model won the holdout, otherwise the GLM.
 */
export function modelLogMultiplier(model: ModelData, stat: (typeof MODEL_STATS)[number], features: number[]): number {
  const trees = model.gbm?.[stat]?.trees;
  if (trees) return evalTrees(trees, features);
  return dot(model.coef[stat], [1, ...features]);
}

export function expectedMinutes(ctx: EngineCtx, p: PlayerData, game: Pick<TeamGame, 'home' | 'b2b'>): number {
  const r = playerRates(ctx, p);
  if (ctx.overrides[p.id]?.min !== undefined || r.noData) return r.min * (game.b2b ? 0.97 : 1);
  const m = ctx.data.model.minutes;
  const recent = p.recentMin ?? r.min;
  const x = [1, r.min, recent, game.b2b ? 1 : 0, game.home ? 1 : 0];
  return Math.max(0, Math.min(44, dot(m.coef, x)));
}

function actualGame(ctx: EngineCtx, p: PlayerData, date: string): number[] | null | undefined {
  const through = ctx.data.meta.dataThrough;
  if (!through || date > through || date > ctx.today) return undefined; // not final yet
  const logs = memo(ctx, `logs:${p.id}`, () => {
    const m = new Map<string, number[]>();
    for (const row of ctx.data.curLogs[p.id] ?? []) m.set(row[0] as string, row.slice(2) as number[]);
    return m;
  });
  return logs.get(date) ?? null; // null = team played, he didn't
}

export function predictGame(ctx: EngineCtx, p: PlayerData, game: TeamGame): GameProjection {
  return memo(ctx, `game:${p.id}:${game.date}`, () => {
    const base = { date: game.date, opp: game.opp, home: game.home, b2b: game.b2b };
    const actual = actualGame(ctx, p, game.date);
    if (actual === null) {
      return { ...base, min: 0, avail: 0, mean: MODEL_STATS.map(() => 0), var: MODEL_STATS.map(() => 0), source: 'dnp' };
    }
    if (actual) {
      return { ...base, min: actual[0], avail: 1, mean: actual.slice(1), var: MODEL_STATS.map(() => 0), source: 'actual' };
    }

    const { model, teams } = ctx.data;
    const r = playerRates(ctx, p);
    const min = expectedMinutes(ctx, p, game);
    const avail = availability(ctx, p);
    const opp = teams[game.opp];

    if (r.noData && opp) {
      const allowed = opp.allowed[p.pos][r.role];
      const scale = allowed[0] > 0 ? min / allowed[0] : 0;
      const mean = MODEL_STATS.map((_, i) => allowed[i + 1] * scale);
      return {
        ...base, min, avail, mean,
        var: mean.map((m, i) => model.phi[MODEL_STATS[i]] * m),
        source: 'positional',
      };
    }

    const own = teams[p.team];
    const pace = own && opp ? Math.log((own.pace + opp.pace) / (2 * own.pace)) : 0;
    const dvp = opp ? opp.dvp[p.pos] : MODEL_STATS.map(() => 0);
    const h2hRow = ctx.data.h2h[p.id]?.[game.opp];
    const h2h = h2hRow?.slice(1);
    const usual = Math.max(r.min, 1);
    const minRatio = Math.log(Math.max(min, 0.5) / usual);
    const mean = MODEL_STATS.map((s, i) => {
      const x = [dvp[i], pace, h2h?.[i] ?? 0, game.home ? 1 : 0, game.b2b ? 1 : 0, minRatio];
      return usual * r.rates[i] * Math.exp(modelLogMultiplier(model, s, x));
    });
    return {
      ...base, min, avail, mean,
      var: mean.map((m, i) => model.phi[MODEL_STATS[i]] * m),
      source: 'model',
      factors: { dvp, pace, h2h, h2hGames: h2hRow?.[0] ?? 0, minRatio },
    };
  });
}

/**
 * Effect of one matchup factor on a projected stat, as a fraction (+0.05 = 5% more):
 * the model's prediction with the factor as-is vs. with it neutral, other factors fixed.
 */
export function factorEffect(model: ModelData, g: GameProjection, stat: (typeof MODEL_STATS)[number], factor: 'dvp' | 'h2h'): number {
  const f = g.factors;
  if (!f) return 0;
  const i = IDX[stat];
  const x = [f.dvp[i], f.pace, f.h2h?.[i] ?? 0, g.home ? 1 : 0, g.b2b ? 1 : 0, f.minRatio];
  const neutral = [...x];
  neutral[factor === 'dvp' ? 0 : 2] = 0;
  return Math.exp(modelLogMultiplier(model, stat, x) - modelLogMultiplier(model, stat, neutral)) - 1;
}

/** Expected contribution of a game after accounting for the chance he sits. */
export function expectedContribution(g: GameProjection): { mean: number[]; var: number[]; pend: number[] } {
  const a = g.avail;
  const mean = g.mean.map((m) => a * m);
  const final = g.source === 'actual' || g.source === 'dnp';
  return {
    mean,
    // Mixture of "plays" (mean m, var v) and "sits" (0): a(v + m²) − (a·m)².
    var: g.mean.map((m, i) => a * (g.var[i] + m * m) - (a * m) ** 2),
    pend: final ? mean.map(() => 0) : mean,
  };
}
