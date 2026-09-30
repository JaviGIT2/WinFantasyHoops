-- Win Fantasy Hoops: where accounts keep their leagues and player adjustments.
-- Run once in your Supabase project (Dashboard → SQL Editor → New query → paste → Run). Safe to re-run.

-- One row per league. `data` is the whole league as the app stores it (settings, draft picks, rosters, weekly
-- opponents, streaming plan); `updated_at` is when it was last edited, set by the device that made the edit.
create table if not exists public.leagues (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint leagues_data_size check (octet_length(data::text) <= 1000000)
);
create index if not exists leagues_user_id_idx on public.leagues (user_id);

-- One row per account: player overrides (minutes, injury status, positions) and the planning date, shared by all leagues.
create table if not exists public.user_prefs (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null,
  constraint user_prefs_data_size check (octet_length(data::text) <= 1000000)
);

-- Last write wins: skip an update older than the stored row, so a device coming back online can't overwrite edits
-- made elsewhere in the meantime. (The app then pulls the newer version.)
create or replace function public.keep_newest()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.updated_at < old.updated_at then
    return null;
  end if;
  return new;
end;
$$;

drop trigger if exists leagues_keep_newest on public.leagues;
create trigger leagues_keep_newest before update on public.leagues
  for each row execute function public.keep_newest();

drop trigger if exists user_prefs_keep_newest on public.user_prefs;
create trigger user_prefs_keep_newest before update on public.user_prefs
  for each row execute function public.keep_newest();

-- Row-level security: a signed-in user can read and change only their own rows; signed-out requests get nothing.
alter table public.leagues enable row level security;
alter table public.user_prefs enable row level security;

drop policy if exists "Users manage their own leagues" on public.leagues;
create policy "Users manage their own leagues" on public.leagues
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users manage their own prefs" on public.user_prefs;
create policy "Users manage their own prefs" on public.user_prefs
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all on public.leagues, public.user_prefs from anon;
grant select, insert, update, delete on public.leagues, public.user_prefs to authenticated;
