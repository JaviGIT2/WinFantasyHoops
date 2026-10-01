import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import type { PlayerOverride } from '../engine/context';
import {
  emptyRosters,
  hasContent,
  isPlaceholder,
  mergeRemote,
  migrateV1,
  newLeague,
  normalizeSaved,
  stamp,
  type League,
  type LeagueDoc,
  type LeagueSettings,
  type Remote,
  type SavedState,
  type StreamSettings,
} from './leagues';

export type { League, LeagueSettings, StreamSettings } from './leagues';

export interface AppState extends SavedState {
  // The open league
  updateLeague: (patch: Partial<LeagueSettings>) => void;
  draft: (pid: string, team: number) => void;
  undoPick: () => void;
  resetDraft: () => void;
  /** Sign a free agent to `team`, dropping `drop` from it to make room if given. */
  addPlayer: (team: number, pid: string, drop?: string) => void;
  /** 1-for-1 trade: `team` gets `get` from the team that has him and sends back `give`. */
  tradePlayers: (team: number, get: string, give: string) => void;
  /**
   * Trade between teams `a` and `b`, any number of players each way, then cut `drops` (from either team, incoming
   * players included) to free agency. Ignored unless every traded player is on the team sending him.
   */
  processTrade: (a: number, b: number, aSends: string[], bSends: string[], drops: string[]) => void;
  removeFromRoster: (team: number, pid: string) => void;
  setOpponent: (week: number, team: number) => void;
  updateStream: (patch: Partial<StreamSettings>) => void;
  finishSetup: () => void;

  // Shared by all leagues
  setOverride: (pid: string, patch: PlayerOverride | null) => void;
  setDateOverride: (d: string | null) => void;

  // League list
  createLeague: () => string;
  switchLeague: (id: string) => void;
  deleteLeague: (id: string) => void;

  // Sync bookkeeping (doesn't count as an edit)
  applyRemote: (remote: Remote) => void;
  markSynced: (pushed: { leagues: Record<string, string>; deleted: string[]; prefs?: string }) => void;
}

/** Storage key without accounts; also where the app kept its single league before accounts existed. */
export const DEVICE_KEY = 'win-fantasy-hoops';
export const accountKey = (userId: string) => `${DEVICE_KEY}@${userId}`;

let memory: StateStorage | null = null;

/** localStorage, or sessionStorage / memory where it's blocked (private modes, tests). */
function browserStorage(): StateStorage {
  for (const get of [() => localStorage, () => sessionStorage]) {
    try {
      const s = get();
      s.getItem(DEVICE_KEY);
      return s;
    } catch {
      // blocked or missing: try the next one
    }
  }
  if (!memory) {
    const m = new Map<string, string>();
    memory = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
  }
  return memory;
}

// Nothing is read or written until openStore picks the key (device, or which account), so a stray write can't clobber
// another account's leagues.
let backing: StateStorage | null = null;
const deferred: StateStorage = {
  getItem: (k) => backing?.getItem(k) ?? null,
  setItem: (k, v) => backing?.setItem(k, v),
  removeItem: (k) => backing?.removeItem(k),
};

function initialState(): SavedState {
  const league = newLeague();
  return { leagues: [league], activeId: league.id, deleted: [], overrides: {}, dateOverride: null };
}

export const activeLeague = (s: SavedState): League => s.leagues.find((l) => l.id === s.activeId) ?? s.leagues[0];

/** Apply `edit` to the open league and stamp it for syncing; `edit` returns null for "no change". */
function editOpen(s: SavedState, edit: (l: League) => Partial<LeagueDoc> | null): Partial<SavedState> | SavedState {
  const open = activeLeague(s);
  const patch = edit(open);
  if (!patch) return s;
  return { leagues: s.leagues.map((l) => (l === open ? { ...l, ...patch, updatedAt: stamp(l.updatedAt, l.syncedAt) } : l)) };
}

const prefsStamp = (s: SavedState) => stamp(s.prefsUpdatedAt, s.prefsSyncedAt);

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      ...initialState(),

      updateLeague: (patch) =>
        set((s) =>
          editOpen(s, (l) => {
            const settings = { ...l.settings, ...patch };
            let rosters = l.rosters;
            if (patch.teams !== undefined && patch.teams !== l.settings.teams) {
              const n = patch.teams;
              settings.teamNames = Array.from({ length: n }, (_, i) => l.settings.teamNames[i] ?? `Team ${i + 1}`);
              settings.myTeam = Math.min(settings.myTeam, n - 1);
              rosters = Array.from({ length: n }, (_, i) => l.rosters[i] ?? []);
            }
            if (patch.myTeam !== undefined && patch.myTeam !== l.settings.myTeam) {
              // Keep the "My Team" label on whichever slot is the user's.
              settings.teamNames = settings.teamNames.map((name, i) =>
                i === patch.myTeam && /^Team \d+$/.test(name) ? 'My Team' : i === l.settings.myTeam && name === 'My Team' ? `Team ${i + 1}` : name,
              );
            }
            return { settings, rosters };
          }),
        ),

      draft: (pid, team) =>
        set((s) =>
          editOpen(s, (l) =>
            l.rosters.some((r) => r.includes(pid))
              ? null
              : { picks: [...l.picks, { pid, team }], rosters: l.rosters.map((r, i) => (i === team ? [...r, pid] : r)) },
          ),
        ),

      undoPick: () =>
        set((s) =>
          editOpen(s, (l) => {
            const last = l.picks[l.picks.length - 1];
            if (!last) return null;
            return {
              picks: l.picks.slice(0, -1),
              rosters: l.rosters.map((r, i) => (i === last.team ? r.filter((id) => id !== last.pid) : r)),
            };
          }),
        ),

      resetDraft: () => set((s) => editOpen(s, (l) => ({ picks: [], rosters: emptyRosters(l.settings.teams) }))),

      addPlayer: (team, pid, drop) =>
        set((s) =>
          editOpen(s, (l) => {
            // Only free agents; players on a roster move by trade.
            if (l.rosters.some((r) => r.includes(pid))) return null;
            if (drop !== undefined && !l.rosters[team]?.includes(drop)) return null;
            return {
              rosters: l.rosters.map((r, i) => (i === team ? [...r.filter((x) => x !== drop), pid] : r)),
              stream: { ...l.stream, droppable: l.stream.droppable.filter((x) => x !== drop) },
            };
          }),
        ),

      tradePlayers: (team, get, give) =>
        set((s) =>
          editOpen(s, (l) => {
            const partner = l.rosters.findIndex((r) => r.includes(get));
            if (partner < 0 || partner === team || !l.rosters[team]?.includes(give)) return null;
            // Each player takes the other's place in the roster order.
            return {
              rosters: l.rosters.map((r, i) =>
                i === team ? r.map((x) => (x === give ? get : x)) : i === partner ? r.map((x) => (x === get ? give : x)) : r,
              ),
              stream: { ...l.stream, droppable: l.stream.droppable.filter((x) => x !== give) },
            };
          }),
        ),

      processTrade: (a, b, aSends, bSends, drops) =>
        set((s) =>
          editOpen(s, (l) => {
            const [ra, rb] = [l.rosters[a], l.rosters[b]];
            if (a === b || !ra || !rb || aSends.length + bSends.length === 0) return null;
            if (!aSends.every((id) => ra.includes(id)) || !bSends.every((id) => rb.includes(id))) return null;
            const kept = (ids: string[]) => ids.filter((id) => !drops.includes(id));
            const rosters = l.rosters.map((r, i) =>
              i === a
                ? kept([...r.filter((id) => !aSends.includes(id)), ...bSends])
                : i === b
                  ? kept([...r.filter((id) => !bSends.includes(id)), ...aSends])
                  : r,
            );
            const mine = rosters[l.settings.myTeam] ?? [];
            return { rosters, stream: { ...l.stream, droppable: l.stream.droppable.filter((id) => mine.includes(id)) } };
          }),
        ),

      removeFromRoster: (team, pid) =>
        set((s) =>
          editOpen(s, (l) => ({
            rosters: l.rosters.map((r, i) => (i === team ? r.filter((x) => x !== pid) : r)),
            stream: { ...l.stream, droppable: l.stream.droppable.filter((x) => x !== pid) },
          })),
        ),

      setOpponent: (week, team) => set((s) => editOpen(s, (l) => ({ opponents: { ...l.opponents, [week]: team } }))),
      updateStream: (patch) => set((s) => editOpen(s, (l) => ({ stream: { ...l.stream, ...patch } }))),
      finishSetup: () => set((s) => editOpen(s, () => ({ setupDone: true }))),

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
          return { overrides, prefsUpdatedAt: prefsStamp(s) };
        }),

      setDateOverride: (d) => set((s) => ({ dateOverride: d, prefsUpdatedAt: prefsStamp(s) })),

      createLeague: () => {
        const s = get();
        const names = new Set(s.leagues.map((l) => l.settings.name));
        let n = s.leagues.length + 1;
        while (names.has(`League ${n}`)) n++;
        const league = newLeague(`League ${n}`, true);
        // An untouched placeholder the user has now seen alongside a new league is kept as a real league.
        const leagues = s.leagues.map((l) => (isPlaceholder(l) ? { ...l, updatedAt: stamp() } : l));
        set({ leagues: [...leagues, league], activeId: league.id });
        return league.id;
      },

      switchLeague: (id) => set((s) => (s.leagues.some((l) => l.id === id) ? { activeId: id } : s)),

      deleteLeague: (id) =>
        set((s) => {
          if (!s.leagues.some((l) => l.id === id)) return s;
          const rest = s.leagues.filter((l) => l.id !== id);
          const leagues = rest.length ? rest : [newLeague()];
          return {
            leagues,
            activeId: leagues.some((l) => l.id === s.activeId) ? s.activeId : leagues[0].id,
            // Queued even if it never synced: a push could be in flight, and deleting a missing row is harmless.
            deleted: [...s.deleted, id],
          };
        }),

      applyRemote: (remote) => set((s) => mergeRemote(s, remote)),

      markSynced: ({ leagues, deleted, prefs }) =>
        set((s) => ({
          leagues: s.leagues.map((l) => (Object.hasOwn(leagues, l.id) ? { ...l, syncedAt: leagues[l.id] } : l)),
          deleted: s.deleted.filter((id) => !deleted.includes(id)),
          ...(prefs !== undefined ? { prefsSyncedAt: prefs } : {}),
        })),
    }),
    {
      name: DEVICE_KEY,
      version: 2,
      storage: createJSONStorage(() => deferred),
      skipHydration: true,
      partialize: (s): SavedState => ({
        leagues: s.leagues,
        activeId: s.activeId,
        deleted: s.deleted,
        overrides: s.overrides,
        dateOverride: s.dateOverride,
        prefsUpdatedAt: s.prefsUpdatedAt,
        prefsSyncedAt: s.prefsSyncedAt,
      }),
      migrate: (saved, version) => (version < 2 ? migrateV1(saved) : normalizeSaved(saved)),
      merge: (saved, current) => (saved ? { ...current, ...normalizeSaved(saved) } : current),
    },
  ),
);

/** Select from the open league. */
export function useLeague<T>(select: (l: League) => T): T {
  return useStore((s) => select(activeLeague(s)));
}

/** Load the leagues saved under `key` (this device, or one account on it) and keep saving there. */
export async function openStore(key: string) {
  backing = browserStorage();
  useStore.persist.setOptions({ name: key });
  await useStore.persist.rehydrate();
}

/** Forget an account's leagues on this device (signing out). Nothing is saved after this. */
export function forgetAccount(userId: string) {
  backing = null;
  browserStorage().removeItem(accountKey(userId));
}

/**
 * Move leagues saved on this device without an account into the signed-in account (once: they're removed from the
 * device afterwards). Player overrides come along where the account has none for that player. Returns how many leagues
 * were added.
 */
export function importDeviceLeagues(): number {
  const storage = browserStorage();
  let saved: SavedState;
  try {
    const raw = storage.getItem(DEVICE_KEY) as string | null;
    if (!raw) return 0;
    const { state, version } = JSON.parse(raw) as { state?: unknown; version?: number };
    saved = (version ?? 0) < 2 ? migrateV1(state) : normalizeSaved(state);
  } catch {
    return 0;
  }
  const s = useStore.getState();
  const have = new Set(s.leagues.map((l) => l.id));
  const incoming = saved.leagues.filter((l) => hasContent(l) && !have.has(l.id)).map((l) => ({ ...l, updatedAt: stamp(), syncedAt: undefined }));
  const patch: Partial<SavedState> = {};
  if (incoming.length) {
    const leagues = [...s.leagues.filter((l) => !isPlaceholder(l)), ...incoming];
    patch.leagues = leagues;
    patch.activeId = leagues.some((l) => l.id === s.activeId) ? s.activeId : incoming[0].id;
  }
  const newOverrides = Object.keys(saved.overrides).some((pid) => !(pid in s.overrides));
  const newDate = s.dateOverride === null && saved.dateOverride !== null;
  if (newOverrides || newDate) {
    patch.overrides = { ...saved.overrides, ...s.overrides };
    patch.dateOverride = s.dateOverride ?? saved.dateOverride;
    patch.prefsUpdatedAt = prefsStamp(s);
  }
  if (Object.keys(patch).length) useStore.setState(patch);
  storage.removeItem(DEVICE_KEY);
  return incoming.length;
}

/** Team on the clock for overall pick `n` (0-based) in a snake draft. */
export function snakeTeam(n: number, teams: number) {
  const round = Math.floor(n / teams);
  const i = n % teams;
  return round % 2 === 0 ? i : teams - 1 - i;
}
