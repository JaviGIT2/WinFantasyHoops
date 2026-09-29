import type { Pos } from '../data/types';

/** Yahoo active roster slots. BN (bench) and IL slots never score. */
export type Slot = 'PG' | 'SG' | 'G' | 'SF' | 'PF' | 'F' | 'C' | 'UTIL';
export const ACTIVE_SLOTS: Slot[] = ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C', 'UTIL'];

export const SLOT_ELIG: Record<Slot, Pos[]> = {
  PG: ['PG'],
  SG: ['SG'],
  G: ['PG', 'SG'],
  SF: ['SF'],
  PF: ['PF'],
  F: ['SF', 'PF'],
  C: ['C'],
  UTIL: ['PG', 'SG', 'SF', 'PF', 'C'],
};

export type SlotCounts = Record<Slot | 'BN' | 'IL', number>;

/** Yahoo's default: PG, SG, G, SF, PF, F, C, C, UTIL, UTIL + 3 bench + 1 IL. */
export const DEFAULT_SLOTS: SlotCounts = { PG: 1, SG: 1, G: 1, SF: 1, PF: 1, F: 1, C: 2, UTIL: 2, BN: 3, IL: 1 };

export const expandSlots = (counts: SlotCounts): Slot[] =>
  ACTIVE_SLOTS.flatMap((s) => Array.from({ length: counts[s] ?? 0 }, () => s));

export const rosterSize = (counts: SlotCounts) => expandSlots(counts).length + (counts.BN ?? 0);

export interface LineupCandidate {
  id: string;
  elig: Pos[];
  /** Positive value of starting this player today. */
  value: number;
}

export interface LineupResult {
  started: string[];
  benched: string[];
  slotOf: Map<string, Slot>;
  value: number;
}

/**
 * Best daily lineup: maximum-value assignment of players to active slots,
 * honoring position eligibility (Hungarian algorithm). Players who don't fit an
 * open slot sit on the bench and their games don't count.
 */
export function bestLineup(players: LineupCandidate[], slots: Slot[]): LineupResult {
  const n = players.length;
  if (n === 0) return { started: [], benched: [], slotOf: new Map(), value: 0 };
  const eligible = (i: number, j: number) => players[i].elig.some((p) => SLOT_ELIG[slots[j]].includes(p));

  // Fast path: everyone fits if a greedy placement (scarcest eligibility first) succeeds.
  if (n <= slots.length) {
    const order = [...players.keys()].sort((a, b) => players[a].elig.length - players[b].elig.length);
    const used = new Array(slots.length).fill(false);
    const slotOf = new Map<string, Slot>();
    // Fill restrictive slots first so UTIL stays available for whoever needs it.
    const slotOrder = [...slots.keys()].sort((a, b) => SLOT_ELIG[slots[a]].length - SLOT_ELIG[slots[b]].length);
    let ok = true;
    for (const i of order) {
      const j = slotOrder.find((s) => !used[s] && eligible(i, s));
      if (j === undefined) {
        ok = false;
        break;
      }
      used[j] = true;
      slotOf.set(players[i].id, slots[j]);
    }
    if (ok) {
      return { started: players.map((p) => p.id), benched: [], slotOf, value: players.reduce((s, p) => s + p.value, 0) };
    }
  }

  // Columns: active slots, then one bench column per player (value 0).
  const m = slots.length + n;
  const BIG = 1e9;
  const cost = (i: number, j: number) => {
    if (j >= slots.length) return 0;
    return eligible(i, j) ? -players[i].value : BIG;
  };
  const assign = hungarian(n, m, cost);
  const started: string[] = [];
  const benched: string[] = [];
  const slotOf = new Map<string, Slot>();
  let value = 0;
  assign.forEach((j, i) => {
    if (j < slots.length && eligible(i, j)) {
      started.push(players[i].id);
      slotOf.set(players[i].id, slots[j]);
      value += players[i].value;
    } else benched.push(players[i].id);
  });
  return { started, benched, slotOf, value };
}

/**
 * Minimum-cost assignment of n rows to distinct columns among m ≥ n (e-maxx
 * Hungarian with potentials, O(n²m)). Returns the column for each row.
 */
export function hungarian(n: number, m: number, cost: (i: number, j: number) => number): number[] {
  const INF = Number.POSITIVE_INFINITY;
  const u = new Array(n + 1).fill(0);
  const v = new Array(m + 1).fill(0);
  const p = new Array(m + 1).fill(0); // p[j] = row matched to column j (1-based), 0 = free
  const way = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(m + 1).fill(INF);
    const used = new Array(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost(i0 - 1, j - 1) - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }
  const result = new Array(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j]) result[p[j] - 1] = j - 1;
  return result;
}
