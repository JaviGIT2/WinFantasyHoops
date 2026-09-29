import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { FORMAT_PRESETS, type CatId } from '../engine/categories';
import type { PlayerOverride } from '../engine/context';
import { DEFAULT_SLOTS, type SlotCounts } from '../engine/lineup';

export interface LeagueSettings {
  name: string;
  teams: number;
  teamNames: string[];
  /** Index of the user's team (also their draft slot − 1). */
  myTeam: number;
  formatId: string;
  cats: CatId[];
  punts: CatId[];
  /** Per-category multipliers for the draft pool rankings (missing = ×1). */
  catWeights?: Partial<Record<CatId, number>>;
  slots: SlotCounts;
  weeklyAdds: number;
  addTiming: 'same' | 'next';
  /** Record every pick (all teams) instead of only your own. */
  trackAllTeams: boolean;
}

export interface StreamSettings {
  mode: 'chase' | 'win';
  chase: CatId[];
  droppable: string[];
  /** Adds already used, per fantasy week. */
  addsUsed: Record<number, number>;
}

export interface AppState {
  league: LeagueSettings;
  /** Draft picks in order. */
  picks: { pid: string; team: number }[];
  /** Current rosters (player ids) per team; the draft writes here, later edits too. */
  rosters: string[][];
  overrides: Record<string, PlayerOverride>;
  /** Weekly opponent (team index) per fantasy week. */
  opponents: Record<number, number>;
  stream: StreamSettings;
  /** Optional "today" for planning ahead (e.g. before the season starts). */
  dateOverride: string | null;
  setupDone: boolean;

  updateLeague: (patch: Partial<LeagueSettings>) => void;
  draft: (pid: string, team: number) => void;
  undoPick: () => void;
  resetDraft: () => void;
  addToRoster: (team: number, pid: string) => void;
  removeFromRoster: (team: number, pid: string) => void;
  movePlayer: (pid: string, toTeam: number) => void;
  setOverride: (pid: string, patch: PlayerOverride | null) => void;
  setOpponent: (week: number, team: number) => void;
  updateStream: (patch: Partial<StreamSettings>) => void;
  setDateOverride: (d: string | null) => void;
  finishSetup: () => void;
}

const defaultNames = (n: number, mine: number) =>
  Array.from({ length: n }, (_, i) => (i === mine ? 'My Team' : `Team ${i + 1}`));

const initialLeague: LeagueSettings = {
  name: 'My League',
  teams: 12,
  teamNames: defaultNames(12, 0),
  myTeam: 0,
  formatId: '9cat',
  cats: FORMAT_PRESETS[0].cats,
  punts: [],
  catWeights: {},
  slots: DEFAULT_SLOTS,
  weeklyAdds: 4,
  addTiming: 'next',
  trackAllTeams: true,
};

const emptyRosters = (n: number) => Array.from({ length: n }, () => [] as string[]);

export const useStore = create<AppState>()(
  persist(
    (set) => ({
      league: initialLeague,
      picks: [],
      rosters: emptyRosters(12),
      overrides: {},
      opponents: {},
      stream: { mode: 'win', chase: ['BLK', 'STL'], droppable: [], addsUsed: {} },
      dateOverride: null,
      setupDone: false,

      updateLeague: (patch) =>
        set((s) => {
          const league = { ...s.league, ...patch };
          let rosters = s.rosters;
          if (patch.teams !== undefined && patch.teams !== s.league.teams) {
            const n = patch.teams;
            league.teamNames = Array.from({ length: n }, (_, i) => s.league.teamNames[i] ?? `Team ${i + 1}`);
            league.myTeam = Math.min(league.myTeam, n - 1);
            rosters = Array.from({ length: n }, (_, i) => s.rosters[i] ?? []);
          }
          if (patch.myTeam !== undefined && patch.myTeam !== s.league.myTeam) {
            // Keep the "My Team" label on whichever slot is the user's.
            league.teamNames = league.teamNames.map((name, i) =>
              i === patch.myTeam && /^Team \d+$/.test(name) ? 'My Team' : i === s.league.myTeam && name === 'My Team' ? `Team ${i + 1}` : name,
            );
          }
          return { league, rosters };
        }),

      draft: (pid, team) =>
        set((s) => {
          if (s.rosters.some((r) => r.includes(pid))) return s;
          const rosters = s.rosters.map((r, i) => (i === team ? [...r, pid] : r));
          return { picks: [...s.picks, { pid, team }], rosters };
        }),

      undoPick: () =>
        set((s) => {
          const last = s.picks[s.picks.length - 1];
          if (!last) return s;
          return {
            picks: s.picks.slice(0, -1),
            rosters: s.rosters.map((r, i) => (i === last.team ? r.filter((id) => id !== last.pid) : r)),
          };
        }),

      resetDraft: () => set((s) => ({ picks: [], rosters: emptyRosters(s.league.teams) })),

      addToRoster: (team, pid) =>
        set((s) => ({
          rosters: s.rosters.map((r, i) => (i === team ? [...r.filter((x) => x !== pid), pid] : r.filter((x) => x !== pid))),
        })),

      removeFromRoster: (team, pid) =>
        set((s) => ({
          rosters: s.rosters.map((r, i) => (i === team ? r.filter((x) => x !== pid) : r)),
          stream: { ...s.stream, droppable: s.stream.droppable.filter((x) => x !== pid) },
        })),

      movePlayer: (pid, toTeam) =>
        set((s) => ({
          rosters: s.rosters.map((r, i) => (i === toTeam ? [...r.filter((x) => x !== pid), pid] : r.filter((x) => x !== pid))),
        })),

      setOverride: (pid, patch) =>
        set((s) => {
          const overrides = { ...s.overrides };
          if (patch === null) delete overrides[pid];
          else {
            const merged = { ...overrides[pid], ...patch };
            for (const k of Object.keys(merged) as (keyof PlayerOverride)[]) if (merged[k] === undefined) delete merged[k];
            if (Object.keys(merged).length) overrides[pid] = merged;
            else delete overrides[pid];
          }
          return { overrides };
        }),

      setOpponent: (week, team) => set((s) => ({ opponents: { ...s.opponents, [week]: team } })),
      updateStream: (patch) => set((s) => ({ stream: { ...s.stream, ...patch } })),
      setDateOverride: (d) => set({ dateOverride: d }),
      finishSetup: () => set({ setupDone: true }),
    }),
    {
      name: 'win-fantasy-hoops',
      version: 1,
      storage: createJSONStorage(() => {
        try {
          return localStorage;
        } catch {
          return sessionStorage;
        }
      }),
    },
  ),
);

/** Team on the clock for overall pick `n` (0-based) in a snake draft. */
export function snakeTeam(n: number, teams: number) {
  const round = Math.floor(n / teams);
  const i = n % teams;
  return round % 2 === 0 ? i : teams - 1 - i;
}
