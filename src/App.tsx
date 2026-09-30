import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppContext, type AppValue } from './AppContext';
import { accountsEnabled } from './cloud/auth';
import { useSyncStatus } from './cloud/sync';
import { Icon } from './components/ui';
import { loadBundle } from './data/loader';
import type { DataBundle } from './data/types';
import { createContext } from './engine/context';
import { fantasyWeeks, localToday } from './engine/schedule';
import { leagueName } from './state/leagues';
import { useLeague, useStore } from './state/store';
import { DraftView } from './views/DraftView';
import { LeagueView } from './views/LeagueView';
import { MatchupView } from './views/MatchupView';
import { PlayerSheet } from './views/PlayerSheet';
import { SettingsView } from './views/SettingsView';
import { StreamView } from './views/StreamView';

const TABS = [
  { id: 'draft', label: 'Draft', icon: Icon.draft },
  { id: 'matchup', label: 'Matchup', icon: Icon.matchup },
  { id: 'league', label: 'League', icon: Icon.league },
  { id: 'stream', label: 'Stream', icon: Icon.stream },
  { id: 'settings', label: 'Settings', icon: Icon.settings },
] as const;
type TabId = (typeof TABS)[number]['id'];

const tabFromHash = (): TabId | null => {
  const h = window.location.hash.replace(/^#\/?/, '');
  return TABS.some((t) => t.id === h) ? (h as TabId) : null;
};

export function App() {
  const [data, setData] = useState<DataBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const setupDone = useLeague((l) => l.setupDone);
  const [tab, setTab] = useState<TabId>(() => tabFromHash() ?? (setupDone ? 'draft' : 'settings'));
  const [sheet, setSheet] = useState<string | null>(null);

  useEffect(() => {
    loadBundle().then(setData, (e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    const onHash = () => {
      const t = tabFromHash();
      if (t) {
        setSheet(null);
        setTab(t);
      }
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = useCallback((t: TabId) => {
    setSheet(null);
    setTab(t);
    history.replaceState(null, '', `#/${t}`);
    window.scrollTo({ top: 0 });
  }, []);

  if (error) return <div className="loading"><div className="card" style={{ maxWidth: 420 }}><h2>Data not available</h2><p className="secondary">{error}</p></div></div>;
  if (!data) return <div className="loading">Loading players and schedule…</div>;
  return (
    <Loaded data={data} tab={tab} go={go} sheet={sheet} setSheet={setSheet} />
  );
}

function Loaded({
  data,
  tab,
  go,
  sheet,
  setSheet,
}: {
  data: DataBundle;
  tab: TabId;
  go: (t: TabId) => void;
  sheet: string | null;
  setSheet: (id: string | null) => void;
}) {
  const overrides = useStore((s) => s.overrides);
  const dateOverride = useStore((s) => s.dateOverride);
  const rosters = useLeague((l) => l.rosters);
  const leagueId = useLeague((l) => l.id);
  const today = dateOverride ?? localToday();

  const ctx = useMemo(() => createContext(data, overrides, today), [data, overrides, today]);
  const weeks = useMemo(() => fantasyWeeks(ctx.sched), [ctx.sched]);
  const value = useMemo<AppValue>(() => {
    const ownerOf = new Map<string, number>();
    rosters.forEach((r, i) => r.forEach((id) => ownerOf.set(id, i)));
    return {
      data,
      ctx,
      weeks,
      today,
      openPlayer: (id) => setSheet(id),
      ownerOf,
      rosterOf: (team) => (rosters[team] ?? []).map((id) => ctx.byId.get(id)).filter((p): p is NonNullable<typeof p> => !!p),
      freeAgents: data.players.filter((p) => !ownerOf.has(p.id)),
    };
  }, [data, ctx, weeks, today, rosters, setSheet]);

  return (
    <AppContext.Provider value={value}>
      <div className="app">
        <header className="topbar">
          <div className="brand">
            <img src={`${import.meta.env.BASE_URL}icons/icon.svg`} alt="" />
            <span className="hide-mobile">Win Hoops</span>
          </div>
          <LeagueSwitcher onNew={() => go('settings')} />
          <nav className="tabs" aria-label="Sections">
            {TABS.map((t) => (
              <button key={t.id} className="tab" aria-current={tab === t.id ? 'page' : undefined} onClick={() => go(t.id)}>
                {t.icon}
                <span>{t.label}</span>
              </button>
            ))}
          </nav>
          <span className="spacer" />
          <SyncFlag />
          <span className="small muted hide-narrow">
            {data.meta.curLabel} · data {data.meta.dataThrough ? `through ${data.meta.dataThrough}` : `as of ${new Date(data.meta.generatedAt).toLocaleDateString()}`}
          </span>
        </header>
        {/* Keyed by league so each view starts fresh (selected team, filters…) after switching leagues. */}
        <main key={leagueId}>
          {tab === 'draft' && <DraftView />}
          {tab === 'matchup' && <MatchupView />}
          {tab === 'league' && <LeagueView />}
          {tab === 'stream' && <StreamView />}
          {tab === 'settings' && <SettingsView onDone={() => go('draft')} />}
        </main>
      </div>
      {sheet && <PlayerSheet id={sheet} onClose={() => setSheet(null)} />}
    </AppContext.Provider>
  );
}

const NEW_LEAGUE = 'new';

function LeagueSwitcher({ onNew }: { onNew: () => void }) {
  const leagues = useStore((s) => s.leagues);
  const activeId = useLeague((l) => l.id);
  const switchLeague = useStore((s) => s.switchLeague);
  const createLeague = useStore((s) => s.createLeague);
  return (
    <select
      className="league-switch"
      aria-label="League"
      value={activeId}
      onChange={(e) => {
        if (e.target.value !== NEW_LEAGUE) return switchLeague(e.target.value);
        createLeague();
        onNew();
      }}
    >
      {leagues.map((l) => (
        <option key={l.id} value={l.id}>
          {leagueName(l)}
        </option>
      ))}
      <option value={NEW_LEAGUE}>New league…</option>
    </select>
  );
}

/** Flags edits that aren't reaching the account (offline or failing); silent otherwise. */
function SyncFlag() {
  const phase = useSyncStatus((s) => s.phase);
  if (!accountsEnabled) return null;
  if (phase === 'offline')
    return <span className="badge sync-flag" title="Changes are saved on this device and sync when you're back online">Offline</span>;
  if (phase === 'error') return <span className="badge out" title="Changes are saved on this device. See Settings → Account.">Not synced</span>;
  return null;
}
