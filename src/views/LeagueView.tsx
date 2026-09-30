import { Fragment, useEffect, useMemo, useState } from 'react';
import { useApp } from '../AppContext';
import { MovePicker, useRosterMove } from '../components/RosterMove';
import { Delta, PlayerName, Segmented, pct } from '../components/ui';
import { searchKey } from '../data/loader';
import type { PlayerData } from '../data/types';
import { CATEGORIES, type CatId } from '../engine/categories';
import { findTrades, leagueReport, offersAway, offersFor, strategyWeights, type TradeIdea } from '../engine/league';
import { rosterSize } from '../engine/lineup';
import type { Basis } from '../engine/projection';
import { addMove, rosterCapacity, type AddMove } from '../engine/roster';
import { useLeague, useStore } from '../state/store';

/** Rank cell color: top of the league blue, bottom red, middle neutral. */
function rankStyle(rank: number, n: number): React.CSSProperties {
  const t = n > 1 ? (rank - 1) / (n - 1) : 0.5; // 0 best … 1 worst
  const d = 0.5 - t;
  if (Math.abs(d) < 0.12) return {};
  return { background: `rgba(var(${d > 0 ? '--pos' : '--neg'}), ${Math.min(0.5, Math.abs(d) * 0.9)})` };
}

export function LeagueView() {
  const { data, ctx, rosterOf, freeAgents, ownerOf } = useApp();
  const league = useLeague((l) => l.settings);
  const rosters = useLeague((l) => l.rosters);
  const [basis, setBasis] = useState<Basis>(data.meta.curGames > 0 ? 'cur' : 'proj');
  const teamRosters = useMemo(() => rosters.map((_, i) => rosterOf(i)), [rosters, rosterOf]);
  const filled = teamRosters.filter((r) => r.length > 0).length;

  const report = useMemo(
    () => (filled >= 2 ? leagueReport(ctx, teamRosters, league.cats, basis) : null),
    [ctx, teamRosters, league.cats, basis, filled],
  );

  const targets = useMemo(() => league.targets.filter((c) => league.cats.includes(c)), [league.targets, league.cats]);
  const punts = useMemo(() => league.punts.filter((c) => league.cats.includes(c)), [league.punts, league.cats]);
  const [trades, setTrades] = useState<ReturnType<typeof findTrades> | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setTrades(null), [ctx, teamRosters, league.cats, basis, targets, punts]);

  const runTrades = () => {
    setBusy(true);
    setTimeout(() => {
      // Free agents worth considering: the best 150 by the chosen basis's points + rebounds + assists proxy.
      const fa = [...freeAgents]
        .filter((p) => p.last || p.cur || p.prev)
        .sort((a, b) => score(b) - score(a))
        .slice(0, 150);
      setTrades(findTrades(ctx, teamRosters, league.myTeam, fa, league.cats, basis, { weights: strategyWeights(targets, punts) }));
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
            <p className="secondary" style={{ margin: '0 0 12px' }}>
              Tests every 1-for-1 swap with each team, 2-for-2 swaps with their most useful players, and add/drops with the top free agents,
              scoring each by the change in your expected categories won per week against the league.
            </p>
          )}
          <CategoryStrategy targets={targets} punts={punts} />
          <TradeForPlayer teamRosters={teamRosters} basis={basis} targets={targets} punts={punts} />
          <TradeAway teamRosters={teamRosters} basis={basis} targets={targets} punts={punts} />
          {trades && (
            <div className="grid two">
              <TradeList kind="target" title="Top targets" ideas={trades.targets} empty="No player improves your team on this basis." ownerOf={ownerOf} targets={targets} punts={punts} />
              <TradeList kind="trade" title="Trade ideas (both sides hold value)" ideas={trades.trades} empty="No trades found that help you without hurting the other team much." ownerOf={ownerOf} targets={targets} punts={punts} />
              <TradeList kind="pickup" title="Waiver pickups" ideas={trades.pickups} empty="No free agent beats anyone on your roster." ownerOf={ownerOf} targets={targets} punts={punts} />
            </div>
          )}
        </div>
      )}

      <RosterEditor />
    </div>
  );
}

/** Categories to build toward and to give up; they steer which trades and pickups rank highest. */
function CategoryStrategy({ targets, punts }: { targets: CatId[]; punts: CatId[] }) {
  const league = useLeague((l) => l.settings);
  const update = useStore((s) => s.updateLeague);
  const toggled = (list: CatId[], c: CatId) => (list.includes(c) ? list.filter((x) => x !== c) : [...list, c]);
  const toggleTarget = (c: CatId) => update({ targets: toggled(league.targets, c), punts: league.punts.filter((x) => x !== c) });
  const togglePunt = (c: CatId) => update({ punts: toggled(league.punts, c), targets: league.targets.filter((x) => x !== c) });
  return (
    <div className="strategy">
      <div className="strategy-row">
        <span className="strategy-label">Target</span>
        <div className="chips">
          {league.cats.map((c) => (
            <button key={c} className="chip" aria-pressed={targets.includes(c)} onClick={() => toggleTarget(c)} title={CATEGORIES[c].label}>
              {c}
            </button>
          ))}
        </div>
      </div>
      <div className="strategy-row">
        <span className="strategy-label">Give up</span>
        <div className="chips">
          {league.cats.map((c) => (
            <button
              key={c}
              className={`chip${punts.includes(c) ? ' punt' : ''}`}
              aria-pressed={punts.includes(c)}
              onClick={() => togglePunt(c)}
              title={CATEGORIES[c].label}
            >
              {c}
            </button>
          ))}
        </div>
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        Ideas are ranked by the change in your expected categories won per week, with targeted categories counting double and given-up ones not
        at all. Given-up categories are also your draft punts.
      </p>
    </div>
  );
}

/** Search any player and get the best trade offers for him, or the best drop to add him if he's a free agent. */
function TradeForPlayer({ teamRosters, basis, targets, punts }: { teamRosters: PlayerData[][]; basis: Basis; targets: CatId[]; punts: CatId[] }) {
  const { data, ctx, ownerOf } = useApp();
  const league = useLeague((l) => l.settings);
  const rosters = useLeague((l) => l.rosters);
  const [q, setQ] = useState('');
  const [pid, setPid] = useState<string | null>(null);
  const [result, setResult] = useState<ReturnType<typeof offersFor> | null>(null);
  const player = pid ? ctx.byId.get(pid) : undefined;
  const matches = q.trim().length >= 2 ? data.players.filter((p) => searchKey(p.name).includes(searchKey(q.trim()))).slice(0, 6) : [];

  useEffect(() => {
    setResult(null);
    if (!player) return;
    // A 2-for-2 search runs about a thousand evaluations: let "Building offers…" paint first.
    const timer = setTimeout(
      () => setResult(offersFor(ctx, teamRosters, league.myTeam, player, league.cats, basis, { weights: strategyWeights(targets, punts) })),
      20,
    );
    return () => clearTimeout(timer);
  }, [player, ctx, teamRosters, league.myTeam, league.cats, basis, targets, punts]);

  const teamOf = (p: PlayerData) => (ownerOf.has(p.id) ? league.teamNames[ownerOf.get(p.id)!] : 'FA');
  const isFreeAgent = result?.partner === -1;
  const hasRoom = !!player && isFreeAgent && addMove(ctx, league.slots, rosters, league.myTeam, player.id).kind === 'add';

  return (
    <div className="trade-tool trade-for">
      <h3>Trade for a player</h3>
      <input type="search" placeholder="Search a player you want…" value={q} onChange={(e) => setQ(e.target.value)} />
      {matches.map((p) => {
        const mine = ownerOf.get(p.id) === league.myTeam;
        return (
          <div key={p.id} className="row" style={{ padding: '2px 0' }}>
            <PlayerName p={p} extra={<span className="muted">· {teamOf(p)}</span>} />
            <span className="spacer" />
            <button
              className="btn small"
              disabled={mine}
              onClick={() => {
                setPid(p.id);
                setQ('');
              }}
            >
              {mine ? 'On your team' : ownerOf.has(p.id) ? 'Find trade' : 'Find best drop'}
            </button>
          </div>
        );
      })}
      {player && (
        <div className="stack" style={{ gap: 6 }}>
          {!result ? (
            <div className="muted small">Building offers for {player.name}…</div>
          ) : result.partner === league.myTeam ? (
            <div className="notice small">{player.name} is on your team.</div>
          ) : (
            <>
              {!isFreeAgent && result.offers.length > 0 && !result.offers.some((t) => t.fair) && (
                <div className="notice small">
                  {league.teamNames[result.partner]} loses value in every package, so these are a tough sell. They come closest.
                </div>
              )}
              {hasRoom && <div className="notice small">You have an open roster spot, so you can also add him without dropping anyone (Rosters, below).</div>}
              <TradeList
                kind={isFreeAgent ? 'pickup' : 'trade'}
                title={isFreeAgent ? `Best drops to add ${player.name}` : `Best offers for ${player.name}`}
                ideas={result.offers}
                empty="You have no players to offer."
                ownerOf={ownerOf}
                targets={targets}
                punts={punts}
              />
            </>
          )}
          <button className="btn small ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setPid(null)}>
            Clear
          </button>
        </div>
      )}
    </div>
  );
}

/** Most players to shop at once: a 3-for-3 already means ~2,500 packages to score across the league. */
const MAX_AWAY = 3;

/** Pick players of mine to move and see each team's best offer for them. */
function TradeAway({ teamRosters, basis, targets, punts }: { teamRosters: PlayerData[][]; basis: Basis; targets: CatId[]; punts: CatId[] }) {
  const { ctx, ownerOf } = useApp();
  const league = useLeague((l) => l.settings);
  const [picked, setPicked] = useState<string[]>([]);
  const [offers, setOffers] = useState<TradeIdea[] | null>(null);
  const mine = teamRosters[league.myTeam];
  // In the order picked, and only while still on my team (a recorded trade may have moved one).
  const chosen = useMemo(() => picked.map((id) => mine.find((p) => p.id === id)).filter((p): p is PlayerData => !!p), [picked, mine]);
  const names = chosen.map((p) => p.name).join(' + ');

  useEffect(() => {
    setOffers(null);
    if (!chosen.length) return;
    // A 3-for-3 scores a few thousand packages: let "Building offers…" paint first.
    const timer = setTimeout(
      () => setOffers(offersAway(ctx, teamRosters, league.myTeam, chosen, league.cats, basis, { weights: strategyWeights(targets, punts) })),
      20,
    );
    return () => clearTimeout(timer);
  }, [chosen, ctx, teamRosters, league.myTeam, league.cats, basis, targets, punts]);

  const toggle = (id: string) => setPicked((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  const full = chosen.length >= MAX_AWAY;

  return (
    <div className="trade-tool trade-away">
      <h3>Trade away</h3>
      <p className="small muted" style={{ margin: 0 }}>
        Pick up to {MAX_AWAY} of your players to shop around the league. Each team's best package of as many players comes back.
      </p>
      {mine.length === 0 && <div className="muted small">Your roster is empty.</div>}
      <div className="check-list">
        {mine.map((p) => {
          const on = picked.includes(p.id);
          return (
            <label key={p.id} className="row check" style={{ padding: '3px 0' }} title={!on && full ? `Up to ${MAX_AWAY} players` : undefined}>
              <input type="checkbox" checked={on} disabled={!on && full} onChange={() => toggle(p.id)} />
              <PlayerName p={p} />
            </label>
          );
        })}
      </div>
      {chosen.length > 0 && (
        <div className="stack" style={{ gap: 6 }}>
          {!offers ? (
            <div className="muted small">Building offers for {names}…</div>
          ) : (
            <>
              {offers.length > 0 && !offers.some((t) => t.fair) && (
                <div className="notice small">Every team loses value in these deals, so they're a tough sell. They come closest.</div>
              )}
              <TradeList
                kind="trade"
                title={`Best offers for ${names}`}
                ideas={offers}
                empty={`No team has ${chosen.length} players to send back.`}
                ownerOf={ownerOf}
                targets={targets}
                punts={punts}
              />
            </>
          )}
          <button className="btn small ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setPicked([])}>
            Clear
          </button>
        </div>
      )}
    </div>
  );
}

/** A category's change in expected wins, e.g. "PTS 0.22"; targeted categories in bold. */
function CatChanges({ changes, targets }: { changes: [string, number][]; targets: CatId[] }) {
  return changes.map(([c, v], i) => (
    <Fragment key={c}>
      {i > 0 && ', '}
      {targets.includes(c as CatId) ? <b>{c}</b> : c} {Math.abs(v).toFixed(2)}
    </Fragment>
  ));
}

function TradeList({
  title,
  ideas,
  empty,
  ownerOf,
  kind,
  targets,
  punts,
}: {
  title: string;
  ideas: TradeIdea[];
  empty: string;
  ownerOf: Map<string, number>;
  kind: 'target' | 'trade' | 'pickup';
  targets: CatId[];
  punts: CatId[];
}) {
  const { ctx } = useApp();
  const league = useLeague((l) => l.settings);
  const [limit, setLimit] = useState(6);
  const players = (ids: string[]) => ids.map((id) => ctx.byId.get(id)).filter((p): p is PlayerData => !!p);
  const owner = (p: PlayerData) => (ownerOf.has(p.id) ? league.teamNames[ownerOf.get(p.id)!] : 'FA');
  return (
    <div>
      <h3 style={{ margin: '6px 0 2px' }}>{title}</h3>
      {!ideas.length && <p className="muted small">{empty}</p>}
      {ideas.slice(0, limit).map((t, i) => {
        const changes = Object.entries(t.catDelta);
        const played = changes.filter(([c]) => !punts.includes(c as CatId));
        const helps = played.filter(([, v]) => v > 0.03).sort((a, b) => b[1] - a[1]);
        const hurts = played.filter(([, v]) => v < -0.03).sort((a, b) => a[1] - b[1]);
        const givenUp = changes.filter(([c, v]) => punts.includes(c as CatId) && Math.abs(v) > 0.03);
        const groups = [
          helps.length > 0 && <span className="secondary">+ <CatChanges changes={helps} targets={targets} /></span>,
          hurts.length > 0 && <span className="muted">− <CatChanges changes={hurts} targets={targets} /></span>,
          givenUp.length > 0 && (
            <span className="muted">
              given up: {givenUp.map(([c, v]) => `${c} ${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}`).join(', ')}
            </span>
          ),
        ].filter(Boolean);
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
                  {t.fair === false && <span className="delta-down" title="Their team loses more than 0.1 expected categories a week"> · tough sell</span>}
                </>
              )}
            </div>
            {groups.length > 0 && (
              <div className="small">
                {groups.map((g, j) => (
                  <Fragment key={j}>
                    {j > 0 && <span className="muted"> · </span>}
                    {g}
                  </Fragment>
                ))}
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

const MOVE_LABEL: Record<AddMove['kind'], string> = { add: 'Add', drop: 'Add…', trade: 'Trade…', 'on-team': 'On roster' };

function RosterEditor() {
  const { data, ctx, rosterOf, ownerOf } = useApp();
  const league = useLeague((l) => l.settings);
  const rosters = useLeague((l) => l.rosters);
  const removeFromRoster = useStore((s) => s.removeFromRoster);
  const { pending, start, cancel } = useRosterMove();
  const [team, setTeam] = useState(league.myTeam);
  const [q, setQ] = useState('');
  const roster = rosterOf(team);
  const capacity = rosterCapacity(ctx, league.slots, roster);
  const ilSpots = capacity - rosterSize(league.slots);
  const matches = q.trim().length >= 2 ? data.players.filter((p) => searchKey(p.name).includes(searchKey(q.trim()))).slice(0, 8) : [];
  const finish = () => {
    cancel();
    setQ('');
  };
  return (
    <div className="card">
      <div className="card-head">
        <h2>Rosters</h2>
        <span className="spacer" />
        <select value={team} onChange={(e) => { setTeam(Number(e.target.value)); cancel(); }} aria-label="Team">
          {league.teamNames.map((n, i) => <option key={i} value={i}>{n}</option>)}
        </select>
      </div>
      <p className="small muted" style={{ marginTop: 0 }}>
        Keep rosters in sync with Yahoo after trades and waiver moves. A free agent joining a full roster means dropping someone; a
        player on another team comes over in a 1-for-1 trade.
      </p>
      <div className="row" style={{ marginBottom: 8 }}>
        <input type="search" placeholder="Add or trade for a player…" value={q} onChange={(e) => { setQ(e.target.value); cancel(); }} style={{ flex: 1 }} />
      </div>
      {matches.map((p) => {
        const move = addMove(ctx, league.slots, rosters, team, p.id);
        return (
          <div key={p.id} className="stack" style={{ gap: 6, padding: '4px 0' }}>
            <div className="row">
              <PlayerName p={p} extra={ownerOf.has(p.id) ? <span className="muted">· {league.teamNames[ownerOf.get(p.id)!]}</span> : <span className="muted">· FA</span>} />
              <span className="spacer" />
              <button className="btn small" disabled={move.kind === 'on-team'} onClick={() => start(team, p.id) && finish()}>
                {MOVE_LABEL[move.kind]}
              </button>
            </div>
            {pending?.team === team && pending.pid === p.id && <MovePicker team={team} pid={p.id} onDone={finish} onCancel={cancel} />}
          </div>
        );
      })}
      <div className="small muted" style={{ margin: '10px 0 2px' }}>
        {roster.length} of {capacity} players{ilSpots > 0 && ` (${ilSpots} IL spot${ilSpots > 1 ? 's' : ''} for injured players)`}
        {roster.length > capacity && <span className="delta-down"> · over the limit, drop someone</span>}
      </div>
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
