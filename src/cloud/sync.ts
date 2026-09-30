import { create } from 'zustand';
import { hasPendingChanges, isDirty, leagueDoc, prefsDirty, prefsDoc, type Remote } from '../state/leagues';
import { useStore } from '../state/store';
import { supabase } from './supabase';

export interface SyncStatus {
  phase: 'idle' | 'syncing' | 'offline' | 'error';
  error: string | null;
  lastSynced: string | null;
}

export const useSyncStatus = create<SyncStatus>(() => ({ phase: 'idle', error: null, lastSynced: null }));

interface Row {
  id?: string;
  data: unknown;
  updated_at: string;
}

const unreachable = new Error('Offline');
const iso = (t: string) => new Date(t).toISOString();
const messageOf = (e: unknown) => (e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e));
const isNetworkError = (e: unknown) => /fetch|network|load failed|timed? ?out/i.test(messageOf(e));

async function signedInAs(userId: string) {
  const { data } = await supabase!.auth.getSession();
  return data.session?.user.id === userId;
}

/** Fetch the account's leagues and player overrides and fold them into local state. */
export async function pullNow(userId: string): Promise<void> {
  const [leagues, prefs] = await Promise.all([
    supabase!.from('leagues').select('id, data, updated_at').eq('user_id', userId).order('created_at'),
    supabase!.from('user_prefs').select('data, updated_at').eq('user_id', userId).maybeSingle(),
  ]);
  if (leagues.error) throw leagues.error;
  if (prefs.error) throw prefs.error;
  // A request sent after the session ended would come back empty, which would read as "every league was deleted".
  if (!(await signedInAs(userId))) throw new Error('Signed out');
  const p = prefs.data as Row | null;
  const remote: Remote = {
    leagues: (leagues.data as Row[]).map((r) => ({ id: r.id!, data: r.data, updatedAt: iso(r.updated_at) })),
    prefs: p ? { data: p.data, updatedAt: iso(p.updated_at) } : null,
  };
  useStore.getState().applyRemote(remote);
}

/**
 * Send local edits and deletions. The server ignores a write older than what it has (see supabase/schema.sql), so this
 * returns true when something newer is waiting there to be pulled.
 */
async function pushNow(userId: string): Promise<boolean> {
  const s = useStore.getState();
  const dirty = s.leagues.filter(isDirty);
  const deleted = [...s.deleted];
  const prefsAt = prefsDirty(s) ? s.prefsUpdatedAt : undefined;
  let newerOnServer = false;
  if (dirty.length) {
    const rows = dirty.map((l) => ({ id: l.id, user_id: userId, data: leagueDoc(l), updated_at: l.updatedAt }));
    const { data, error } = await supabase!.from('leagues').upsert(rows).select('id');
    if (error) throw error;
    newerOnServer ||= (data?.length ?? 0) < rows.length;
  }
  if (deleted.length) {
    const { error } = await supabase!.from('leagues').delete().eq('user_id', userId).in('id', deleted);
    if (error) throw error;
  }
  if (prefsAt) {
    const row = { user_id: userId, data: prefsDoc(s), updated_at: prefsAt };
    const { data, error } = await supabase!.from('user_prefs').upsert(row).select('user_id');
    if (error) throw error;
    newerOnServer ||= !data?.length;
  }
  useStore.getState().markSynced({ leagues: Object.fromEntries(dirty.map((l) => [l.id, l.updatedAt!])), deleted, prefs: prefsAt });
  return newerOnServer;
}

let current: { run: (pull: boolean) => Promise<boolean>; stop: () => void } | null = null;

/**
 * Keep the signed-in account in sync until the returned function is called: pull on start, when the app comes back into
 * view and when the connection returns; push edits a second after they stop. Offline, edits wait on the device and go
 * out on the next successful sync.
 */
export function startSync(userId: string): () => void {
  current?.stop();
  let stopped = false;
  let busy = false;
  let again = false;
  let wantPull = false;
  let lastPull = 0;
  let retryDelay = 0;
  let pushTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let waiters: ((ok: boolean) => void)[] = [];

  const pull = async () => {
    await pullNow(userId);
    lastPull = Date.now();
  };

  async function cycle(withPull: boolean): Promise<boolean> {
    try {
      // No session means the token couldn't be refreshed (offline), or the auth module is about to show sign-in.
      if (!navigator.onLine || !(await signedInAs(userId))) throw unreachable;
      useSyncStatus.setState({ phase: 'syncing' });
      if (withPull) await pull();
      if (await pushNow(userId)) await pull();
      retryDelay = 0;
      clearTimeout(retryTimer);
      useSyncStatus.setState({ phase: 'idle', error: null, lastSynced: new Date().toISOString() });
      return !hasPendingChanges(useStore.getState());
    } catch (e) {
      const offline = e === unreachable || !navigator.onLine || isNetworkError(e);
      useSyncStatus.setState({ phase: offline ? 'offline' : 'error', error: offline ? null : messageOf(e) });
      retryDelay = Math.min(300_000, retryDelay ? retryDelay * 2 : 15_000);
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => void run(true), retryDelay);
      return false;
    }
  }

  /** One sync at a time; calls that arrive meanwhile share a single follow-up run. Resolves true when nothing is left to send. */
  async function run(withPull: boolean): Promise<boolean> {
    wantPull ||= withPull;
    if (busy) {
      again = true;
      return new Promise((resolve) => waiters.push(resolve));
    }
    busy = true;
    let ok = false;
    try {
      do {
        again = false;
        const p = wantPull;
        wantPull = false;
        ok = !stopped && (await cycle(p));
      } while (again && !stopped);
    } finally {
      busy = false;
    }
    const done = waiters;
    waiters = [];
    done.forEach((resolve) => resolve(ok));
    return ok;
  }

  const unsubscribe = useStore.subscribe((s, prev) => {
    if (s.leagues === prev.leagues && s.deleted === prev.deleted && s.prefsUpdatedAt === prev.prefsUpdatedAt) return;
    if (!hasPendingChanges(s)) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => void run(false), 1000);
  });
  const onOnline = () => void run(true);
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') {
      // The page may be closed or frozen next: send what's pending now rather than after the debounce.
      if (hasPendingChanges(useStore.getState())) {
        clearTimeout(pushTimer);
        void run(false);
      }
    } else if (Date.now() - lastPull > 30_000) void run(true);
  };
  window.addEventListener('online', onOnline);
  document.addEventListener('visibilitychange', onVisibility);
  // After a failed refresh supabase-js waits up to a minute before trying again; sync as soon as it gets a session back.
  const { data: auth } = supabase!.auth.onAuthStateChange((event) => {
    if ((event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN') && useSyncStatus.getState().phase === 'offline')
      setTimeout(() => void run(true), 0);
  });

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(pushTimer);
    clearTimeout(retryTimer);
    unsubscribe();
    auth.subscription.unsubscribe();
    window.removeEventListener('online', onOnline);
    document.removeEventListener('visibilitychange', onVisibility);
    if (current?.stop === stop) current = null;
  };
  current = { run, stop };
  void run(true);
  return stop;
}

/** Send pending changes now. Resolves true when everything has reached the account. */
export async function flushSync(): Promise<boolean> {
  if (!hasPendingChanges(useStore.getState())) return true;
  return current ? current.run(false) : false;
}

export function stopSync() {
  current?.stop();
}
