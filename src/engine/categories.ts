import type { StatKey, StatLine } from './stats';

/** Yahoo head-to-head scoring categories. */
export type CatId =
  | 'PTS' | 'REB' | 'OREB' | 'DREB' | 'AST' | 'STL' | 'BLK' | '3PM' | '3PA'
  | 'FGM' | 'FTM' | 'TO' | 'DD' | 'TD' | 'FG%' | 'FT%' | '3P%' | 'A/T';

export interface CatDef {
  id: CatId;
  label: string;
  /** Counting categories sum one stat; ratio categories divide two summed stats. */
  kind: 'count' | 'ratio';
  stat?: StatKey;
  num?: StatKey;
  den?: StatKey;
  /** Turnovers: the lower total wins. */
  lowerIsBetter?: boolean;
  decimals: number;
}

export const CATEGORIES: Record<CatId, CatDef> = {
  PTS: { id: 'PTS', label: 'Points', kind: 'count', stat: 'pts', decimals: 1 },
  REB: { id: 'REB', label: 'Rebounds', kind: 'count', stat: 'reb', decimals: 1 },
  OREB: { id: 'OREB', label: 'Off. rebounds', kind: 'count', stat: 'oreb', decimals: 1 },
  DREB: { id: 'DREB', label: 'Def. rebounds', kind: 'count', stat: 'dreb', decimals: 1 },
  AST: { id: 'AST', label: 'Assists', kind: 'count', stat: 'ast', decimals: 1 },
  STL: { id: 'STL', label: 'Steals', kind: 'count', stat: 'stl', decimals: 1 },
  BLK: { id: 'BLK', label: 'Blocks', kind: 'count', stat: 'blk', decimals: 1 },
  '3PM': { id: '3PM', label: '3-pointers made', kind: 'count', stat: 'tpm', decimals: 1 },
  '3PA': { id: '3PA', label: '3-point attempts', kind: 'count', stat: 'tpa', decimals: 1 },
  FGM: { id: 'FGM', label: 'Field goals made', kind: 'count', stat: 'fgm', decimals: 1 },
  FTM: { id: 'FTM', label: 'Free throws made', kind: 'count', stat: 'ftm', decimals: 1 },
  TO: { id: 'TO', label: 'Turnovers', kind: 'count', stat: 'to', lowerIsBetter: true, decimals: 1 },
  DD: { id: 'DD', label: 'Double-doubles', kind: 'count', stat: 'dd', decimals: 2 },
  TD: { id: 'TD', label: 'Triple-doubles', kind: 'count', stat: 'td', decimals: 2 },
  'FG%': { id: 'FG%', label: 'Field goal %', kind: 'ratio', num: 'fgm', den: 'fga', decimals: 3 },
  'FT%': { id: 'FT%', label: 'Free throw %', kind: 'ratio', num: 'ftm', den: 'fta', decimals: 3 },
  '3P%': { id: '3P%', label: '3-point %', kind: 'ratio', num: 'tpm', den: 'tpa', decimals: 3 },
  'A/T': { id: 'A/T', label: 'Assist/turnover', kind: 'ratio', num: 'ast', den: 'to', decimals: 2 },
};

export const ALL_CATS = Object.keys(CATEGORIES) as CatId[];

export interface FormatPreset {
  id: string;
  label: string;
  cats: CatId[];
}

/** Yahoo's default is 9-cat; the smaller formats drop categories from it. */
export const FORMAT_PRESETS: FormatPreset[] = [
  { id: '9cat', label: '9-cat', cats: ['FG%', 'FT%', '3PM', 'PTS', 'REB', 'AST', 'STL', 'BLK', 'TO'] },
  { id: '8cat', label: '8-cat (no TO)', cats: ['FG%', 'FT%', '3PM', 'PTS', 'REB', 'AST', 'STL', 'BLK'] },
  { id: '7cat', label: '7-cat', cats: ['FG%', 'FT%', 'PTS', 'REB', 'AST', 'STL', 'BLK'] },
  { id: '5cat', label: '5-cat', cats: ['PTS', 'REB', 'AST', 'STL', 'BLK'] },
  { id: '11cat', label: '11-cat (+3P%, A/T)', cats: ['FG%', 'FT%', '3P%', '3PM', 'PTS', 'REB', 'AST', 'STL', 'BLK', 'TO', 'A/T'] },
];

/** Value of a category for a stat line (ratio categories return the ratio). */
export function catValue(cat: CatDef, line: StatLine): number {
  if (cat.kind === 'count') return line[cat.stat!];
  const den = line[cat.den!];
  return den > 0 ? line[cat.num!] / den : 0;
}

export function formatCat(cat: CatDef, value: number): string {
  if (cat.kind === 'ratio' && cat.id !== 'A/T') return value.toFixed(3).replace(/^0/, '');
  return value.toFixed(cat.decimals);
}
