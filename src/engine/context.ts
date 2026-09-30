import type { DataBundle, PlayerData, Pos, Role } from '../data/types';
import { buildScheduleIndex, type ScheduleIndex } from './schedule';

/** Per-player manual adjustments made in the app. */
export interface PlayerOverride {
  /** Expected minutes per game (e.g. for rookies or players returning from injury). */
  min?: number;
  role?: Role;
  /** Probability of playing each game, 0–1. */
  avail?: number;
  /** Force the player out (0 games) or healthy (ignore injury note). */
  status?: 'out' | 'healthy';
  elig?: Pos[];
}

export interface EngineCtx {
  data: DataBundle;
  byId: Map<string, PlayerData>;
  sched: ScheduleIndex;
  overrides: Record<string, PlayerOverride>;
  /** Games on or before this date use actual box scores when available. */
  today: string;
  /** Memo for derived per-player values; invalidated by rebuilding the context. */
  cache: Map<string, unknown>;
}

export function createContext(
  data: DataBundle,
  overrides: Record<string, PlayerOverride> = {},
  today = new Date().toISOString().slice(0, 10),
): EngineCtx {
  return {
    data,
    byId: new Map(data.players.map((p) => [p.id, p])),
    sched: buildScheduleIndex(data.schedule),
    overrides,
    today,
    cache: new Map(),
  };
}

export function memo<T>(ctx: EngineCtx, key: string, fn: () => T): T {
  if (ctx.cache.has(key)) return ctx.cache.get(key) as T;
  const v = fn();
  ctx.cache.set(key, v);
  return v;
}

export const eligOf = (ctx: EngineCtx, p: PlayerData): Pos[] => ctx.overrides[p.id]?.elig ?? p.elig;

/** Out injured: marked out in the app, or listed out and not marked healthy. */
export function isOut(ctx: EngineCtx, p: PlayerData): boolean {
  const status = ctx.overrides[p.id]?.status;
  return status === 'out' || (status !== 'healthy' && p.injury?.status === 'out');
}
