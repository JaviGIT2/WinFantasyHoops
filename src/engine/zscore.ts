import { CATEGORIES, type CatId } from './categories';
import { normCdf } from './mathx';
import type { StatLine } from './stats';

/**
 * Player valuation: z-scores per category against the entire league (every player
 * with minutes on the chosen basis). Shooting percentages use volume-weighted impact
 * (makes − league% × attempts), so a 60% shooter on 3 attempts isn't treated like one
 * on 15; turnovers count negatively.
 */
export interface ZRow {
  id: string;
  z: Record<string, number>;
  total: number;
  /** The stat line the z-scores were computed from (for showing raw numbers). */
  line: StatLine;
}

export interface ZResult {
  rows: Map<string, ZRow>;
  /** League mean and SD of each category's raw value (or impact); `ref` is the league shooting %. */
  norms: Record<string, { mean: number; sd: number; ref?: number }>;
  /** Players with minutes, i.e. the population the z-scores are measured against. */
  leagueSize: number;
  /** Mean and SD of each category's z-score among the draftable pool (reference for team strength). */
  draftable: Record<string, { mean: number; sd: number }>;
  draftableSize: number;
}

function raw(line: StatLine, cat: CatId, ref: number): number {
  const d = CATEGORIES[cat];
  if (d.kind === 'count') return line[d.stat!];
  return line[d.num!] - ref * line[d.den!];
}

const meanSd = (vals: number[]) => {
  const mean = vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length);
  const sd = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, vals.length - 1)) || 1;
  return { mean, sd };
};

/**
 * @param draftableSize teams × roster size: only used to describe a typical drafted team
 *   for `teamStrength`, never to normalize player values.
 */
export function computeZ(
  players: { id: string; line: StatLine }[],
  cats: CatId[],
  draftableSize: number,
  punts: CatId[] = [],
): ZResult {
  const league = players.filter((p) => p.line.min > 0);
  const norms: ZResult['norms'] = {};
  for (const c of cats) {
    const d = CATEGORIES[c];
    let ref = 0;
    if (d.kind === 'ratio') {
      const num = league.reduce((s, p) => s + p.line[d.num!], 0);
      const den = league.reduce((s, p) => s + p.line[d.den!], 0);
      ref = den > 0 ? num / den : 0;
    }
    norms[c] = { ...meanSd(league.map((p) => raw(p.line, c, ref))), ref };
  }

  const rows = new Map<string, ZRow>();
  for (const p of players) rows.set(p.id, { id: p.id, ...zOf(p.line, cats, norms, punts), line: p.line });

  const pool = league.map((p) => rows.get(p.id)!).sort((a, b) => b.total - a.total).slice(0, draftableSize);
  const draftable = Object.fromEntries(cats.map((c) => [c, meanSd(pool.map((r) => r.z[c]))]));
  return { rows, norms, leagueSize: league.length, draftable, draftableSize: pool.length };
}

/** A stat line's z-scores against league norms from `computeZ`; the total leaves out punted categories. */
export function zOf(line: StatLine, cats: CatId[], norms: ZResult['norms'], punts: CatId[] = []): { z: Record<string, number>; total: number } {
  const z: Record<string, number> = {};
  let total = 0;
  for (const c of cats) {
    const n = norms[c];
    let v = (raw(line, c, n.ref ?? 0) - n.mean) / n.sd;
    if (CATEGORIES[c].lowerIsBetter) v = -v;
    z[c] = v;
    if (!punts.includes(c)) total += v;
  }
  return { z, total };
}

/**
 * A player's ranking value under category multipliers: each category's z-score times
 * its weight (1 = normal, 0.25 = counts a quarter as much, 0 = ignored).
 */
export function weightedValue(row: ZRow | undefined, cats: CatId[], weight: (c: CatId) => number): number {
  if (!row) return 0;
  return cats.reduce((s, c) => s + weight(c) * (row.z[c] ?? 0), 0);
}

/**
 * Team strength per category on a 0–100 scale: the percentile of the team's summed
 * z-score against a team of the same size drawn at random from the draftable pool.
 * 50 = a typical drafted team (not a typical NBA roster, which every fantasy team beats).
 */
export function teamStrength(z: ZResult, ids: string[], cats: CatId[]): Record<string, number> {
  const out: Record<string, number> = {};
  const k = ids.length;
  for (const c of cats) {
    if (!k) {
      out[c] = 50;
      continue;
    }
    const total = ids.reduce((s, id) => s + (z.rows.get(id)?.z[c] ?? 0), 0);
    const ref = z.draftable[c] ?? { mean: 0, sd: 1 };
    out[c] = 100 * normCdf((total - k * ref.mean) / (Math.sqrt(k) * ref.sd));
  }
  return out;
}
