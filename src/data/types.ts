import type { ModelStat, SeasonLine } from '../engine/stats';

export type Pos = 'PG' | 'SG' | 'SF' | 'PF' | 'C';
export const POSITIONS: Pos[] = ['PG', 'SG', 'SF', 'PF', 'C'];
/** Starter or bench role, used for positional baselines. */
export type Role = 'S' | 'B';

export interface InjuryInfo {
  date: string;
  note: string;
  status: 'out' | 'dtd';
}

export interface PlayerData {
  id: string;
  name: string;
  team: string;
  /** Primary position and Yahoo-style position eligibility. */
  pos: Pos;
  elig: Pos[];
  age: number;
  rookie: boolean;
  twoWay: boolean;
  heightIn: number;
  /** On no current roster (an unsigned free agent): listed under the team he last played for until he signs. */
  unsigned?: boolean;
  /** Season totals: current season to date, last season, the season before. */
  cur?: SeasonLine;
  last?: SeasonLine;
  prev?: SeasonLine;
  /** Average minutes over the last 5 games of the current season. */
  recentMin?: number;
  /** Probability the player suits up for a given game (history of games missed). */
  avail: number;
  injury?: InjuryInfo;
}

export interface TeamData {
  abbr: string;
  name: string;
  pace: number;
  /**
   * Opponent-adjusted defense vs. position: log multiplier on a player's own
   * expected production, per model stat (MODEL_STATS order), keyed by the
   * attacking player's position. Positive = this team gives up more than expected.
   */
  dvp: Record<Pos, number[]>;
  /**
   * Raw per-game lines this team allowed to players at a position and role,
   * [min, ...MODEL_STATS]. "CHI allowed 7.5 AST to starting PGs" lives here and
   * drives projections for players with no NBA history.
   */
  allowed: Record<Pos, Record<Role, number[]>>;
}

export interface GameData {
  /** ISO date, home team, away team. */
  d: string;
  h: string;
  a: string;
}

/** Holdout errors per game: mean absolute error and root mean squared error, naive vs model. */
export interface EvalMetric {
  naive: number;
  model: number;
  naiveRmse: number;
  modelRmse: number;
  /** Per-stat comparison of the two candidate models and the one the app uses. */
  glmRmse?: number;
  gbmRmse?: number;
  chosen?: 'glm' | 'gbm';
}

/**
 * A LightGBM tree flattened to arrays: internal node i splits on feature f[i] at
 * threshold t[i] (x <= t goes left to l[i], else r[i]); a child c >= 0 is another
 * node and c < 0 is the leaf ~c with value v[~c].
 */
export interface GbmTree {
  f: number[];
  t: number[];
  l: number[];
  r: number[];
  v: number[];
}

export interface EvalReport {
  cutoff: string;
  trainRows: number;
  testRows: number;
  minutes: EvalMetric;
  stats: Record<ModelStat, EvalMetric>;
}

export interface ModelData {
  stats: ModelStat[];
  /** Feature names for coefficient vectors; feature 0 is the constant. */
  features: string[];
  /** Poisson GLM coefficients for every stat ([const, ...features]). */
  coef: Record<ModelStat, number[]>;
  /** Stats where gradient-boosted trees beat the GLM on the holdout; their trees replace the GLM. */
  gbm?: Partial<Record<ModelStat, { trees: GbmTree[] }>>;
  phi: Record<ModelStat, number>;
  minutes: { features: string[]; coef: number[]; sd: number };
  /** Prior strength (in minutes) when blending a small sample toward its prior. */
  rateShrinkMinutes: number;
  /** League per-minute rates (MODEL_STATS order) and minutes per game by position and role. */
  posRates: Record<Pos, Record<Role, { min: number; rates: number[] }>>;
  /** Per-game standard deviation of each model stat among rotation players (for value scaling). */
  statSd: Record<ModelStat, number>;
  /** League reference ratio and per-game SD of volume-weighted impact for ratio categories. */
  ratio: Record<'FG%' | 'FT%' | '3P%' | 'A/T', { ref: number; sd: number }>;
  trainedOn: { rows: number; seasons: string[] };
  eval?: EvalReport;
}

export interface Meta {
  generatedAt: string;
  source: string;
  cur: number;
  last: number;
  prev: number;
  curLabel: string;
  lastLabel: string;
  prevLabel: string;
  seasonStart: string;
  seasonEnd: string;
  /** Latest date with box scores in the bundle (actual stats are known through this day). */
  dataThrough: string | null;
  curGames: number;
}

/** player id → opponent → [games, shrunk log multiplier per MODEL_STATS]. */
export type H2HTable = Record<string, Record<string, number[]>>;

/** player id → current-season games: [date, opp, min, ...MODEL_STATS]. */
export type CurLogs = Record<string, (string | number)[][]>;

export interface DataBundle {
  meta: Meta;
  players: PlayerData[];
  teams: Record<string, TeamData>;
  schedule: GameData[];
  model: ModelData;
  h2h: H2HTable;
  curLogs: CurLogs;
}
