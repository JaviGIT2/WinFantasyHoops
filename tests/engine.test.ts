import { describe, expect, it } from 'vitest';
import { CATEGORIES, FORMAT_PRESETS } from '../src/engine/categories';
import { createContext } from '../src/engine/context';
import { fitLinear, fitPoisson } from '../src/engine/glm';
import { findTrades, leagueReport } from '../src/engine/league';
import { bestLineup, DEFAULT_SLOTS, expandSlots, hungarian, type Slot } from '../src/engine/lineup';
import { catDist, catOdds, compareAggs, matchupOdds, projectWeek, valueWeights } from '../src/engine/matchup';
import { gaussian, normCdf, rng } from '../src/engine/mathx';
import { predictGame } from '../src/engine/model';
import { playerRates, seasonProjection } from '../src/engine/projection';
import { buildScheduleIndex, fantasyWeeks } from '../src/engine/schedule';
import { planStreams } from '../src/engine/streaming';
import { computeZ, teamStrength, weightedValue } from '../src/engine/zscore';
import { perGame } from '../src/engine/stats';
import type { Pos } from '../src/data/types';
import { makeBundle } from './fixtures';

describe('math', () => {
  it('normal CDF matches known values', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
    expect(normCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normCdf(-1)).toBeCloseTo(0.1587, 3);
  });
});

describe('GLM', () => {
  it('recovers Poisson coefficients with an offset', () => {
    const rand = rng(7);
    const X: number[][] = [];
    const y: number[] = [];
    const off: number[] = [];
    const truth = [0.1, 0.8, -0.3];
    for (let i = 0; i < 20000; i++) {
      const x = [1, gaussian(rand) * 0.3, rand() < 0.5 ? 1 : 0];
      const o = Math.log(2 + 3 * rand());
      const mu = Math.exp(o + truth[0] + truth[1] * x[1] + truth[2] * x[2]);
      // Poisson draw by inversion.
      let k = 0;
      let p = Math.exp(-mu);
      let s = p;
      const u = rand();
      while (u > s) {
        k++;
        p *= mu / k;
        s += p;
      }
      X.push(x);
      y.push(k);
      off.push(o);
    }
    const fit = fitPoisson(X, y, off, { lambda: 0 });
    fit.coef.forEach((c, i) => expect(c).toBeCloseTo(truth[i], 1));
    expect(fit.phi).toBeGreaterThan(0.9);
    expect(fit.phi).toBeLessThan(1.1);
  });

  it('fits a linear model', () => {
    const X = [[1, 1], [1, 2], [1, 3], [1, 4]];
    const { coef } = fitLinear(X, [3, 5, 7, 9]);
    expect(coef[0]).toBeCloseTo(1, 6);
    expect(coef[1]).toBeCloseTo(2, 6);
  });
});

describe('lineup optimizer', () => {
  it('Hungarian matches brute force on random cost matrices', () => {
    const rand = rng(3);
    for (let trial = 0; trial < 30; trial++) {
      const n = 4;
      const m = 5;
      const C = Array.from({ length: n }, () => Array.from({ length: m }, () => Math.round(rand() * 20)));
      const assign = hungarian(n, m, (i, j) => C[i][j]);
      const cost = assign.reduce((s, j, i) => s + C[i][j], 0);
      let best = Infinity;
      const rec = (i: number, used: Set<number>, acc: number) => {
        if (i === n) return void (best = Math.min(best, acc));
        for (let j = 0; j < m; j++) if (!used.has(j)) rec(i + 1, new Set([...used, j]), acc + C[i][j]);
      };
      rec(0, new Set(), 0);
      expect(cost).toBe(best);
      expect(new Set(assign).size).toBe(n);
    }
  });

  it('benches the lowest-value player when too many centers play', () => {
    const slots: Slot[] = ['C', 'C', 'UTIL'];
    const players = [
      { id: 'a', elig: ['C'] as Pos[], value: 5 },
      { id: 'b', elig: ['C'] as Pos[], value: 3 },
      { id: 'c', elig: ['C'] as Pos[], value: 1 },
      { id: 'd', elig: ['C'] as Pos[], value: 4 },
    ];
    const r = bestLineup(players, slots);
    expect(r.benched).toEqual(['c']);
    expect(r.value).toBe(12);
  });

  it('uses flexible slots so everyone who fits plays', () => {
    const slots = expandSlots(DEFAULT_SLOTS);
    const elig: Pos[][] = [['PG'], ['PG'], ['PG'], ['SG'], ['SF'], ['PF'], ['C'], ['C'], ['C'], ['SF', 'PF']];
    const r = bestLineup(elig.map((e, i) => ({ id: `p${i}`, elig: e, value: 1 })), slots);
    expect(r.started.length).toBe(10);
  });
});

describe('matchup odds', () => {
  it('category odds are symmetric and sum to 1', () => {
    const def = CATEGORIES.PTS;
    const a = catOdds({ mean: 400, sd: 30 }, { mean: 380, sd: 30 }, def);
    const b = catOdds({ mean: 380, sd: 30 }, { mean: 400, sd: 30 }, def);
    expect(a.win + a.tie + a.loss).toBeCloseTo(1, 9);
    expect(a.win).toBeCloseTo(b.loss, 9);
    expect(a.win).toBeGreaterThan(0.6);
  });

  it('turnovers: fewer wins', () => {
    const o = catOdds({ mean: 10, sd: 3 }, { mean: 20, sd: 3 }, CATEGORIES.TO);
    expect(o.win).toBeGreaterThan(0.95);
  });

  it('matchup DP is exact for coin-flip categories', () => {
    const coin = { win: 0.5, tie: 0, loss: 0.5 };
    const odds = matchupOdds(Array(9).fill(coin));
    expect(odds.win).toBeCloseTo(0.5, 9);
    expect(odds.expWins).toBeCloseTo(4.5, 9);
    const even = matchupOdds(Array(2).fill(coin));
    expect(even.tie).toBeCloseTo(0.5, 9);
  });
});

describe('schedule', () => {
  it('builds Monday–Sunday weeks with a partial first week', () => {
    const idx = buildScheduleIndex([
      { d: '2026-10-20', h: 'A', a: 'B' },
      { d: '2026-10-21', h: 'A', a: 'C' },
      { d: '2026-11-02', h: 'B', a: 'C' },
    ]);
    const weeks = fantasyWeeks(idx);
    expect(weeks[0]).toMatchObject({ week: 1, start: '2026-10-20', end: '2026-10-25' });
    expect(weeks[2].start).toBe('2026-11-02');
    expect(idx.byTeam.get('A')![1].b2b).toBe(true);
  });
});

describe('projections', () => {
  it('shrinks toward positional baselines and handles players with no history', () => {
    const { bundle } = makeBundle();
    const rookie = { ...bundle.players[0], id: 'rook', last: undefined, rookie: true };
    bundle.players.push(rookie);
    const ctx = createContext(bundle, {}, '2026-10-01');
    const r = playerRates(ctx, rookie);
    expect(r.noData).toBe(true);
    const tg = ctx.sched.byTeam.get(rookie.team)![0];
    const g = predictGame(ctx, rookie, tg);
    expect(g.source).toBe('positional');
    // Bench allowance is 2 per 18 minutes in the fixture; scaled to his expected minutes.
    expect(g.mean[0]).toBeCloseTo((2 * g.min) / 18, 6);
  });

  it('season projection totals scale with availability', () => {
    const { bundle } = makeBundle();
    const ctx = createContext(bundle, {}, '2026-10-01');
    const p = bundle.players[3];
    const full = seasonProjection(ctx, p);
    const ctx2 = createContext(bundle, { [p.id]: { avail: 0.5 } }, '2026-10-01');
    const half = seasonProjection(ctx2, p);
    expect(half.gp).toBeCloseTo(full.gp / 2, 6);
    expect(half.totals.pts).toBeCloseTo(full.totals.pts / 2, 6);
  });
});

describe('z-scores and team strength', () => {
  it('ranks better players higher and centers strength at 50', () => {
    const { bundle } = makeBundle();
    const rows = bundle.players.map((p) => ({ id: p.id, line: perGame(p.last) }));
    const cats = FORMAT_PRESETS[0].cats;
    const z = computeZ(rows, cats, 30);
    const totals = [...z.rows.values()].map((r) => r.total);
    expect(Math.max(...totals)).toBeGreaterThan(0);
    const s = teamStrength(z, [], cats);
    expect(s.PTS).toBe(50);
    const best = [...z.rows.values()].sort((a, b) => b.total - a.total)[0];
    expect(teamStrength(z, [best.id], cats).PTS).toBeGreaterThan(50);
  });
});

describe('z-scores are measured against the whole league', () => {
  it('centers player values on every player with minutes, not the draftable pool', () => {
    const { bundle } = makeBundle();
    const rows = bundle.players.map((p) => ({ id: p.id, line: perGame(p.last) }));
    const z = computeZ(rows, ['PTS', 'REB'], 10);
    expect(z.leagueSize).toBe(rows.length);
    const pts = [...z.rows.values()].map((r) => r.z.PTS);
    expect(pts.reduce((a, b) => a + b, 0) / pts.length).toBeCloseTo(0, 9);
    // Drafted players are above the league average…
    expect(z.draftable.PTS.mean).toBeGreaterThan(0.5);
    // …so the chart's 50 still means "a typical drafted team": the draftable pool itself rates exactly 50.
    const pool = [...z.rows.values()].sort((x, y) => y.total - x.total).slice(0, 10).map((r) => r.id);
    expect(teamStrength(z, pool, ['PTS', 'REB']).PTS).toBeCloseTo(50, 4); // normCdf is accurate to ~1e-7
  });
});

describe('category multipliers', () => {
  it('turning TO down to x0.25 lifts a high-turnover scorer past a low-turnover role player', () => {
    const line = (pts: number, to: number) => ({ ...perGame(undefined), min: 30, pts, to });
    const players = [
      { id: 'star', line: line(28, 4.5) },
      { id: 'safe', line: line(18, 0.8) },
      ...Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, line: line(8 + (i % 10), 1 + (i % 4) * 0.5) })),
    ];
    const cats = ['PTS', 'TO'] as const;
    const z = computeZ(players, [...cats], 12);
    const rank = (w: (c: string) => number) => weightedValue(z.rows.get('star'), [...cats], w) - weightedValue(z.rows.get('safe'), [...cats], w);
    expect(rank(() => 1)).toBeLessThan(0); // at x1 the turnovers sink him
    expect(rank((c) => (c === 'TO' ? 0.25 : 1))).toBeGreaterThan(0); // at x0.25 he passes the role player
    expect(weightedValue(z.rows.get('star'), [...cats], () => 1)).toBeCloseTo(z.rows.get('star')!.total, 9);
  });
});

describe('z-score shooting impact', () => {
  it('weights percentages by volume', () => {
    const line = (fgm: number, fga: number) => ({ ...perGame(undefined), min: 30, fgm, fga });
    const players = [
      { id: 'lowVolume', line: line(1.8, 3) }, // 60% on 3 attempts
      { id: 'highVolume', line: line(8.25, 15) }, // 55% on 15 attempts
      ...Array.from({ length: 20 }, (_, i) => ({ id: `avg${i}`, line: line(4.6 + (i % 3) * 0.1, 10) })),
    ];
    const z = computeZ(players, ['FG%'], 22);
    expect(z.rows.get('highVolume')!.z['FG%']).toBeGreaterThan(z.rows.get('lowVolume')!.z['FG%']);
  });

  // A league with realistic shooting averages (~47% FG, ~78% FT) to score the cases against.
  const league = Array.from({ length: 40 }, (_, i) => {
    const fga = 4 + (i % 10) * 1.5;
    const fta = 1 + (i % 6);
    return { id: `lg${i}`, line: { ...perGame(undefined), min: 25, fga, fgm: fga * (0.43 + (i % 9) * 0.01), fta, ftm: fta * (0.72 + (i % 7) * 0.02) } };
  });
  const shooter = (id: string, fga: number, fgPct: number, fta: number, ftPct: number) => ({
    id, line: { ...perGame(undefined), min: 25, fga, fgm: fga * fgPct, fta, ftm: fta * ftPct },
  });

  it('a 55% shooter on triple the attempts beats a 59% shooter', () => {
    const z = computeZ([...league, shooter('volume', 15, 0.55, 0, 0), shooter('efficient', 5, 0.59, 0, 0)], ['FG%'], 20);
    expect(z.rows.get('volume')!.z['FG%']).toBeGreaterThan(1.5 * z.rows.get('efficient')!.z['FG%']);
  });

  it('a 55% free-throw shooter hurts less than a 61% shooter on triple the attempts', () => {
    const z = computeZ([...league, shooter('rare', 0, 0, 2, 0.55), shooter('frequent', 0, 0, 6, 0.61)], ['FT%'], 20);
    expect(z.rows.get('rare')!.z['FT%']).toBeLessThan(0);
    expect(z.rows.get('rare')!.z['FT%']).toBeGreaterThan(z.rows.get('frequent')!.z['FT%']);
  });
});

describe('weekly projection, league and streaming', () => {
  const cats = FORMAT_PRESETS[0].cats;
  const slots = expandSlots(DEFAULT_SLOTS);

  it('projects more production for a roster with more games', () => {
    const { bundle, days } = makeBundle();
    const ctx = createContext(bundle, {}, days[0]);
    const w = valueWeights(bundle.model, cats);
    const aaa = bundle.players.filter((p) => p.team === 'AAA'); // plays 4 of 7 days
    const eee = bundle.players.filter((p) => p.team === 'EEE'); // plays 3 of 7 days
    const a = projectWeek(ctx, aaa, days, slots, w);
    const e = projectWeek(ctx, eee, days, slots, w);
    expect(a.starts).toBeGreaterThan(e.starts);
    const cmp = compareAggs(a.agg, e.agg, cats);
    expect(cmp.odds.win + cmp.odds.tie + cmp.odds.loss).toBeCloseTo(1, 9);
  });

  it('a finished week is certain: final box scores carry no variance, even for percentages', () => {
    const { bundle, days } = makeBundle();
    const roster = bundle.players.filter((p) => p.team === 'AAA').slice(0, 3);
    // AAA plays every other day; give each player a final line for each of those games.
    for (const p of roster) {
      bundle.curLogs[p.id] = bundle.schedule
        .filter((g) => g.h === 'AAA' || g.a === 'AAA')
        .map((g) => [g.d, g.h === 'AAA' ? g.a : g.h, 30, 7, 15, 2, 5, 3, 4, 1, 5, 6, 4, 1, 1, 2, 19, 0, 0]);
    }
    bundle.meta.dataThrough = days[days.length - 1];
    const ctx = createContext(bundle, {}, '2026-11-20');
    const week = projectWeek(ctx, roster, days, slots, valueWeights(bundle.model, cats));
    const fg = catDist(week.agg, CATEGORIES['FG%']);
    expect(fg.mean).toBeCloseTo(7 / 15, 9);
    expect(fg.sd).toBe(0);
    expect(catDist(week.agg, CATEGORIES.PTS).sd).toBe(0);
    const games = bundle.schedule.filter((g) => g.h === 'AAA' || g.a === 'AAA').length;
    expect(catDist(week.agg, CATEGORIES.PTS).mean).toBe(19 * games * roster.length);
  });

  it('league report and trade finder return consistent structures', () => {
    const { bundle } = makeBundle();
    const ctx = createContext(bundle, {}, '2026-10-01');
    const rosters = ['AAA', 'BBB', 'CCC', 'DDD'].map((t) => bundle.players.filter((p) => p.team === t));
    const rep = leagueReport(ctx, rosters, cats, 'last');
    // Expected category wins between two teams add up to the number of categories.
    expect(rep[0].vs[1] + rep[1].vs[0]).toBeCloseTo(cats.length, 6);
    const fa = bundle.players.filter((p) => p.team === 'EEE');
    const res = findTrades(ctx, rosters, 0, fa, cats, 'last');
    for (const t of res.trades) {
      expect(t.myDelta).toBeGreaterThan(0);
      expect(t.give.length).toBe(t.get.length);
    }
  });

  it('streams the free agent whose team plays more games, within the add limit', () => {
    const teams = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF'];
    const days = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08'];
    const { bundle } = makeBundle({
      teams,
      days,
      gamesByTeam: {
        AAA: ['2026-11-02', '2026-11-04', '2026-11-06'],
        CCC: ['2026-11-03', '2026-11-05', '2026-11-07', '2026-11-08'],
        EEE: ['2026-11-02'],
      },
    });
    const ctx = createContext(bundle, {}, days[0]);
    const roster = bundle.players.filter((p) => p.team === 'AAA').slice(0, 5);
    // Two identical free agents except for their team's schedule.
    const template = bundle.players.find((p) => p.team === 'BBB')!;
    const many = { ...template, id: 'fa-many', team: 'CCC', elig: ['PG', 'SG', 'SF', 'PF', 'C'] as Pos[] };
    const few = { ...template, id: 'fa-few', team: 'EEE', elig: ['PG', 'SG', 'SF', 'PF', 'C'] as Pos[] };
    bundle.players.push(many, few);
    ctx.byId.set(many.id, many);
    ctx.byId.set(few.id, few);
    const plan = planStreams(ctx, {
      roster,
      droppable: [roster[4].id],
      freeAgents: [few, many],
      days,
      today: days[0],
      addsLeft: 1,
      addTiming: 'same',
      slots,
      leagueCats: cats,
      mode: 'chase',
      chase: ['PTS'],
    });
    expect(plan.addsUsed).toBeLessThanOrEqual(1);
    expect(plan.moves[0]?.add).toBe('fa-many');
    const pts = plan.chase.find((c) => c.cat === 'PTS')!;
    expect(pts.after).toBeGreaterThan(pts.before);
  });
});

describe('gradient-boosted trees (exported from LightGBM by the Python pipeline)', () => {
  it('evaluates exactly like LightGBM', async () => {
    const { default: fixture } = await import('./fixtures/gbm-parity.json');
    const { evalTrees } = await import('../src/engine/model');
    fixture.x.forEach((x: number[], k: number) => expect(evalTrees(fixture.trees, x)).toBeCloseTo(fixture.raw[k], 10));
  });
});
