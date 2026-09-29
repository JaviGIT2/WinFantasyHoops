import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../AppContext';
import { Delta, PlayerName, Segmented, pct } from '../components/ui';
import { searchKey } from '../data/loader';
import type { PlayerData } from '../data/types';
import { findTrades, leagueReport, type TradeIdea } from '../engine/league';
import type { Basis } from '../engine/projection';
import { useStore } from '../state/store';

/** Rank cell color: top of the league blue, bottom red, middle neutral. */
function rankStyle(rank: number, n: number): React.CSSProperties {
  const t = n > 1 ? (rank - 1) / (n - 1) : 0.5; // 0 best … 1 worst
  const d = 0.5 - t;
  if (Math.abs(d) < 0.12) return {};
  return { background: `rgba(var(${d > 0 ? '--pos' : '--neg'}), ${Math.min(0.5, Math.abs(d) * 0.9)})` };
}

export function LeagueView() {
  const { data, ctx, rosterOf, freeAgents, ownerOf } = useApp();
  const league = useStore((s) => s.league);
  const rosters = useStore((s) => s.rosters);
  const [basis, setBasis] = useState<Basis>(data.meta.curGames > 0 ? 'cur' : 'proj');
  const teamRosters = useMemo(() => rosters.map((_, i) => rosterOf(i)), [rosters, rosterOf]);
  const filled = teamRosters.filter((r) => r.length > 0).length;

  const report = useMemo(
    () => (filled >= 2 ? leagueReport(ctx, teamRosters, league.cats, basis) : null),
    [ctx, teamRosters, league.cats, basis, filled],
  );

  const [trades, setTrades] = useState<ReturnType<typeof findTrades> | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setTrades(null), [ctx, teamRosters, league.cats, basis]);

  const runTrades = () => {
    setBusy(true);
    setTimeout(() => {
      // Free agents worth considering: the best 150 by the chosen basis's points + rebounds + assists proxy.
      const fa = [...freeAgents]
        .filter((p) => p.last || p.cur || p.prev)
        .sort((a, b) => score(b) - score(a))
        .slice(0, 150);
      setTrades(findTrades(ctx, teamRosters, league.myTeam, fa, league.cats, basis));
      setBusy(false);
    }, 20);
  };
  const score = (p: PlayerData) => {
    const s = p.cur && p.cur.gp >= 5 ? p.cur : p.last ?? p.prev;
    return s ? (s.pts + s.reb + s.ast + 2 * (s.stl + s.blk)) / Math.max(1, s.gp) : 0;
  };

  const n = league.teams;
  return (
    <div className="stack">
      <div className="card row wrap">
        <h2>League outlook</h2>
        <span className="spacer" />
        <Segmented
          label="Stat basis"
          value={basis}
          onChange={setBasis}
          options={[
            { value: 'cur', label: `${data.meta.curLabel} avg` },
            { value: 'proj', label: 'Projection' },
            { value: 'last', label: `${data.meta.lastLabel} avg` },
          ]}
        />
      </div>
      <p className="small muted" style={{ margin: '-4px 2px 0' }}>
        {basis === 'cur'
          ? `Current-season averages for players with 5+ games, otherwise ${data.meta.lastLabel} averages.`
          : basis === 'proj'
            ? 'Blended projection (current games shrunk toward last season, aging applied).'
            : `${data.meta.lastLabel} per-game averages.`}{' '}
        Each player is credited with 3.5 games a week, discounted for missed-game risk.
      </p>

      {!report ? (
        <div className="card empty">Add rosters for at least two teams (track every pick in the draft, or use Rosters below).</div>
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="l">Team</th>
                  <th title="Average expected categories won per week against every other team">Exp. cats</th>
                  <th title="Average chance to win a weekly matchup">Win %</th>
                  {league.cats.map((c) => <th key={c}>{c}</th>)}
                </tr>
              </thead>
              <tbody>
                {[...report].sort((a, b) => b.power - a.power).map((r) => (
                  <tr key={r.index} className={r.index === league.myTeam ? 'mine' : ''}>
                    <td className="l"><b>{league.teamNames[r.index]}</b> <span className="muted small">({teamRosters[r.index].length})</span></td>
                    <td className="num"><b>{r.power.toFixed(2)}</b></td>
                    <td className="num">{pct(r.winPct)}</td>
                    {league.cats.map((c) => (
                      <td key={c} className="num z" style={rankStyle(r.ranks[c], n)}>{r.ranks[c]}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small muted">Category cells show league rank (1 = best; blue top third, red bottom third).</p>
        </div>
      )}

      {report && (
        <div className="card">
          <div className="card-head">
            <h2>Optimize my team</h2>
            <span className="spacer" />
            <button className="btn primary" onClick={runTrades} disabled={busy || !teamRosters[league.myTeam].length}>
              {busy ? 'Searching…' : trades ? 'Search again' : 'Find targets & trades'}
            </button>
          </div>
          {!trades && (
            <p className="secondary" style={{ margin: 0 }}>
              Tests every 1-for-1 swap with each team, 2-for-2 swaps with their most useful players, and add/drops with the top free agents,
              scoring each by the change in your expected categories won per week against the league.
            </p>
          )}
          {trades && (
            <div className="grid two">
              <TradeList kind="target" title="Top targets" ideas={trades.targets} empty="No player improves your team on this basis." ownerOf={ownerOf} />
              <TradeList kind="trade" title="Trade ideas (both sides hold value)" ideas={trades.trades} empty="No trades found that help you without hurting the other team much." ownerOf={ownerOf} />
              <TradeList kind="pickup" title="Waiver pickups" ideas={trades.pickups} empty="No free agent beats anyone on your roster." ownerOf={ownerOf} />
            </div>
          )}
        </div>
      )}

      <RosterEditor />
    </div>
  );
}

function TradeList({
  title,
  ideas,
  empty,
  ownerOf,
  kind,
}: {
  title: string;
  ideas: TradeIdea[];
  empty: string;
  ownerOf: Map<string, number>;
  kind: 'target' | 'trade' | 'pickup';
}) {
  const { ctx } = useApp();
  const league = useStore((s) => s.league);
  const [limit, setLimit] = useState(6);
  const players = (ids: string[]) => ids.map((id) => ctx.byId.get(id)).filter((p): p is PlayerData => !!p);
  const owner = (p: PlayerData) => (ownerOf.has(p.id) ? league.teamNames[ownerOf.get(p.id)!] : 'FA');
  return (
    <div>
      <h3 style={{ margin: '6px 0 2px' }}>{title}</h3>
      {!ideas.length && <p className="muted small">{empty}</p>}
      {ideas.slice(0, limit).map((t, i) => {
        const helps = Object.entries(t.catDelta).filter(([, v]) => v > 0.03).sort((a, b) => b[1] - a[1]);
        const hurts = Object.entries(t.catDelta).filter(([, v]) => v < -0.03).sort((a, b) => a[1] - b[1]);
        return (
          <div key={i} className="idea">
            {kind === 'target' ? (
              <div className="row wrap">
                {players(t.get).map((p) => <PlayerName key={p.id} p={p} extra={<span>· {owner(p)}</span>} />)}
                <span className="spacer" />
                <span className="small">fit <Delta v={t.myDelta} suffix=" cats/wk" /></span>
              </div>
            ) : (
              <div className="swap">
                <div className="side">
                  <span className="small muted">{kind === 'trade' ? `Get from ${league.teamNames[t.partner]}` : 'Add'}</span>
                  {players(t.get).map((p) => <PlayerName key={p.id} p={p} />)}
                </div>
                <span className="arrow" aria-hidden>⇄</span>
                <div className="side">
                  <span className="small muted">{kind === 'trade' ? 'Give' : 'Drop'}</span>
                  {players(t.give).map((p) => <PlayerName key={p.id} p={p} />)}
                </div>
              </div>
            )}
            <div className="small">
              {kind === 'target' ? (
                <span className="muted">if he replaced {players(t.give).map((p) => p.name).join(', ')}</span>
              ) : (
                <>
                  You <Delta v={t.myDelta} suffix=" cats/wk" />
                  {kind === 'trade' && <> · them <Delta v={t.theirDelta} suffix=" cats/wk" /></>}
                </>
              )}
            </div>
            {(helps.length > 0 || hurts.length > 0) && (
              <div className="small">
                {helps.length > 0 && <span className="secondary">+ {helps.map(([c, v]) => `${c} ${v.toFixed(2)}`).join(', ')}</span>}
                {helps.length > 0 && hurts.length > 0 && <span className="muted"> · </span>}
                {hurts.length > 0 && <span className="muted">− {hurts.map(([c, v]) => `${c} ${Math.abs(v).toFixed(2)}`).join(', ')}</span>}
              </div>
            )}
          </div>
        );
      })}
      {ideas.length > limit && (
        <button className="btn small" onClick={() => setLimit((l) => l + 6)}>Show more</button>
      )}
    </div>
  );
}

function RosterEditor() {
  const { data, rosterOf, ownerOf } = useApp();
  const league = useStore((s) => s.league);
  const addToRoster = useStore((s) => s.addToRoster);
  const removeFromRoster = useStore((s) => s.removeFromRoster);
  const [team, setTeam] = useState(league.myTeam);
  const [q, setQ] = useState('');
  const roster = rosterOf(team);
  const matches = q.trim().length >= 2 ? data.players.filter((p) => searchKey(p.name).includes(searchKey(q.trim()))).slice(0, 8) : [];
  return (
    <div className="card">
      <div className="card-head">
        <h2>Rosters</h2>
        <span className="spacer" />
        <select value={team} onChange={(e) => setTeam(Number(e.target.value))} aria-label="Team">
          {league.teamNames.map((n, i) => <option key={i} value={i}>{n}</option>)}
        </select>
      </div>
      <p className="small muted" style={{ marginTop: 0 }}>Keep rosters in sync with Yahoo after trades and waiver moves; adding a player removes him from any other team.</p>
      <div className="row" style={{ marginBottom: 8 }}>
        <input type="search" placeholder="Add player…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1 }} />
      </div>
      {matches.map((p) => (
        <div key={p.id} className="row" style={{ padding: '4px 0' }}>
          <PlayerName p={p} extra={ownerOf.has(p.id) ? <span className="muted">· {league.teamNames[ownerOf.get(p.id)!]}</span> : <span className="muted">· FA</span>} />
          <span className="spacer" />
          <button className="btn small" disabled={ownerOf.get(p.id) === team} onClick={() => { addToRoster(team, p.id); setQ(''); }}>Add</button>
        </div>
      ))}
      {roster.length === 0 && <div className="muted small">No players on this team.</div>}
      {roster.map((p) => (
        <div key={p.id} className="row" style={{ padding: '5px 0', borderBottom: '1px solid var(--grid)' }}>
          <PlayerName p={p} />
          <span className="spacer" />
          <button className="btn small ghost" onClick={() => removeFromRoster(team, p.id)}>Drop</button>
        </div>
      ))}
    </div>
  );
}
