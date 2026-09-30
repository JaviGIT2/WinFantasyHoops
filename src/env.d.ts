interface ImportMetaEnv {
  /** Supabase project URL (https://<ref>.supabase.co). Leave unset to run without accounts, saving leagues on the device. */
  readonly VITE_SUPABASE_URL?: string;
  /** Supabase publishable (or legacy anon) key. It is public by design; row-level security protects each user's data. */
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
}
