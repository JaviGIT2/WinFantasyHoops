import type { DataBundle, PlayerData, Pos, TeamData } from '../src/data/types';
import { MODEL_STATS, type SeasonLine, type StatKey } from '../src/engine/stats';

const POS: Pos[] = ['PG', 'SG', 'SF', 'PF', 'C'];

/** Per-game line for a synthetic player of a given quality and position. */
function seasonLine(q: number, pos: Pos, gp = 70): SeasonLine {
  const big = pos === 'C' || pos === 'PF';
  const guard = pos === 'PG' || pos === 'SG';
  const pg: Record<StatKey, number> = {
    min: 18 + 16 * q,
    fga: 6 + 10 * q,
    fgm: (6 + 10 * q) * (big ? 0.55 : 0.46),
    tpa: big ? 1 + q : 3 + 5 * q,
    tpm: (big ? 1 + q : 3 + 5 * q) * 0.36,
    fta: 1.5 + 4 * q,
    ftm: (1.5 + 4 * q) * (big ? 0.7 : 0.82),
    oreb: big ? 1.5 + 2 * q : 0.5,
    dreb: big ? 4 + 5 * q : 2 + 2 * q,
    reb: 0,
    ast: guard ? 3 + 5 * q : 1.5 + 2 * q,
    stl: 0.6 + 0.8 * q,
    blk: big ? 0.8 + 1.2 * q : 0.3,
    to: 1 + 2 * q,
    pts: 0,
    dd: big ? 0.3 * q : 0.05,
    td: 0,
  };
  pg.reb = pg.oreb + pg.dreb;
  pg.pts = 2 * pg.fgm + pg.tpm + pg.ftm;
  const line = { gp, gs: q > 0.5 ? gp : 0 } as SeasonLine;
  for (const k of Object.keys(pg) as StatKey[]) line[k] = pg[k] * gp;
  return line;
}

export function makeBundle(opts: { teams?: string[]; days?: string[]; gamesByTeam?: Record<string, string[]> } = {}) {
  const teams = opts.teams ?? ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF'];
  const days = opts.days ?? ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08'];
  // Default schedule: pair teams on alternating days so game counts differ by team.
  const schedule: DataBundle['schedule'] = [];
  if (opts.gamesByTeam) {
    const seen = new Set<string>();
    for (const [team, dates] of Object.entries(opts.gamesByTeam)) {
      for (const d of dates) {
        const opp = teams.find((t) => t !== team && !(opts.gamesByTeam![t] ?? []).includes(d) && !seen.has(`${d}|${t}`))!;
        if (seen.has(`${d}|${team}`)) continue;
        schedule.push({ d, h: team, a: opp });
        seen.add(`${d}|${team}`);
        seen.add(`${d}|${opp}`);
      }
    }
  } else {
    days.forEach((d, i) => {
      if (i % 2 === 0) {
        schedule.push({ d, h: teams[0], a: teams[1] }, { d, h: teams[2], a: teams[3] });
      } else {
        schedule.push({ d, h: teams[4], a: teams[5] });
      }
    });
  }

  const zeros = MODEL_STATS.map(() => 0);
  const teamData: Record<string, TeamData> = {};
  for (const t of teams) {
    teamData[t] = {
      abbr: t,
      name: `Team ${t}`,
      pace: 99,
      dvp: Object.fromEntries(POS.map((p) => [p, zeros])) as TeamData['dvp'],
      allowed: Object.fromEntries(
        POS.map((p) => [p, { S: [30, ...MODEL_STATS.map(() => 5)], B: [18, ...MODEL_STATS.map(() => 2)] }]),
      ) as TeamData['allowed'],
    };
  }

  const players: PlayerData[] = [];
  let n = 0;
  for (const t of teams) {
    for (let k = 0; k < 8; k++) {
      const pos = POS[k % 5];
      const q = ((n * 37) % 100) / 100;
      players.push({
        id: `p${n}`,
        name: `Player ${n}`,
        team: t,
        pos,
        elig: [pos],
        age: 26,
        rookie: false,
        twoWay: false,
        heightIn: 78,
        last: seasonLine(q, pos),
        avail: 1,
      });
      n++;
    }
  }

  const rates = (min: number) => ({ min, rates: MODEL_STATS.map(() => 0.1) });
  const posRates = Object.fromEntries(POS.map((p) => [p, { S: rates(30), B: rates(16) }])) as DataBundle['model']['posRates'];
  const bundle: DataBundle = {
    meta: {
      generatedAt: '', source: 'fixture', cur: 2027, last: 2026, prev: 2025,
      curLabel: '2026-27', lastLabel: '2025-26', prevLabel: '2024-25',
      seasonStart: days[0], seasonEnd: days[days.length - 1], dataThrough: null, curGames: 0,
    },
    players,
    teams: teamData,
    schedule,
    model: {
      stats: MODEL_STATS,
      features: ['const', 'dvp', 'pace', 'h2h', 'home', 'b2b', 'minRatio'],
      coef: Object.fromEntries(MODEL_STATS.map((s) => [s, [0, 1, 1, 0.5, 0, 0, 1]])) as DataBundle['model']['coef'],
      phi: Object.fromEntries(MODEL_STATS.map((s) => [s, 1.1])) as DataBundle['model']['phi'],
      minutes: { features: ['const', 'baseMin', 'recentMin', 'b2b', 'home'], coef: [0, 1, 0, 0, 0], sd: 5 },
      rateShrinkMinutes: 250,
      posRates,
      statSd: Object.fromEntries(MODEL_STATS.map((s) => [s, 2])) as DataBundle['model']['statSd'],
      ratio: {
        'FG%': { ref: 0.47, sd: 1.2 },
        'FT%': { ref: 0.78, sd: 0.6 },
        '3P%': { ref: 0.36, sd: 0.8 },
        'A/T': { ref: 2, sd: 1.5 },
      },
      trainedOn: { rows: 0, seasons: [] },
    },
    h2h: {},
    curLogs: {},
  };
  return { bundle, days, teams };
}
