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

/** Everything that belongs to one fantasy league. It syncs to the account as a single document. */
export interface LeagueDoc {
  settings: LeagueSettings;
  /** Draft picks in order. */
  picks: { pid: string; team: number }[];
  /** Current rosters (player ids) per team; the draft writes here, later edits too. */
  rosters: string[][];
  /** Weekly opponent (team index) per fantasy week. */
  opponents: Record<number, number>;
  stream: StreamSettings;
  setupDone: boolean;
}

export interface League extends LeagueDoc {
  id: string;
  /** Time of the last local edit (ISO). Unset on a placeholder league nobody has touched. */
  updatedAt?: string;
  /** `updatedAt` of the version the server last confirmed. Unset until the league first syncs. */
  syncedAt?: string;
}

/** Account-wide: player adjustments describe the real NBA, so every league shares them. */
export interface Prefs {
  overrides: Record<string, PlayerOverride>;
  /** Optional "today" for planning ahead (e.g. before the season starts). */
  dateOverride: string | null;
}

/** The saved part of the app state (per account, or per device without accounts). */
export interface SavedState extends Prefs {
  leagues: League[];
  activeId: string;
  /** Leagues deleted here that the server may still have. */
  deleted: string[];
  prefsUpdatedAt?: string;
  prefsSyncedAt?: string;
}

/** The account's copy, as fetched from the server. */
export interface Remote {
  leagues: { id: string; data: unknown; updatedAt: string }[];
  prefs: { data: unknown; updatedAt: string } | null;
}

/** Bumped if the synced league document ever changes shape, so old rows can be migrated. */
const DOC_VERSION = 1;

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const ms = (t?: string) => (t ? Date.parse(t) : 0);

/** A random UUID; `crypto.randomUUID` only exists on HTTPS or localhost, so fall back for phones testing a LAN dev server. */
export function newId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Timestamp for a new edit: now, but always after the versions it builds on. Last-write-wins compares these across
 * devices, so an edit from a device whose clock runs slow still beats the version it replaced.
 */
export function stamp(...after: (string | undefined)[]): string {
  return new Date(Math.max(Date.now(), ...after.map((t) => ms(t) + 1))).toISOString();
}

export const defaultTeamNames = (n: number, mine: number) =>
  Array.from({ length: n }, (_, i) => (i === mine ? 'My Team' : `Team ${i + 1}`));

export const emptyRosters = (n: number) => Array.from({ length: n }, () => [] as string[]);

function defaultSettings(): LeagueSettings {
  return {
    name: 'My League',
    teams: 12,
    teamNames: defaultTeamNames(12, 0),
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
}

const defaultStream = (): StreamSettings => ({ mode: 'win', chase: ['BLK', 'STL'], droppable: [], addsUsed: {} });

/**
 * A league with default settings. Unless `edited`, it is a placeholder: it stands in until the account has a real
 * league and isn't synced until someone changes it.
 */
export function newLeague(name?: string, edited = false): League {
  const settings = defaultSettings();
  if (name) settings.name = name;
  return {
    id: newId(),
    settings,
    picks: [],
    rosters: emptyRosters(settings.teams),
    opponents: {},
    stream: defaultStream(),
    setupDone: false,
    ...(edited ? { updatedAt: stamp() } : {}),
  };
}

export const leagueName = (l: League) => l.settings.name.trim() || 'Untitled league';

/** Fill in anything missing or malformed (older app versions, older rows) so the views can rely on the shape. */
export function normalizeDoc(raw: unknown): LeagueDoc {
  const d = isObj(raw) ? raw : {};
  const settings: LeagueSettings = { ...defaultSettings(), ...(isObj(d.settings) ? (d.settings as Partial<LeagueSettings>) : {}) };
  const n = Number.isInteger(settings.teams) && settings.teams > 0 ? settings.teams : 12;
  const names: unknown[] = Array.isArray(settings.teamNames) ? settings.teamNames : [];
  settings.teams = n;
  settings.teamNames = Array.from({ length: n }, (_, i) => (typeof names[i] === 'string' ? (names[i] as string) : `Team ${i + 1}`));
  settings.myTeam = Math.min(Math.max(0, Number(settings.myTeam) || 0), n - 1);
  settings.slots = { ...DEFAULT_SLOTS, ...settings.slots };
  const rosters: unknown[] = Array.isArray(d.rosters) ? d.rosters : [];
  return {
    settings,
    picks: Array.isArray(d.picks) ? (d.picks as LeagueDoc['picks']) : [],
    rosters: Array.from({ length: n }, (_, i) => (Array.isArray(rosters[i]) ? (rosters[i] as string[]) : [])),
    opponents: isObj(d.opponents) ? (d.opponents as LeagueDoc['opponents']) : {},
    stream: { ...defaultStream(), ...(isObj(d.stream) ? (d.stream as Partial<StreamSettings>) : {}) },
    setupDone: d.setupDone === true,
  };
}

/** The document stored on the server for a league (no local sync bookkeeping). */
export function leagueDoc(l: League): LeagueDoc & { v: number } {
  const { settings, picks, rosters, opponents, stream, setupDone } = l;
  return { v: DOC_VERSION, settings, picks, rosters, opponents, stream, setupDone };
}

function normalizePrefs(raw: unknown): Prefs {
  const d = isObj(raw) ? raw : {};
  return {
    overrides: isObj(d.overrides) ? (d.overrides as Prefs['overrides']) : {},
    dateOverride: typeof d.dateOverride === 'string' ? d.dateOverride : null,
  };
}

export const prefsDoc = (s: Prefs): Prefs => ({ overrides: s.overrides, dateOverride: s.dateOverride });

const str = (x: unknown) => (typeof x === 'string' ? x : undefined);

/** Check saved state read from storage and repair anything that would break the app (at least one league, a valid open league). */
export function normalizeSaved(raw: unknown): SavedState {
  const o = isObj(raw) ? raw : {};
  const leagues: League[] = (Array.isArray(o.leagues) ? o.leagues : []).filter(isObj).map((l) => ({
    id: str(l.id) ?? newId(),
    ...normalizeDoc(l),
    updatedAt: str(l.updatedAt),
    syncedAt: str(l.syncedAt),
  }));
  if (!leagues.length) leagues.push(newLeague());
  const activeId = str(o.activeId);
  return {
    leagues,
    activeId: leagues.some((l) => l.id === activeId) ? activeId! : leagues[0].id,
    deleted: Array.isArray(o.deleted) ? o.deleted.filter((x): x is string => typeof x === 'string') : [],
    ...normalizePrefs(o),
    prefsUpdatedAt: str(o.prefsUpdatedAt),
    prefsSyncedAt: str(o.prefsSyncedAt),
  };
}

/** Version 1 of the saved state held a single league at the top level. */
export function migrateV1(old: unknown): SavedState {
  const o = isObj(old) ? old : {};
  const league: League = {
    id: newId(),
    ...normalizeDoc({ settings: o.league, picks: o.picks, rosters: o.rosters, opponents: o.opponents, stream: o.stream, setupDone: o.setupDone }),
  };
  return { leagues: [league], activeId: league.id, deleted: [], ...normalizePrefs(o) };
}

export const isDirty = (x: { updatedAt?: string; syncedAt?: string }) => x.updatedAt !== x.syncedAt;
export const isPlaceholder = (l: League) => l.updatedAt === undefined && l.syncedAt === undefined;
export const prefsDirty = (s: SavedState) => s.prefsUpdatedAt !== s.prefsSyncedAt;
export const hasPendingChanges = (s: SavedState) => s.leagues.some(isDirty) || s.deleted.length > 0 || prefsDirty(s);

/** Whether a league holds anything worth keeping, as opposed to untouched defaults. */
export function hasContent(l: LeagueDoc): boolean {
  return (
    l.setupDone ||
    l.picks.length > 0 ||
    l.rosters.some((r) => r.length > 0) ||
    JSON.stringify(normalizeDoc({ settings: l.settings }).settings) !== JSON.stringify(normalizeDoc({}).settings)
  );
}

/**
 * Fold the account's copy into local state. For each league, and for the prefs, the newer edit wins. A league the server no
 * longer has was deleted on another device and is dropped, unless it has edits here that haven't synced. Unchanged leagues
 * keep their object identity so the views don't recompute.
 */
export function mergeRemote(local: SavedState, remote: Remote): Partial<SavedState> {
  const server = new Map(remote.leagues.map((r) => [r.id, r]));
  const localIds = new Set(local.leagues.map((l) => l.id));
  const fromServer = (r: Remote['leagues'][number]): League => ({ id: r.id, ...normalizeDoc(r.data), updatedAt: r.updatedAt, syncedAt: r.updatedAt });

  let leagues: League[] = [];
  for (const l of local.leagues) {
    const r = server.get(l.id);
    if (!r) {
      if (isDirty(l) || isPlaceholder(l)) leagues.push(l);
    } else if (r.updatedAt === l.syncedAt || (isDirty(l) && ms(l.updatedAt) >= ms(r.updatedAt))) {
      leagues.push(l);
    } else {
      leagues.push(fromServer(r));
    }
  }
  for (const r of remote.leagues) if (!localIds.has(r.id) && !local.deleted.includes(r.id)) leagues.push(fromServer(r));
  if (leagues.some((l) => !isPlaceholder(l))) leagues = leagues.filter((l) => !isPlaceholder(l));
  if (!leagues.length) leagues.push(newLeague());
  if (leagues.length === local.leagues.length && leagues.every((l, i) => l === local.leagues[i])) leagues = local.leagues;

  const out: Partial<SavedState> = {
    leagues,
    activeId: leagues.some((l) => l.id === local.activeId) ? local.activeId : leagues[0].id,
  };

  const rp = remote.prefs;
  if (rp && rp.updatedAt !== local.prefsSyncedAt) {
    const theirs = normalizePrefs(rp.data);
    if (!prefsDirty(local)) {
      Object.assign(out, theirs, { prefsUpdatedAt: rp.updatedAt, prefsSyncedAt: rp.updatedAt });
    } else {
      // Both sides changed: keep every player override from both, the newer side winning where they overlap.
      const oursNewer = ms(local.prefsUpdatedAt) >= ms(rp.updatedAt);
      Object.assign(out, {
        overrides: oursNewer ? { ...theirs.overrides, ...local.overrides } : { ...local.overrides, ...theirs.overrides },
        dateOverride: oursNewer ? local.dateOverride : theirs.dateOverride,
        prefsUpdatedAt: stamp(local.prefsUpdatedAt, rp.updatedAt),
        prefsSyncedAt: rp.updatedAt,
      });
    }
  }
  return out;
}
