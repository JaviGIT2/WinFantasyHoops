import { isAuthRetryableFetchError, type AuthChangeEvent, type Session } from '@supabase/supabase-js';
import { create } from 'zustand';
import { confirmAction } from '../components/confirm';
import { isPlaceholder } from '../state/leagues';
import { accountKey, DEVICE_KEY, forgetAccount, importDeviceLeagues, openStore, useStore } from '../state/store';
import { AUTH_STORAGE_KEY, supabase } from './supabase';
import { flushSync, pullNow, stopSync } from './sync';

export interface Account {
  id: string;
  email: string;
}

interface AuthState {
  phase: 'loading' | 'signed-out' | 'ready';
  /** The signed-in account; null without accounts (no Supabase project configured). */
  account: Account | null;
  /** Opened from a password-reset email: ask for a new password first. */
  recovering: boolean;
  /** Shown on the sign-in screen, e.g. why an email link didn't work. */
  message: string | null;
  /** One-time note for Settings, e.g. leagues brought over from this device. */
  notice: string | null;
}

export const accountsEnabled = supabase !== null;

export const useAuth = create<AuthState>(() => ({
  phase: 'loading',
  account: null,
  recovering: false,
  message: null,
  notice: null,
}));

// The last signed-in account on this device, opened at startup before the session is checked, so the app starts
// instantly and still opens offline after the access token (1 hour) has expired.
const LAST_ACCOUNT_KEY = 'win-fantasy-hoops:account';

function readLastAccount(): Account | null {
  try {
    const a = JSON.parse(localStorage.getItem(LAST_ACCOUNT_KEY) ?? 'null') as Account | null;
    return a && typeof a.id === 'string' ? a : null;
  } catch {
    return null;
  }
}

function saveLastAccount(a: Account | null) {
  try {
    if (a) localStorage.setItem(LAST_ACCOUNT_KEY, JSON.stringify(a));
    else localStorage.removeItem(LAST_ACCOUNT_KEY);
  } catch {
    // storage blocked: offline start just won't be available
  }
}

/** Email links that fail (expired, already used) come back with the reason in the URL: keep it and tidy the address bar. */
function takeUrlError(): string | null {
  const url = new URL(location.href);
  const hash = new URLSearchParams(url.hash.slice(1));
  const message = url.searchParams.get('error_description') ?? hash.get('error_description');
  if (!message) return null;
  for (const k of ['error', 'error_code', 'error_description']) url.searchParams.delete(k);
  if (hash.has('error_description')) url.hash = '';
  history.replaceState(history.state, '', url);
  return message;
}

let openedFor: string | null = null;
let opening: Promise<void> | null = null;
let leaving = false;

/**
 * Load an account's leagues and show the app. `verified` means a live session backs it, as opposed to the last account
 * on this device opened ahead of the session check. One account per page load: switching accounts reloads for a clean
 * slate.
 */
async function enter(user: { id: string; email?: string }, verified: boolean) {
  if (openedFor && openedFor !== user.id) return location.reload();
  if (!opening) {
    openedFor = user.id;
    opening = (async () => {
      await openStore(accountKey(user.id));
      const imported = importDeviceLeagues();
      if (imported)
        useAuth.setState({ notice: `Added ${imported === 1 ? 'the league' : `${imported} leagues`} saved on this device to your account.` });
      // First time on this device: fetch the account's leagues before showing anything, rather than a blank league.
      if (verified && useStore.getState().leagues.every(isPlaceholder))
        await Promise.race([pullNow(user.id).catch(() => {}), new Promise((r) => setTimeout(r, 10_000))]);
    })();
  }
  await opening;
  const account = { id: user.id, email: user.email ?? '' };
  if (verified) saveLastAccount(account);
  useAuth.setState({ phase: 'ready', account });
}

function onAuthEvent(event: AuthChangeEvent, session: Session | null) {
  if (event === 'SIGNED_OUT') {
    // The session ended (here or revoked elsewhere): sign in again. Reload so no league data stays in memory; unsynced
    // edits stay saved on the device for when this account signs back in.
    if (leaving) return;
    saveLastAccount(null);
    if (useAuth.getState().phase === 'ready') location.reload();
    return;
  }
  if (event === 'PASSWORD_RECOVERY') useAuth.setState({ recovering: true });
  if (session && event !== 'INITIAL_SESSION') void enter(session.user, true);
}

let booted = false;

/** Start before the first render, so an event from an email link (e.g. password recovery) can't be missed. */
export function bootAuth() {
  if (booted) return;
  booted = true;
  if (!supabase) {
    void openStore(DEVICE_KEY).then(() => useAuth.setState({ phase: 'ready' }));
    return;
  }
  const message = takeUrlError();
  // supabase-js calls this while holding its auth lock; calling back into it from here would deadlock, so defer.
  supabase.auth.onAuthStateChange((event, session) => {
    setTimeout(() => onAuthEvent(event, session), 0);
  });
  // Show this device's copy of the last account right away. Checking the session can take a while: with an expired
  // token and no connection, supabase-js keeps retrying the refresh for ~30 s.
  const last = readLastAccount();
  if (last) void enter(last, false);
  void supabase.auth.getSession().then(
    ({ data, error }) => {
      if (data.session) return enter(data.session.user, true);
      // Can't reach the server: keep working from the device; edits sync once the session refreshes.
      if (last && (!navigator.onLine || isAuthRetryableFetchError(error))) return;
      saveLastAccount(null);
      if (useAuth.getState().phase === 'ready') location.reload();
      else useAuth.setState({ phase: 'signed-out', message });
    },
    () => {
      if (!last) useAuth.setState({ phase: 'signed-out', message });
    },
  );
}

/** Where email links (confirm address, reset password) return to: this page, without query or route. */
const returnUrl = () => location.origin + location.pathname;

export async function signIn(email: string, password: string): Promise<string | null> {
  const { error } = await supabase!.auth.signInWithPassword({ email, password });
  return error?.message ?? null;
}

/** Create an account. `confirm` is true when the project requires confirming the email before signing in. */
export async function signUp(email: string, password: string): Promise<{ error: string | null; confirm: boolean }> {
  const { data, error } = await supabase!.auth.signUp({ email, password, options: { emailRedirectTo: returnUrl() } });
  return { error: error?.message ?? null, confirm: !error && !data.session };
}

export async function sendPasswordReset(email: string): Promise<string | null> {
  const { error } = await supabase!.auth.resetPasswordForEmail(email, { redirectTo: returnUrl() });
  return error?.message ?? null;
}

export async function setNewPassword(password: string): Promise<string | null> {
  const { error } = await supabase!.auth.updateUser({ password });
  if (!error) useAuth.setState({ recovering: false });
  return error?.message ?? null;
}

export const skipNewPassword = () => useAuth.setState({ recovering: false });
export const dismissNotice = () => useAuth.setState({ notice: null });

/** Sign out on this device only, and remove the account's leagues from it (they stay in the account). */
export async function signOut() {
  const { account } = useAuth.getState();
  if (!supabase || !account) return;
  const synced = await flushSync();
  const lose = () =>
    confirmAction({
      title: 'Sign out with unsynced changes?',
      message: "Some changes haven't reached your account yet (you may be offline). If you sign out now, they're lost.",
      confirmLabel: 'Sign out anyway',
      danger: true,
    });
  if (!synced && !(await lose())) return;
  leaving = true;
  stopSync();
  forgetAccount(account.id);
  saveLastAccount(null);
  const { error } = await supabase.auth.signOut({ scope: 'local' });
  // When the server can't be reached supabase-js keeps the session; forget it on this device anyway.
  if (error) for (const suffix of ['', '-user', '-code-verifier']) localStorage.removeItem(AUTH_STORAGE_KEY + suffix);
  location.reload();
}
