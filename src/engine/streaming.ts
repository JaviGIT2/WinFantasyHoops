import type { PlayerData } from '../data/types';
import { CATEGORIES, type CatId } from './categories';
import { eligOf, type EngineCtx } from './context';
import { bestLineup, SLOT_ELIG, type Slot } from './lineup';
import { catDist, compareAggs, lineValue, projectWeek, valueWeights, type MatchupOdds, type TeamWeek } from './matchup';
import { normPdf } from './mathx';
import { expectedContribution, predictGame, statIndex } from './model';
import { addDays, teamGameOn } from './schedule';

/**
 * Streaming optimizer: which droppable players to swap for which free agents,
 * and on which days, to maximize the categories you're chasing this week
 * with a limited number of adds.
 *
 * 1. Each day, core (undroppable) players take the best lineup; whatever active
 *    slots stay open are what a streamer can use.
 * 2. Each droppable roster spot is a timeline. A dynamic program over
 *    (day, occupant, adds used) finds the best sequence of pickups for that spot
 *    for every possible number of adds; players are never re-added once dropped.
 * 3. A knapsack splits the weekly add budget across spots, and free agents
 *    claimed by two spots are resolved by excluding them from the weaker one.
 * 4. The resulting roster is re-projected with true daily lineups.
 *
 * In "win" mode the value of each stat is the marginal gain in the probability
 * of winning that category against this week's opponent (∂P/∂μ = φ(z)/σ), so
 * swing categories matter most and locked-in categories are ignored. The weights
 * are re-derived from the new plan a few times.
 */

export interface StreamOptions {
  roster: PlayerData[];
  droppable: string[];
  freeAgents: PlayerData[];
  /** All days of the fantasy week. */
  days: string[];
  /** First day a new transaction can be made. */
  today: string;
  addsLeft: number;
  /** Whether a player added today can play today, or only from tomorrow. */
  addTiming: 'same' | 'next';
  slots: Slot[];
  leagueCats: CatId[];
  mode: 'chase' | 'win';
  chase: CatId[];
  opponent?: PlayerData[];
  maxCandidates?: number;
}

export interface StreamMove {
  /** Day the transaction is made. */
  decideOn: string;
  /** First day the added player's games count. */
  effective: string;
  drop: string;
  add: string;
  /** Dates the added player is expected to start before he is replaced. */
  games: string[];
  value: number;
}

export interface StreamCandidate {
  id: string;
  value: number;
  games: string[];
}

export interface StreamPlan {
  moves: StreamMove[];
  addsUsed: number;
  before: TeamWeek;
  after: TeamWeek;
  chase: { cat: CatId; before: number; after: number }[];
  oddsBefore?: MatchupOdds;
  oddsAfter?: MatchupOdds;
  candidates: StreamCandidate[];
  weights: Partial<Record<CatId, number>>;
}

interface SlotPath {
  value: number;
  steps: { t: number; c: number }[];
}

/** Category weights from the marginal win probability against an opponent. */
export function winProbabilityWeights(ctx: EngineCtx, me: TeamWeek, opp: TeamWeek, cats: CatId[]) {
  const { model } = ctx.data;
  const out: Partial<Record<CatId, number>> = {};
  for (const c of cats) {
    const def = CATEGORIES[c];
    const a = catDist(me.agg, def);
    const b = catDist(opp.agg, def);
    const s = Math.max(Math.hypot(a.sd, b.sd), 1e-6);
    const z = (a.mean - b.mean) / s;
    const dPdMu = normPdf(z) / s; // per unit of the category
    if (def.kind === 'count') {
      out[c] = dPdMu * model.statSd[def.stat as keyof typeof model.statSd];
    } else {
      const den = me.agg.mean[statIndex[def.den as keyof typeof statIndex]] || 1;
      out[c] = (dPdMu / den) * model.ratio[c as keyof typeof model.ratio].sd;
    }
  }
  // Normalize so the largest weight is 1 (only the relative sizes matter).
  const max = Math.max(...Object.values(out).map((v) => v ?? 0), 1e-9);
  for (const k of Object.keys(out) as CatId[]) out[k] = (out[k] ?? 0) / max;
  return out;
}

function planWithWeights(ctx: EngineCtx, o: StreamOptions, catWeight: Partial<Record<CatId, number>>) {
  const { model } = ctx.data;
  const w = valueWeights(model, o.leagueCats.filter((c) => (catWeight[c] ?? 0) > 0), catWeight);
  const remaining = o.days.filter((d) => d >= o.today);
  const T = remaining.length;
  const firstSwitch = o.addTiming === 'same' ? 0 : 1;
  const dropSet = new Set(o.droppable);
  const core = o.roster.filter((p) => !dropSet.has(p.id));

  // Open active slots each day after the core players' best lineup.
  const leagueW = valueWeights(model, o.leagueCats);
  const openSlots: Slot[][] = remaining.map((date) => {
    const playing = core.flatMap((p) => {
      const tg = teamGameOn(ctx.sched, p.team, date);
      if (!tg) return [];
      const g = predictGame(ctx, p, tg);
      if (g.avail <= 0) return [];
      return [{ id: p.id, elig: eligOf(ctx, p), value: Math.max(0.01, 6 + lineValue(expectedContribution(g).mean, leagueW)) }];
    });
    const lineup = bestLineup(playing, o.slots);
    const used = [...lineup.slotOf.values()];
    const open = [...o.slots];
    for (const s of used) open.splice(open.indexOf(s), 1);
    return open;
  });

  // Value of each player's game on each remaining day, if an open slot fits him.
  const dayValue = (p: PlayerData): number[] =>
    remaining.map((date, t) => {
      const tg = teamGameOn(ctx.sched, p.team, date);
      if (!tg) return 0;
      const elig = eligOf(ctx, p);
      if (!openSlots[t].some((s) => SLOT_ELIG[s].some((pos) => elig.includes(pos)))) return 0;
      const g = predictGame(ctx, p, tg);
      if (g.avail <= 0) return 0;
      return Math.max(0, lineValue(expectedContribution(g).mean, w));
    });

  const faValues = o.freeAgents.map((p) => ({ p, v: dayValue(p) }));
  const candidates = faValues
    .map((x) => ({ ...x, total: x.v.slice(firstSwitch).reduce((a, b) => a + b, 0) }))
    .filter((x) => x.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, o.maxCandidates ?? 40);

  const A = Math.max(0, Math.min(o.addsLeft, 14));
  const drops = o.roster.filter((p) => dropSet.has(p.id));

  const solveSlot = (dropVals: number[], excluded: Set<number>): SlotPath[] => {
    // occupant 0 = the droppable player, 1..K = candidates
    const vals = [dropVals, ...candidates.map((c) => c.v)];
    const K = vals.length;
    type State = SlotPath & { occ: number };
    let states = new Map<string, State>([['0|0', { occ: 0, value: 0, steps: [] }]]);
    for (let t = 0; t < T; t++) {
      const next = new Map<string, State>();
      const offer = (s: State) => {
        const key = `${s.occ}|${s.steps.length}`;
        const cur = next.get(key);
        if (!cur || s.value > cur.value) next.set(key, s);
      };
      for (const s of states.values()) {
        offer({ ...s, value: s.value + vals[s.occ][t] });
        if (t < firstSwitch || s.steps.length >= A) continue;
        for (let c = 1; c < K; c++) {
          if (c === s.occ || excluded.has(c) || s.steps.some((st) => st.c === c)) continue;
          if (vals[c][t] <= 0 && !vals[c].slice(t).some((v) => v > 0)) continue;
          offer({ occ: c, value: s.value + vals[c][t], steps: [...s.steps, { t, c }] });
        }
      }
      states = next;
    }
    // Best path using at most a adds, for each a.
    const best: SlotPath[] = [];
    for (let a = 0; a <= A; a++) {
      let b: SlotPath = { value: -Infinity, steps: [] };
      for (const s of states.values()) if (s.steps.length <= a && s.value > b.value) b = s;
      best.push(b);
    }
    return best;
  };

  const dropVals = drops.map((d) => dayValue(d));
  const excluded = drops.map(() => new Set<number>());
  let chosen: SlotPath[] = [];
  for (let round = 0; round < 6; round++) {
    const perSlot = drops.map((_, i) => solveSlot(dropVals[i], excluded[i]));
    // Knapsack over slots for the add budget.
    let dp = new Array(A + 1).fill(0).map(() => ({ value: 0, pick: [] as number[] }));
    for (const f of perSlot) {
      const nd = new Array(A + 1).fill(null).map(() => ({ value: -Infinity, pick: [] as number[] }));
      for (let a = 0; a <= A; a++) for (let x = 0; x <= a; x++) {
        const v = dp[a - x].value + f[x].value;
        if (v > nd[a].value) nd[a] = { value: v, pick: [...dp[a - x].pick, x] };
      }
      dp = nd;
    }
    const alloc = dp[A].pick;
    chosen = perSlot.map((f, i) => f[alloc[i] ?? 0]);
    // Resolve free agents claimed by more than one spot.
    const owner = new Map<number, number>();
    let conflict = false;
    chosen.forEach((path, i) => {
      for (const st of path.steps) {
        if (owner.has(st.c)) {
          excluded[i].add(st.c);
          conflict = true;
        } else owner.set(st.c, i);
      }
    });
    if (!conflict) break;
  }

  const moves: StreamMove[] = [];
  chosen.forEach((path, i) => {
    let prev = drops[i].id;
    path.steps.forEach((st, k) => {
      const cand = candidates[st.c - 1];
      const until = k + 1 < path.steps.length ? path.steps[k + 1].t : T;
      const games = remaining.slice(st.t, until).filter((_, j) => cand.v[st.t + j] > 0);
      const effective = remaining[st.t];
      moves.push({
        decideOn: o.addTiming === 'same' ? effective : addDays(effective, -1),
        effective,
        drop: prev,
        add: cand.p.id,
        games,
        value: cand.v.slice(st.t, until).reduce((a, b) => a + b, 0),
      });
      prev = cand.p.id;
    });
  });
  moves.sort((a, b) => a.effective.localeCompare(b.effective));

  return {
    moves,
    candidates: candidates.map((c) => ({
      id: c.p.id,
      value: c.total,
      games: remaining.filter((_, t) => c.v[t] > 0 && t >= firstSwitch),
    })),
  };
}

function evaluate(ctx: EngineCtx, o: StreamOptions, moves: StreamMove[]) {
  const leagueW = valueWeights(ctx.data.model, o.leagueCats);
  const joinDate: Record<string, string> = {};
  const leaveDate: Record<string, string> = {};
  const added: PlayerData[] = [];
  for (const m of moves) {
    joinDate[m.add] = m.effective;
    leaveDate[m.drop] = m.effective;
    added.push(ctx.byId.get(m.add)!);
  }
  return projectWeek(ctx, [...o.roster, ...added], o.days, o.slots, leagueW, { joinDate, leaveDate });
}

export function planStreams(ctx: EngineCtx, o: StreamOptions): StreamPlan {
  const leagueW = valueWeights(ctx.data.model, o.leagueCats);
  const before = projectWeek(ctx, o.roster, o.days, o.slots, leagueW);
  const oppWeek = o.opponent ? projectWeek(ctx, o.opponent, o.days, o.slots, leagueW) : undefined;
  const odds = (w: TeamWeek) => (oppWeek ? compareAggs(w.agg, oppWeek.agg, o.leagueCats).odds : undefined);

  let weights: Partial<Record<CatId, number>> =
    o.mode === 'win' && oppWeek
      ? winProbabilityWeights(ctx, before, oppWeek, o.leagueCats)
      : Object.fromEntries(o.chase.map((c) => [c, 1]));

  let best = { ...planWithWeights(ctx, o, weights), weights };
  let bestAfter = evaluate(ctx, o, best.moves);
  if (o.mode === 'win' && oppWeek) {
    // Re-derive the marginal weights from the new plan; keep the best outcome.
    for (let iter = 0; iter < 2; iter++) {
      weights = winProbabilityWeights(ctx, bestAfter, oppWeek, o.leagueCats);
      const plan = { ...planWithWeights(ctx, o, weights), weights };
      const after = evaluate(ctx, o, plan.moves);
      const score = (w: TeamWeek) => {
        const x = odds(w)!;
        return x.win + 0.5 * x.tie + 0.01 * x.expWins;
      };
      if (score(after) > score(bestAfter) + 1e-9) {
        best = plan;
        bestAfter = after;
      }
    }
  }

  const chaseCats = o.mode === 'chase' ? o.chase : o.leagueCats;
  return {
    moves: best.moves,
    addsUsed: best.moves.length,
    before,
    after: bestAfter,
    chase: chaseCats.map((c) => ({
      cat: c,
      before: catDist(before.agg, CATEGORIES[c]).mean,
      after: catDist(bestAfter.agg, CATEGORIES[c]).mean,
    })),
    oddsBefore: odds(before),
    oddsAfter: odds(bestAfter),
    candidates: best.candidates,
    weights: best.weights,
  };
}
