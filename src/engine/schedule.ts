import type { GameData } from '../data/types';

/** Date helpers on ISO yyyy-mm-dd strings, in UTC so time zones never shift a day. */
const toDate = (iso: string) => new Date(iso + 'T00:00:00Z');
export const isoOf = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (iso: string, n: number) => {
  const d = toDate(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return isoOf(d);
};
/** 0 = Monday … 6 = Sunday (fantasy weeks run Monday–Sunday). */
export const weekday = (iso: string) => (toDate(iso).getUTCDay() + 6) % 7;
export const dayName = (iso: string) => ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][weekday(iso)];
export const shortDate = (iso: string) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
export const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export interface TeamGame {
  date: string;
  team: string;
  opp: string;
  home: boolean;
  /** Team also played the previous day. */
  b2b: boolean;
}

export interface ScheduleIndex {
  byTeam: Map<string, TeamGame[]>;
  byDateTeam: Map<string, TeamGame>;
  start: string;
  end: string;
}

export function buildScheduleIndex(games: GameData[]): ScheduleIndex {
  const byTeam = new Map<string, TeamGame[]>();
  const push = (team: string, g: Omit<TeamGame, 'b2b'>) => {
    if (!byTeam.has(team)) byTeam.set(team, []);
    byTeam.get(team)!.push({ ...g, b2b: false });
  };
  for (const g of games) {
    push(g.h, { date: g.d, team: g.h, opp: g.a, home: true });
    push(g.a, { date: g.d, team: g.a, opp: g.h, home: false });
  }
  const byDateTeam = new Map<string, TeamGame>();
  for (const list of byTeam.values()) {
    list.sort((a, b) => a.date.localeCompare(b.date));
    for (let i = 0; i < list.length; i++) {
      list[i].b2b = i > 0 && list[i - 1].date === addDays(list[i].date, -1);
      byDateTeam.set(`${list[i].date}|${list[i].team}`, list[i]);
    }
  }
  const dates = games.map((g) => g.d).sort();
  return { byTeam, byDateTeam, start: dates[0] ?? '', end: dates[dates.length - 1] ?? '' };
}

export const teamGameOn = (idx: ScheduleIndex, team: string, date: string) => idx.byDateTeam.get(`${date}|${team}`);

export function teamGamesBetween(idx: ScheduleIndex, team: string, from: string, to: string): TeamGame[] {
  return (idx.byTeam.get(team) ?? []).filter((g) => g.date >= from && g.date <= to);
}

export interface FantasyWeek {
  week: number;
  start: string;
  end: string;
  days: string[];
}

/**
 * Yahoo-style Monday–Sunday matchup weeks. Week 1 is the (possibly partial) week
 * containing opening night.
 */
export function fantasyWeeks(idx: ScheduleIndex): FantasyWeek[] {
  if (!idx.start) return [];
  const weeks: FantasyWeek[] = [];
  let monday = addDays(idx.start, -weekday(idx.start));
  for (let w = 1; monday <= idx.end; w++) {
    const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i)).filter(
      (d) => d >= idx.start && d <= idx.end,
    );
    weeks.push({ week: w, start: days[0], end: days[days.length - 1], days });
    monday = addDays(monday, 7);
  }
  return weeks;
}

export function weekFor(weeks: FantasyWeek[], date: string): FantasyWeek | undefined {
  if (!weeks.length) return undefined;
  if (date < weeks[0].start) return weeks[0];
  return weeks.find((w) => date <= w.end) ?? weeks[weeks.length - 1];
}
