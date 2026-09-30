import { useState } from 'react';
import { useApp } from '../AppContext';
import { accountsEnabled, dismissNotice, signOut, useAuth } from '../cloud/auth';
import { useSyncStatus } from '../cloud/sync';
import { ALL_CATS, CATEGORIES, FORMAT_PRESETS, type CatId } from '../engine/categories';
import { ACTIVE_SLOTS, rosterSize, type SlotCounts } from '../engine/lineup';
import { MODEL_STATS } from '../engine/stats';
import { leagueName, type League } from '../state/leagues';
import { useLeague, useStore } from '../state/store';

export function SettingsView({ onDone }: { onDone: () => void }) {
  const { data } = useApp();
  const league = useLeague((l) => l.settings);
  const update = useStore((s) => s.updateLeague);
  const setupDone = useLeague((l) => l.setupDone);
  const finishSetup = useStore((s) => s.finishSetup);
  const dateOverride = useStore((s) => s.dateOverride);
  const setDateOverride = useStore((s) => s.setDateOverride);
  const picks = useLeague((l) => l.picks);

  const setFormat = (id: string) => {
    const preset = FORMAT_PRESETS.find((f) => f.id === id);
    update({ formatId: id, ...(preset ? { cats: preset.cats, punts: [], targets: [] } : {}) });
  };
  const toggleCat = (c: CatId) => {
    const cats = league.cats.includes(c) ? league.cats.filter((x) => x !== c) : [...league.cats, c];
    update({ formatId: 'custom', cats: ALL_CATS.filter((x) => cats.includes(x)) });
  };
  const setSlot = (slot: keyof SlotCounts, n: number) => update({ slots: { ...league.slots, [slot]: Math.max(0, Math.min(6, n)) } });

  return (
    <div className="stack" style={{ maxWidth: 860, margin: '0 auto' }}>
      <LeaguesCard />

      {!setupDone && (
        <div className="card" style={{ borderColor: 'var(--mine)' }}>
          <h2>Set up {league.name.trim() || 'this league'}</h2>
          <p className="secondary" style={{ marginBottom: 0 }}>
            Enter the league the way it's configured on Yahoo, then head to the draft.{' '}
            {accountsEnabled ? 'It’s saved to your account, so it follows you to every device.' : 'Everything is saved on this device.'}
          </p>
        </div>
      )}

      <div className="card stack">
        <h2>League settings</h2>
        <div className="grid two">
          <label className="field">
            League name
            <input type="text" value={league.name} onChange={(e) => update({ name: e.target.value })} />
          </label>
          <div className="row">
            <label className="field" style={{ flex: 1 }}>
              Teams
              <select value={league.teams} onChange={(e) => update({ teams: Number(e.target.value) })} disabled={picks.length > 0}>
                {Array.from({ length: 13 }, (_, i) => i + 8).map((n) => <option key={n}>{n}</option>)}
              </select>
            </label>
            <label className="field" style={{ flex: 1 }}>
              Your draft slot
              <select value={league.myTeam} onChange={(e) => update({ myTeam: Number(e.target.value) })} disabled={picks.length > 0}>
                {Array.from({ length: league.teams }, (_, i) => <option key={i} value={i}>{i + 1}</option>)}
              </select>
            </label>
          </div>
        </div>
        {picks.length > 0 && <p className="small muted" style={{ margin: 0 }}>Team count and draft slot are locked once the draft starts (reset it on the Draft tab to change them).</p>}

        <div>
          <div className="small secondary" style={{ marginBottom: 6, fontWeight: 550 }}>Scoring format</div>
          <div className="chips" style={{ marginBottom: 8 }}>
            {FORMAT_PRESETS.map((f) => (
              <button key={f.id} className="chip" aria-pressed={league.formatId === f.id} onClick={() => setFormat(f.id)}>{f.label}</button>
            ))}
            <button className="chip" aria-pressed={league.formatId === 'custom'} onClick={() => update({ formatId: 'custom' })}>Custom</button>
          </div>
          <div className="chips">
            {ALL_CATS.map((c) => (
              <button key={c} className="chip" aria-pressed={league.cats.includes(c)} onClick={() => toggleCat(c)} title={CATEGORIES[c].label}>{c}</button>
            ))}
          </div>
          <p className="small muted">{league.cats.length} categories: {league.cats.join(', ')}</p>
        </div>

        <div>
          <div className="small secondary" style={{ marginBottom: 6, fontWeight: 550 }}>Roster slots ({rosterSize(league.slots)} players)</div>
          <div className="row wrap">
            {[...ACTIVE_SLOTS, 'BN' as const, 'IL' as const].map((slot) => (
              <label key={slot} className="field" style={{ width: 64 }}>
                {slot}
                <input type="number" min={0} max={6} value={league.slots[slot] ?? 0} onChange={(e) => setSlot(slot, Number(e.target.value))} />
              </label>
            ))}
          </div>
        </div>

        <div className="row wrap">
          <label className="field">
            Max adds per week
            <input type="number" min={0} max={14} value={league.weeklyAdds} onChange={(e) => update({ weeklyAdds: Math.max(0, Number(e.target.value)) })} style={{ width: 100 }} />
          </label>
          <label className="field">
            Added players can play
            <select value={league.addTiming} onChange={(e) => update({ addTiming: e.target.value as 'same' | 'next' })}>
              <option value="next">Next day (lineups lock daily)</option>
              <option value="same">Same day (before tip-off)</option>
            </select>
          </label>
          <label className="check" style={{ alignSelf: 'end', minHeight: 34 }}>
            <input type="checkbox" checked={league.trackAllTeams} onChange={(e) => update({ trackAllTeams: e.target.checked })} />
            Track every team's picks
          </label>
        </div>

        <details>
          <summary className="small secondary" style={{ cursor: 'pointer' }}>Team names</summary>
          <div className="grid two" style={{ marginTop: 8 }}>
            {league.teamNames.map((n, i) => (
              <label key={i} className="field">
                Slot {i + 1}{i === league.myTeam ? ' (you)' : ''}
                <input type="text" value={n} onChange={(e) => update({ teamNames: league.teamNames.map((x, j) => (j === i ? e.target.value : x)) })} />
              </label>
            ))}
          </div>
        </details>

        {!setupDone && (
          <div className="row">
            <span className="spacer" />
            <button className="btn primary" onClick={() => { finishSetup(); onDone(); }}>Start drafting</button>
          </div>
        )}
      </div>

      <div className="card stack">
        <h2>Planning date</h2>
        <p className="small secondary" style={{ margin: 0 }}>
          The matchup and streaming tools plan from today. Set a date to plan ahead, for example opening week before the season starts
          ({data.meta.seasonStart}).
        </p>
        <div className="row wrap">
          <input type="date" value={dateOverride ?? ''} onChange={(e) => setDateOverride(e.target.value || null)} />
          {dateOverride && <button className="btn small" onClick={() => setDateOverride(null)}>Use today</button>}
        </div>
      </div>

      <ModelCard />

      {accountsEnabled ? (
        <AccountCard />
      ) : (
        <div className="card row wrap">
          <div>
            <h2>Reset</h2>
            <p className="small secondary" style={{ margin: 0 }}>Clears every league, draft, roster and player override on this device.</p>
          </div>
          <span className="spacer" />
          <button
            className="btn"
            onClick={() => {
              if (confirm('Erase all league data on this device?')) {
                useStore.persist.clearStorage();
                location.reload();
              }
            }}
          >
            Erase everything
          </button>
        </div>
      )}
    </div>
  );
}

function leagueSummary(l: League) {
  const { teams, formatId, cats } = l.settings;
  const format = FORMAT_PRESETS.find((f) => f.id === formatId)?.label ?? `${cats.length}-cat custom`;
  const status = l.picks.length ? `${l.picks.length} picks` : l.setupDone ? 'not drafted yet' : 'not set up yet';
  return `${teams} teams · ${format} · ${status}`;
}

function LeaguesCard() {
  const leagues = useStore((s) => s.leagues);
  const activeId = useLeague((l) => l.id);
  const switchLeague = useStore((s) => s.switchLeague);
  const createLeague = useStore((s) => s.createLeague);
  const deleteLeague = useStore((s) => s.deleteLeague);
  const notice = useAuth((a) => a.notice);

  const remove = (l: League) => {
    const where = accountsEnabled ? 'from your account and every device' : 'from this device';
    if (confirm(`Delete “${leagueName(l)}”? Its settings, draft and rosters will be removed ${where}.`)) deleteLeague(l.id);
  };

  return (
    <div className="card stack">
      <div className="row">
        <h2>Your leagues</h2>
        <span className="spacer" />
        <button className="btn small" onClick={createLeague}>New league</button>
      </div>
      {notice && (
        <div className="notice row">
          <span style={{ flex: 1 }}>{notice}</span>
          <button className="btn small ghost" onClick={dismissNotice}>Dismiss</button>
        </div>
      )}
      <div className="league-list">
        {leagues.map((l) => (
          <div key={l.id} className="league-item" aria-current={l.id === activeId ? 'true' : undefined}>
            <div className="league-meta">
              <b>{leagueName(l)}</b>
              <span className="small muted">{leagueSummary(l)}</span>
            </div>
            {l.id === activeId ? (
              <span className="badge mine">Current</span>
            ) : (
              <button className="btn small" onClick={() => switchLeague(l.id)}>Open</button>
            )}
            <button className="btn small ghost" onClick={() => remove(l)} aria-label={`Delete ${leagueName(l)}`}>Delete</button>
          </div>
        ))}
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        Each league keeps its own settings, draft, rosters and streaming plan. Player adjustments (minutes, injuries, positions) and the planning
        date apply to all of them.
      </p>
    </div>
  );
}

function AccountCard() {
  const account = useAuth((a) => a.account);
  const sync = useSyncStatus();
  const [busy, setBusy] = useState(false);

  const status =
    sync.phase === 'offline'
      ? 'Offline. Changes are saved on this device and sync when you’re back online.'
      : sync.phase === 'error'
        ? `Couldn’t sync: ${sync.error}. Changes are saved on this device; it will keep retrying.`
        : sync.phase === 'syncing'
          ? 'Syncing…'
          : sync.lastSynced
            ? 'All changes saved to your account.'
            : 'Connecting…';

  return (
    <div className="card row wrap">
      <div style={{ minWidth: 0 }}>
        <h2>Account</h2>
        <p className="small secondary" style={{ margin: '4px 0 0' }}>
          Signed in as <b>{account?.email}</b>
        </p>
        <p className={`small ${sync.phase === 'error' ? 'delta-down' : 'muted'}`} style={{ margin: '2px 0 0' }} role="status">
          {status}
        </p>
      </div>
      <span className="spacer" />
      <button
        className="btn"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await signOut();
          setBusy(false);
        }}
      >
        {busy ? 'Signing out…' : 'Sign out'}
      </button>
    </div>
  );
}

function ModelCard() {
  const { data } = useApp();
  const { model, meta } = data;
  const ev = model.eval;
  const label: Record<string, string> = {
    min: 'Minutes', pts: 'Points', reb: 'Rebounds', ast: 'Assists', stl: 'Steals', blk: 'Blocks', tpm: '3PM', to: 'Turnovers',
    fgm: 'FGM', fga: 'FGA', ftm: 'FTM', fta: 'FTA', oreb: 'Off reb', dreb: 'Def reb', tpa: '3PA', dd: 'Double-dbl', td: 'Triple-dbl',
  };
  const boosted = Object.keys(model.gbm ?? {});
  const rows = ev ? [['min', ev.minutes] as const, ...MODEL_STATS.map((s) => [s, ev.stats[s]] as const)] : [];
  return (
    <div className="card stack">
      <h2>Data &amp; model</h2>
      <p className="small secondary" style={{ margin: 0 }}>
        {data.players.length} players on {meta.curLabel} rosters · {data.schedule.length} scheduled games · source {meta.source}, built{' '}
        {new Date(meta.generatedAt).toLocaleDateString()}
        {meta.dataThrough ? ` with box scores through ${meta.dataThrough}` : ` (no ${meta.curLabel} games played yet)`}. Trained by the Python
        pipeline (scikit-learn, LightGBM) on {model.trainedOn.rows.toLocaleString()} player-games ({model.trainedOn.seasons.join(', ')}).
      </p>
      <p className="small secondary" style={{ margin: 0 }}>
        Each stat is predicted from the player's own per-minute rate, scaled by the opponent's defense vs. his position, expected pace, his
        history against that opponent, home court, back-to-backs and projected minutes. Two model types compete on every rebuild: a Poisson
        regression and gradient-boosted trees; each stat uses whichever forecast held-out games better
        {boosted.length ? ` (trees currently win for ${boosted.join(', ')})` : ' (currently the regression for every stat)'}. A separate
        regression predicts minutes. Players with no NBA minutes use what the opponent allowed to their position and role last season.
      </p>
      {ev && (
        <>
          <div className="small secondary">
            Holdout test: trained on games before {ev.cutoff}, scored on {ev.testRows.toLocaleString()} later games. Root mean squared error per
            game (lower is better) vs. the naive forecast (season average so far):
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="l">Stat</th>
                  <th>Naive</th>
                  <th>Regression</th>
                  <th>Trees</th>
                  <th>Used</th>
                  <th>vs naive</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(([s, v]) => {
                  const change = (v.modelRmse - v.naiveRmse) / v.naiveRmse;
                  return (
                    <tr key={s}>
                      <td className="l">{label[s] ?? s}</td>
                      <td className="num">{v.naiveRmse.toFixed(3)}</td>
                      <td className={`num${v.chosen === 'glm' ? '' : ' muted'}`}>{(v.glmRmse ?? v.modelRmse).toFixed(3)}</td>
                      <td className={`num${v.chosen === 'gbm' ? '' : ' muted'}`}>{v.gbmRmse !== undefined ? v.gbmRmse.toFixed(3) : '–'}</td>
                      <td className="small">{s === 'min' ? 'regression' : v.chosen === 'gbm' ? 'trees' : 'regression'}</td>
                      <td className={`num ${change < -0.001 ? 'delta-up' : change > 0.001 ? 'delta-down' : 'muted'}`}>{(change * 100).toFixed(1)}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="small muted" style={{ margin: 0 }}>
            Game-to-game noise dominates single games, so a few percent is a real gain; it compounds over a week of games. Triple-doubles are too rare
            (~200 a season) for matchup effects to beat their season rate.
          </p>
        </>
      )}
    </div>
  );
}
