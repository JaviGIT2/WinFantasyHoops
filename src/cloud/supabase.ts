import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();

/** Where supabase-js keeps the session; fixed so signing out can clear it even when the server can't be reached. */
export const AUTH_STORAGE_KEY = 'win-fantasy-hoops:auth';

/**
 * The Supabase client, or null when this build has no project configured. Without one the app runs as before: no
 * sign-in, leagues saved on the device.
 */
export const supabase = url && key ? createClient(url, key, { auth: { flowType: 'pkce', storageKey: AUTH_STORAGE_KEY } }) : null;
