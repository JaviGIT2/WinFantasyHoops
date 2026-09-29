/** Box-score stat keys shared by the data pipeline, the model and the UI. */

export const STAT_KEYS = [
  'min', 'fgm', 'fga', 'tpm', 'tpa', 'ftm', 'fta', 'oreb', 'dreb', 'reb',
  'ast', 'stl', 'blk', 'to', 'pts', 'dd', 'td',
] as const;
export type StatKey = (typeof STAT_KEYS)[number];

/** Stats predicted by the per-game model (minutes has its own model). */
export const MODEL_STATS = STAT_KEYS.filter((k) => k !== 'min') as Exclude<StatKey, 'min'>[];
export type ModelStat = (typeof MODEL_STATS)[number];

export type StatLine = Record<StatKey, number>;

export const zeroLine = (): StatLine =>
  Object.fromEntries(STAT_KEYS.map((k) => [k, 0])) as StatLine;

/** target += src * k (in place). */
export function addInto(target: StatLine, src: Partial<StatLine>, k = 1): StatLine {
  for (const key of STAT_KEYS) target[key] += (src[key] ?? 0) * k;
  return target;
}

export const scaleLine = (src: StatLine, k: number): StatLine =>
  Object.fromEntries(STAT_KEYS.map((key) => [key, src[key] * k])) as StatLine;

export const sumLines = (lines: StatLine[]): StatLine => lines.reduce((acc, l) => addInto(acc, l), zeroLine());

/** Double-double / triple-double flags from a single game line. */
export function doubleFlags(g: Pick<StatLine, 'pts' | 'reb' | 'ast' | 'stl' | 'blk'>) {
  const tens = [g.pts, g.reb, g.ast, g.stl, g.blk].filter((v) => v >= 10).length;
  return { dd: tens >= 2 ? 1 : 0, td: tens >= 3 ? 1 : 0 };
}

/** Season totals as stored in the data bundle: counting totals plus games played/started. */
export interface SeasonLine extends StatLine {
  gp: number;
  gs: number;
}

export const perGame = (s: SeasonLine | undefined): StatLine =>
  s && s.gp > 0 ? scaleLine(s, 1 / s.gp) : zeroLine();
