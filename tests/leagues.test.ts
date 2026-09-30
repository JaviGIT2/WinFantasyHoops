import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  hasPendingChanges,
  isDirty,
  isPlaceholder,
  mergeRemote,
  migrateV1,
  newLeague,
  normalizeDoc,
  stamp,
  type League,
  type Remote,
  type SavedState,
} from '../src/state/leagues';
import { activeLeague, DEVICE_KEY, importDeviceLeagues, useStore } from '../src/state/store';

const T0 = '2026-10-01T12:00:00.000Z';
const T1 = '2026-10-01T12:05:00.000Z';
const T2 = '2026-10-01T12:10:00.000Z';

/** A league as last synced with the server at `at`. */
function synced(name: string, at = T0): League {
  return { ...newLeague(name), updatedAt: at, syncedAt: at };
}

function state(leagues: League[], extra: Partial<SavedState> = {}): SavedState {
  return { leagues, activeId: leagues[0].id, deleted: [], overrides: {}, dateOverride: null, ...extra };
}

const row = (l: League, at: string, patch: Partial<League['settings']> = {}): Remote['leagues'][number] => ({
  id: l.id,
  data: { settings: { ...l.settings, ...patch }, picks: l.picks, rosters: l.rosters, opponents: l.opponents, stream: l.stream, setupDone: l.setupDone },
  updatedAt: at,
});

function resetStore(s: SavedState = state([newLeague()])) {
  useStore.setState({ ...s, prefsUpdatedAt: s.prefsUpdatedAt, prefsSyncedAt: s.prefsSyncedAt });
}

describe('saved state', () => {
  it('moves the single league of the v1 format into the league list', () => {
    const v1 = {
      league: { name: 'Work league', teams: 10, myTeam: 3, formatId: '9cat', cats: ['PTS', 'REB'] },
      picks: [{ pid: 'a', team: 3 }],
      rosters: [[], [], [], ['a']],
      overrides: { a: { min: 30 } },
      opponents: { 1: 2 },
      stream: { mode: 'chase', chase: ['PTS'], droppable: [], addsUsed: {} },
      dateOverride: '2026-10-20',
      setupDone: true,
    };
    const s = migrateV1(v1);
    expect(s.leagues).toHaveLength(1);
    const l = s.leagues[0];
    expect(s.activeId).toBe(l.id);
    expect(l.settings.name).toBe('Work league');
    expect(l.picks).toEqual([{ pid: 'a', team: 3 }]);
    // rosters padded to the team count; names filled in
    expect(l.rosters).toHaveLength(10);
    expect(l.rosters[3]).toEqual(['a']);
    expect(l.settings.teamNames).toHaveLength(10);
    expect(l.opponents).toEqual({ 1: 2 });
    expect(l.setupDone).toBe(true);
    expect(s.overrides).toEqual({ a: { min: 30 } });
    expect(s.dateOverride).toBe('2026-10-20');
  });

  it('repairs leagues with missing or mismatched fields', () => {
    const d = normalizeDoc({ settings: { teams: 3, teamNames: ['A'] }, rosters: [['x']] });
    expect(d.settings.teamNames).toEqual(['A', 'Team 2', 'Team 3']);
    expect(d.rosters).toEqual([['x'], [], []]);
    expect(d.stream.mode).toBe('win');
    expect(normalizeDoc(null).settings.teams).toBe(12);
  });
});

describe('league store', () => {
  beforeEach(() => resetStore());

  it('keeps each league’s draft and rosters separate', () => {
    const s = useStore.getState();
    const first = s.activeId;
    s.draft('p1', 0);
    const second = s.createLeague();
    expect(useStore.getState().activeId).toBe(second);
    expect(activeLeague(useStore.getState()).picks).toEqual([]);
    useStore.getState().draft('p1', 4);
    useStore.getState().updateLeague({ teams: 10 });

    useStore.getState().switchLeague(first);
    const a = activeLeague(useStore.getState());
    expect(a.picks).toEqual([{ pid: 'p1', team: 0 }]);
    expect(a.settings.teams).toBe(12);
    const b = useStore.getState().leagues.find((l) => l.id === second)!;
    expect(b.rosters[4]).toEqual(['p1']);
    expect(b.settings.teams).toBe(10);
    expect(b.rosters).toHaveLength(10);
  });

  it('stamps edits for syncing, but not switching leagues', () => {
    const s = useStore.getState();
    expect(isPlaceholder(activeLeague(s))).toBe(true);
    expect(hasPendingChanges(useStore.getState())).toBe(false);
    s.updateLeague({ name: 'Renamed' });
    expect(isDirty(activeLeague(useStore.getState()))).toBe(true);

    const other = useStore.getState().createLeague();
    useStore.getState().markSynced({
      leagues: Object.fromEntries(useStore.getState().leagues.map((l) => [l.id, l.updatedAt!])),
      deleted: [],
    });
    expect(hasPendingChanges(useStore.getState())).toBe(false);
    useStore.getState().switchLeague(useStore.getState().leagues[0].id);
    useStore.getState().switchLeague(other);
    expect(hasPendingChanges(useStore.getState())).toBe(false);
  });

  it('shares player overrides and the planning date across leagues', () => {
    useStore.getState().setOverride('p9', { min: 12 });
    useStore.getState().createLeague();
    expect(useStore.getState().overrides).toEqual({ p9: { min: 12 } });
    expect(useStore.getState().prefsUpdatedAt).toBeDefined();
  });

  it('deleting the open league opens another and queues the delete; the last one is replaced', () => {
    const first = useStore.getState().activeId;
    const second = useStore.getState().createLeague();
    useStore.getState().deleteLeague(second);
    expect(useStore.getState().activeId).toBe(first);
    expect(useStore.getState().deleted).toEqual([second]);

    useStore.getState().deleteLeague(first);
    const s = useStore.getState();
    expect(s.leagues).toHaveLength(1);
    expect(s.leagues[0].id).not.toBe(first);
    expect(s.activeId).toBe(s.leagues[0].id);
    expect(s.deleted).toEqual([second, first]);
  });

  it('keeps an untouched placeholder once a second league is created', () => {
    const placeholder = useStore.getState().activeId;
    useStore.getState().createLeague();
    const kept = useStore.getState().leagues.find((l) => l.id === placeholder)!;
    expect(isPlaceholder(kept)).toBe(false);
    expect(isDirty(kept)).toBe(true);
  });
});

describe('stamp', () => {
  it('is later than the versions it builds on, even when the clock is behind', () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    expect(Date.parse(stamp(future))).toBe(Date.parse(future) + 1);
    expect(Date.parse(stamp())).toBeLessThanOrEqual(Date.now());
  });
});

describe('merging the account copy', () => {
  it('adds leagues from the server and takes server edits over unchanged local copies', () => {
    const a = synced('A');
    const b = synced('B');
    const local = state([a]);
    const out = mergeRemote(local, { leagues: [row(a, T1, { name: 'A edited elsewhere' }), row(b, T0)], prefs: null });
    expect(out.leagues!.map((l) => l.settings.name)).toEqual(['A edited elsewhere', 'B']);
    expect(out.leagues!.every((l) => !isDirty(l))).toBe(true);
  });

  it('keeps unsynced local edits unless the server has a newer one', () => {
    const a = { ...synced('A'), updatedAt: T1 };
    const keep = mergeRemote(state([a]), { leagues: [row(a, T0)], prefs: null });
    expect(keep.leagues![0]).toBe(a);

    const lose = mergeRemote(state([a]), { leagues: [row(a, T2, { name: 'newer' })], prefs: null });
    expect(lose.leagues![0].settings.name).toBe('newer');
    expect(isDirty(lose.leagues![0])).toBe(false);

    const older = mergeRemote(state([a]), { leagues: [row(a, '2026-10-01T12:01:00.000Z', { name: 'older' })], prefs: null });
    expect(older.leagues![0]).toBe(a);
  });

  it('drops leagues deleted on another device but keeps ones created here', () => {
    const gone = synced('gone');
    const fresh = { ...newLeague('fresh'), updatedAt: T1 };
    const editedAfterDelete = { ...synced('edited'), updatedAt: T1 };
    const out = mergeRemote(state([gone, fresh, editedAfterDelete]), { leagues: [], prefs: null });
    expect(out.leagues!.map((l) => l.settings.name)).toEqual(['fresh', 'edited']);
    expect(out.activeId).toBe(fresh.id);
  });

  it('replaces the placeholder league once the account has leagues', () => {
    const placeholder = newLeague();
    const b = synced('B');
    const out = mergeRemote(state([placeholder]), { leagues: [row(b, T0)], prefs: null });
    expect(out.leagues!.map((l) => l.id)).toEqual([b.id]);
    expect(out.activeId).toBe(b.id);

    const empty = mergeRemote(state([placeholder]), { leagues: [], prefs: null });
    expect(empty.leagues).toEqual([placeholder]);
  });

  it('does not bring back a league deleted here that the server still has', () => {
    const a = synced('A');
    const b = synced('B');
    const out = mergeRemote(state([a], { deleted: [b.id] }), { leagues: [row(a, T0), row(b, T0)], prefs: null });
    expect(out.leagues!.map((l) => l.id)).toEqual([a.id]);
  });

  it('returns the same objects when nothing changed', () => {
    const a = synced('A');
    const local = state([a]);
    const out = mergeRemote(local, { leagues: [row(a, T0)], prefs: null });
    expect(out.leagues).toBe(local.leagues);
  });

  it('takes the server’s player overrides, or merges them when both sides changed', () => {
    const l = synced('A');
    const clean = state([l], { overrides: { x: { min: 1 } }, prefsUpdatedAt: T0, prefsSyncedAt: T0 });
    const taken = mergeRemote(clean, { leagues: [row(l, T0)], prefs: { data: { overrides: { y: { min: 2 } }, dateOverride: null }, updatedAt: T1 } });
    expect(taken.overrides).toEqual({ y: { min: 2 } });
    expect(taken.prefsSyncedAt).toBe(T1);

    const both = state([l], { overrides: { x: { min: 1 }, z: { min: 5 } }, prefsUpdatedAt: T2, prefsSyncedAt: T0 });
    const merged = mergeRemote(both, { leagues: [row(l, T0)], prefs: { data: { overrides: { y: { min: 2 }, z: { min: 9 } }, dateOverride: null }, updatedAt: T1 } });
    expect(merged.overrides).toEqual({ x: { min: 1 }, y: { min: 2 }, z: { min: 5 } });
    expect(merged.prefsSyncedAt).toBe(T1);
    expect(Date.parse(merged.prefsUpdatedAt!)).toBeGreaterThan(Date.parse(T2));
  });
});

describe('importing leagues saved on this device before accounts', () => {
  const saved = new Map<string, string>();
  beforeEach(() => {
    saved.clear();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => saved.get(k) ?? null,
      setItem: (k: string, v: string) => void saved.set(k, v),
      removeItem: (k: string) => void saved.delete(k),
    });
    resetStore();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('adds the old single league to the account once, replacing the placeholder', () => {
    saved.set(
      DEVICE_KEY,
      JSON.stringify({ version: 1, state: { league: { name: 'Home league' }, picks: [{ pid: 'a', team: 0 }], rosters: [['a']], overrides: { a: { min: 20 } }, setupDone: true } }),
    );
    expect(importDeviceLeagues()).toBe(1);
    const s = useStore.getState();
    expect(s.leagues.map((l) => l.settings.name)).toEqual(['Home league']);
    expect(s.activeId).toBe(s.leagues[0].id);
    expect(isDirty(s.leagues[0])).toBe(true);
    expect(s.overrides).toEqual({ a: { min: 20 } });
    expect(saved.has(DEVICE_KEY)).toBe(false);
    expect(importDeviceLeagues()).toBe(0);
  });

  it('skips untouched leagues', () => {
    const blank = newLeague();
    saved.set(DEVICE_KEY, JSON.stringify({ version: 2, state: state([blank]) }));
    expect(importDeviceLeagues()).toBe(0);
    expect(useStore.getState().leagues.some((l) => l.id === blank.id)).toBe(false);
    expect(saved.has(DEVICE_KEY)).toBe(false);
  });
});
