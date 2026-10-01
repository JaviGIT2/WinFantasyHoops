import { useMemo, useState, type ReactNode } from 'react';
import { useApp } from '../AppContext';
import { Delta, Icon, PlayerName, Segmented, pct } from '../components/ui';
import type { PlayerData } from '../data/types';
import { applyCategoryEdits, CATEGORIES, catValue, formatCat, type CatDef, type CatId } from '../engine/categories';
import { eligOf, withProjectionEdits, type EngineCtx } from '../engine/context';
import { tradeImpact, type LeagueTeamReport } from '../engine/league';
import { seasonProjection, type Basis } from '../engine/projection';
import { rosterCapacity } from '../engine/roster';
import { perGame, sumLines, type StatLine } from '../engine/stats';
import { useLeague, useStore } from '../state/store';

/** A player's per-game line and games for the basis; null when he has none (no games this season yet, or a rookie last season). */
function statsFor(ctx: EngineCtx, p: PlayerData, basis: Basis): { line: StatLine; gp: number } | null {
  if (basis === 'proj') {
    const s = seasonProjection(ctx, p);
    return { line: s.perGame, gp: s.gp };
  }
  const season = basis === 'cur' ? p.cur : p.last;
  return season && season.gp > 0 ? { line: perGame(season), gp: season.gp } : null;
}

const signed = (def: CatDef, d: number) => `${d >= 0 ? '+' : '−'}${formatCat(def, Math.abs(d))}`;
const NO_DROPS: string[] = [];
/** Decimals a category is shown (and edited) with. */
const shownDigits = (def: CatDef) => (def.kind === 'ratio' && def.id !== 'A/T' ? 3 : def.decimals);
type CatEdits = Partial<Record<CatId, number>>;

export function TradeView() {
  const { data, ctx, rosterOf } = useApp();
  const league = useLeague((l) => l.settings);
  const rosters = useLeague((l) => l.rosters);
  const teamRosters = useMemo(() => rosters.map((_, i) => rosterOf(i)), [rosters, rosterOf]);
  const [basis, setBasis] = useState<Basis>(data.meta.curGames > 0 ? 'cur' : 'proj');
  const [pickA, setTeamA] = useState(league.myTeam);
  const [pickB, setTeamB] = useState(() => {
    const others = league.teamNames.map((_, i) => i).filter((i) => i !== league.myTeam);
    return others.find((i) => teamRosters[i]?.length) ?? others[0] ?? 0;
  });
  const [sendsA, setSendsA] = useState<string[]>([]);
  const [sendsB, setSendsB] = useState<string[]>([]);
  const processTrade = useStore((s) => s.processTrade);
  /** What the last processed trade did, shown until a new trade is started. */
  const [processed, setProcessed] = useState<string | null>(null);
  // Stay within the league if its team count shrinks in Settings.
  const teamA = pickA < league.teams ? pickA : league.myTeam;
  const teamB = pickB < league.teams && pickB !== teamA ? pickB : (teamA + 1) % league.teams;

  // Only players still on their team (a roster edit elsewhere may have moved one).
  const aIds = useMemo(() => sendsA.filter((id) => teamRosters[teamA]?.some((p) => p.id === id)), [sendsA, teamRosters, teamA]);
  const bIds = useMemo(() => sendsB.filter((id) => teamRosters[teamB]?.some((p) => p.id === id)), [sendsB, teamRosters, teamB]);
  // Players cut to get back under the roster limit belong to this exact trade: changing the trade clears them.
  const tradeKey = `${teamA}:${aIds.join()}|${teamB}:${bIds.join()}`;
  const [dropState, setDropState] = useState({ key: '', ids: NO_DROPS });
  const drops = dropState.key === tradeKey ? dropState.ids : NO_DROPS;
  const setDrops = (ids: string[]) => setDropState({ key: tradeKey, ids });

  // What-if projections: per-game category values typed in for players in the trade. They only count with the
  // Projection basis, and only in this page (a context of their own), never elsewhere in the app.
  const [edits, setEdits] = useState<Record<string, CatEdits>>({});
  const shotRef = useMemo(() => ({ fga: data.model.ratio['FG%'].ref, fta: data.model.ratio['FT%'].ref, tpa: data.model.ratio['3P%'].ref }), [data]);
  const statEdits = useMemo(() => {
    const out: Record<string, Partial<StatLine>> = {};
    if (basis !== 'proj') return out;
    for (const id of [...aIds, ...bIds]) {
      const p = ctx.byId.get(id);
      if (p && Object.keys(edits[id] ?? {}).length) out[id] = applyCategoryEdits(seasonProjection(ctx, p).perGame, edits[id], league.cats, shotRef);
    }
    return out;
  }, [basis, edits, aIds, bIds, ctx, league.cats, shotRef]);
  const actx = useMemo(() => withProjectionEdits(ctx, statEdits), [ctx, statEdits]);
  /** Set a player's projected value for a category; clearing it, or matching the model's value, removes the edit. */
  const editStat = (pid: string, cat: CatId, value: number | null) => {
    const p = ctx.byId.get(pid);
    if (!p) return;
    const def = CATEGORIES[cat];
    const model = catValue(def, seasonProjection(ctx, p).perGame);
    const v = value === null || !Number.isFinite(value) ? null : Math.max(0, def.kind === 'ratio' && cat !== 'A/T' ? Math.min(1, value) : value);
    setEdits((all) => {
      const mine = { ...all[pid] };
      if (v === null || Math.abs(v - model) < 0.5 * 10 ** -shownDigits(def)) delete mine[cat];
      else mine[cat] = v;
      return { ...all, [pid]: mine };
    });
  };
  const resetEdits = (pid?: string) => setEdits((all) => (pid ? { ...all, [pid]: {} } : {}));

  const filled = teamRosters.filter((r) => r.length > 0).length;
  const impact = useMemo(
    () => (filled >= 2 && aIds.length + bIds.length > 0 ? tradeImpact(actx, teamRosters, teamA, teamB, aIds, bIds, league.cats, basis, drops) : null),
    [actx, teamRosters, teamA, teamB, aIds, bIds, league.cats, basis, filled, drops],
  );

  const players = (team: number, ids: string[]) => (teamRosters[team] ?? []).filter((p) => ids.includes(p.id));
  const fromA = players(teamA, aIds);
  const fromB = players(teamB, bIds);
  const { lastLabel, curLabel, curGames } = data.meta;

  // A trade can be processed with players going both ways and both teams within their roster limits after drops.
  const excess = (t: number) => (impact ? impact.rosters[t].length - rosterCapacity(ctx, league.slots, impact.rosters[t]) : 0);
  const blocker = !aIds.length || !bIds.length
    ? 'Add a player to each side to process the trade.'
    : [teamA, teamB].filter((t) => excess(t) > 0).map((t) => `${league.teamNames[t]} needs to drop ${excess(t)} more.`).join(' ') || null;
  const process = () => {
    if (!impact) return;
    const list = (ps: PlayerData[]) => ps.map((p) => p.name).join(', ');
    const lines = [`${league.teamNames[teamA]} sends ${list(fromA)}`, `${league.teamNames[teamB]} sends ${list(fromB)}`];
    for (const t of [teamA, teamB]) {
      const cut = impact.traded[t].filter((p) => drops.includes(p.id));
      if (cut.length) lines.push(`${league.teamNames[t]} drops ${list(cut)}`);
    }
    if (!confirm(`Process this trade?\n\n${lines.join('\n')}\n\nBoth rosters will be updated.`)) return;
    processTrade(teamA, teamB, aIds, bIds, drops);
    setProcessed(`${lines.join('. ')}.`);
    setSendsA([]);
    setSendsB([]);
    setEdits({});
  };
  const startOver = (set: (ids: string[]) => void) => (ids: string[]) => {
    setProcessed(null);
    set(ids);
  };

  return (
    <div className="stack">
      <div className="card row wrap">
        <h2>Trade Analyzer</h2>
        <span className="spacer" />
        <Segmented
          label="Stat basis"
          value={basis}
          onChange={setBasis}
          options={[
            { value: 'last', label: `${lastLabel} avg` },
            { value: 'proj', label: 'Projection' },
            { value: 'cur', label: `${curLabel} season` },
          ]}
        />
      </div>
      <p className="small muted" style={{ margin: '-4px 2px 0' }}>
        {basis === 'last'
          ? `${lastLabel} per-game averages.`
          : basis === 'proj'
            ? 'Blended projection (current games shrunk toward last season, aging applied).'
            : `${curLabel} per-game averages${curGames ? '' : ` (no ${curLabel} games yet)`}; team impact uses ${lastLabel} for players with fewer than 5 games.`}{' '}
        Team impact credits each player with 3.5 games a week, discounted for missed-game risk.
      </p>

      {filled < 2 ? (
        <div className="card empty">Add rosters for at least two teams first (track every pick in the draft, or use League → Rosters).</div>
      ) : (
        <>
          <div className="grid two">
            <TradeSide team={teamA} other={teamB} sends={aIds} onTeam={(t) => { setTeamA(t); setSendsA([]); }} onSends={startOver(setSendsA)} />
            <TradeSide team={teamB} other={teamA} sends={bIds} onTeam={(t) => { setTeamB(t); setSendsB([]); }} onSends={startOver(setSendsB)} />
          </div>

          {!impact ? (
            processed ? (
              <div className="notice success" role="status">
                <b>Trade processed.</b> {processed} Both rosters are updated.
              </div>
            ) : (
              <div className="card empty">Add players to either side to see the stats and how the trade changes each team.</div>
            )
          ) : (
            <>
              <PlayerStats
                ctx={actx}
                basis={basis}
                sides={[
                  { name: league.teamNames[teamA], players: fromA },
                  { name: league.teamNames[teamB], players: fromB },
                ]}
                edits={edits}
                onEdit={editStat}
                onReset={resetEdits}
              />
              <div className="card row wrap" style={{ gap: 14 }}>
                <span className="secondary">Expected categories won per week:</span>
                {[teamA, teamB].map((t) => (
                  <span key={t}>
                    <b>{league.teamNames[t]}</b> <Delta v={impact.after[t].power - impact.before[t].power} />
                  </span>
                ))}
                <span className="spacer" />
                {blocker && <span className="small muted">{blocker}</span>}
                <button className="btn primary" disabled={!!blocker} onClick={process}>
                  Process trade
                </button>
              </div>
              <div className="grid two">
                {[
                  { team: teamA, gets: fromB, gives: fromA },
                  { team: teamB, gets: fromA, gives: fromB },
                ].map((s) => (
                  <TeamImpact
                    key={s.team}
                    {...s}
                    before={impact.before}
                    after={impact.after}
                    traded={impact.traded[s.team]}
                    final={impact.rosters[s.team]}
                    drops={drops}
                    onDrops={setDrops}
                  />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

/** One side of the trade: the team and the players it sends. */
function TradeSide({ team, other, sends, onTeam, onSends }: { team: number; other: number; sends: string[]; onTeam: (t: number) => void; onSends: (ids: string[]) => void }) {
  const { ctx, rosterOf } = useApp();
  const teamNames = useLeague((l) => l.settings.teamNames);
  const roster = rosterOf(team);
  const chosen = roster.filter((p) => sends.includes(p.id));
  const rest = roster.filter((p) => !sends.includes(p.id)).sort((x, y) => x.name.localeCompare(y.name));
  return (
    <div className="card stack" style={{ gap: 8 }}>
      <div className="row">
        <select value={team} onChange={(e) => onTeam(Number(e.target.value))} aria-label="Team" style={{ fontWeight: 600 }}>
          {teamNames.map((n, i) => (i === other ? null : <option key={i} value={i}>{n}</option>))}
        </select>
        <span className="secondary">sends</span>
      </div>
      {chosen.length === 0 && <div className="muted small">No players yet.</div>}
      {chosen.map((p) => (
        <div key={p.id} className="row">
          <PlayerName p={p} />
          <span className="spacer" />
          <button className="icon-btn" onClick={() => onSends(sends.filter((id) => id !== p.id))} aria-label={`Remove ${p.name}`}>
            {Icon.close}
          </button>
        </div>
      ))}
      <select value="" onChange={(e) => onSends([...sends, e.target.value])} aria-label={`Add a player from ${teamNames[team]}`} disabled={!rest.length}>
        <option value="" disabled>
          {roster.length ? (rest.length ? 'Add a player…' : 'Everyone is in the trade') : `${teamNames[team]} has no players`}
        </option>
        {rest.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} ({p.team} · {eligOf(ctx, p).join(',')})
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Per-game stats of everyone in the trade, grouped by the team sending them, with each side's total. With the
 * Projection basis the projected values can be edited (what-ifs; `ctx` already carries them).
 */
function PlayerStats({
  ctx,
  basis,
  sides,
  edits,
  onEdit,
  onReset,
}: {
  ctx: EngineCtx;
  basis: Basis;
  sides: { name: string; players: PlayerData[] }[];
  edits: Record<string, CatEdits>;
  onEdit: (pid: string, cat: CatId, value: number | null) => void;
  onReset: (pid?: string) => void;
}) {
  const cats = useLeague((l) => l.settings.cats);
  const [editing, setEditing] = useState(false);
  const isProj = basis === 'proj';
  const hasEdits = (pid: string) => Object.keys(edits[pid] ?? {}).length > 0;
  const anyEdits = sides.some((s) => s.players.some((p) => hasEdits(p.id)));
  const cell = (line: StatLine, p?: PlayerData) =>
    cats.map((c) => {
      const def = CATEGORIES[c];
      const value = catValue(def, line);
      const className = `num${p && isProj && edits[p.id]?.[c] !== undefined ? ' edited' : ''}`;
      if (p && isProj && editing && c !== 'A/T') {
        return (
          <td key={c} className={className}>
            <StatInput value={value} digits={shownDigits(def)} ratio={def.kind === 'ratio'} label={`${p.name} ${c}`} onCommit={(v) => onEdit(p.id, c, v)} />
          </td>
        );
      }
      return <td key={c} className={className}>{formatCat(def, value)}</td>;
    });
  return (
    <div className="card">
      <div className="card-head" style={{ marginBottom: 4 }}>
        <h2>Player stats</h2>
        <span className="small muted">per game</span>
        <span className="spacer" />
        {isProj ? (
          <>
            {anyEdits && (
              <button className="btn small ghost" onClick={() => onReset()}>
                Reset edits
              </button>
            )}
            <button className="btn small" aria-pressed={editing} onClick={() => setEditing((e) => !e)}>
              {editing ? 'Done' : 'Edit projections'}
            </button>
          </>
        ) : (
          <span className="small muted">
            {anyEdits ? 'Your projection edits apply with Projection selected.' : 'Switch to Projection to edit projected stats.'}
          </span>
        )}
      </div>
      {isProj && (editing || anyEdits) && (
        <p className="small muted" style={{ margin: '0 0 6px' }}>
          Edited projections are what-ifs for this trade: they change these numbers and the team impact below, not projections anywhere else
          in the app. A new percentage changes the made shots; new made threes keep the 3P% by scaling the attempts.
        </p>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th className="l">Player</th>
              <th title={basis === 'proj' ? 'Projected games this season' : 'Games played'}>GP</th>
              <th>MIN</th>
              {cats.map((c) => <th key={c} title={CATEGORIES[c].label}>{c}</th>)}
            </tr>
          </thead>
          {sides.map((side) => {
            const rows = side.players.map((p) => ({ p, s: statsFor(ctx, p, basis) }));
            const counted = rows.flatMap((r) => (r.s ? [r.s.line] : []));
            return (
              <tbody key={side.name}>
                <tr className="group">
                  <td className="l" colSpan={3 + cats.length}>{side.name} sends</td>
                </tr>
                {rows.length === 0 && (
                  <tr>
                    <td className="l muted" colSpan={3 + cats.length}>Nobody</td>
                  </tr>
                )}
                {rows.map(({ p, s }) => (
                  <tr key={p.id}>
                    <td className="l">
                      <div className="row" style={{ gap: 8 }}>
                        <PlayerName p={p} />
                        {isProj && editing && hasEdits(p.id) && (
                          <button className="textlink" onClick={() => onReset(p.id)} aria-label={`Reset ${p.name}'s projection`}>
                            Reset
                          </button>
                        )}
                      </div>
                    </td>
                    <td className="num">{s ? Math.round(s.gp) : '–'}</td>
                    <td className="num">{s ? s.line.min.toFixed(1) : '–'}</td>
                    {s ? cell(s.line, p) : cats.map((c) => <td key={c} className="num muted">–</td>)}
                  </tr>
                ))}
                {counted.length > 1 && (
                  <tr className="total">
                    <td className="l">Total</td>
                    <td />
                    <td className="num">{sumLines(counted).min.toFixed(1)}</td>
                    {cell(sumLines(counted))}
                  </tr>
                )}
              </tbody>
            );
          })}
        </table>
      </div>
    </div>
  );
}

/** A number box that commits on blur or Enter, so typing isn't fought by re-formatting. Percentages take .480 or 48. */
function StatInput({ value, digits, ratio, label, onCommit }: { value: number; digits: number; ratio: boolean; label: string; onCommit: (v: number | null) => void }) {
  const shown = value.toFixed(digits);
  const [text, setText] = useState(shown);
  const [focused, setFocused] = useState(false);
  // While not being typed in, mirror the current value (after a commit, a reset, or a basis change).
  if (!focused && text !== shown) setText(shown);
  const commit = () => {
    setFocused(false);
    const t = text.trim();
    if (!t) return onCommit(null);
    const v = Number(t);
    if (!Number.isFinite(v)) return setText(shown);
    onCommit(ratio && v > 1 ? v / 100 : v);
  };
  return (
    <input
      type="number"
      className="stat-edit"
      inputMode="decimal"
      min={0}
      step={ratio ? 0.001 : 0.1}
      aria-label={label}
      value={text}
      onFocus={() => setFocused(true)}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
    />
  );
}

function BeforeAfter({ label, before, after, show, delta }: { label: string; before: number; after: number; show: (v: number) => string; delta: ReactNode }) {
  return (
    <div className="tile">
      <div className="k">{label}</div>
      <div className="v">{show(after)}</div>
      <div className="s">
        was {show(before)} · {delta}
      </div>
    </div>
  );
}

/**
 * How one team changes: overall strength, matchup odds, league rank, roster size, and every category. A team the trade
 * puts over its roster limit picks who to drop, and every number then counts those drops.
 */
function TeamImpact({
  team,
  gets,
  gives,
  before,
  after,
  traded,
  final,
  drops,
  onDrops,
}: {
  team: number;
  gets: PlayerData[];
  gives: PlayerData[];
  before: LeagueTeamReport[];
  after: LeagueTeamReport[];
  /** Roster right after the trade, before any drops. */
  traded: PlayerData[];
  /** Roster after drops. */
  final: PlayerData[];
  drops: string[];
  onDrops: (ids: string[]) => void;
}) {
  const { ctx, rosterOf } = useApp();
  const league = useLeague((l) => l.settings);
  const b = before[team];
  const a = after[team];
  const rankOf = (reports: LeagueTeamReport[]) => 1 + reports.filter((r) => r.power > reports[team].power).length;
  const rankBefore = rankOf(before);
  const rankAfter = rankOf(after);
  const sizeBefore = rosterOf(team).length;
  const capacity = rosterCapacity(ctx, league.slots, final);
  const over = final.length - capacity;
  const mustDrop = traded.length > rosterCapacity(ctx, league.slots, traded);
  const dropped = traded.filter((p) => drops.includes(p.id));
  const name = league.teamNames[team];
  const names = (ps: PlayerData[]) => ps.map((p) => p.name).join(', ') || 'nobody';
  return (
    <div className="card stack">
      <div>
        <h2>{name}</h2>
        <div className="small secondary" style={{ marginTop: 2 }}>
          Gets {names(gets)} · sends {names(gives)}
          {dropped.length > 0 && ` · drops ${names(dropped)}`}
        </div>
      </div>
      <div className="stat-tiles">
        <BeforeAfter label="Exp. cats / week" before={b.power} after={a.power} show={(v) => v.toFixed(2)} delta={<Delta v={a.power - b.power} />} />
        <BeforeAfter label="Matchup win %" before={b.winPct} after={a.winPct} show={pct} delta={<Delta v={(a.winPct - b.winPct) * 100} digits={0} suffix="%" />} />
        <BeforeAfter label="League rank" before={rankBefore} after={rankAfter} show={(v) => `#${v}`} delta={<Delta v={rankBefore - rankAfter} digits={0} />} />
        <BeforeAfter label="Roster" before={sizeBefore} after={final.length} show={String} delta={<span className="muted">limit {capacity}</span>} />
      </div>
      {mustDrop && (
        <div className={`notice small stack drop-picker${over > 0 ? ' error' : ''}`}>
          <span>
            {over > 0
              ? `${name} would have ${final.length} players, ${over} over the limit. Pick ${over > 1 ? `${over} players` : 'a player'} to drop:`
              : `Dropping ${names(dropped)} keeps ${name} within the ${capacity}-player limit.`}
          </span>
          <div className="check-list">
            {traded.map((p) => {
              const on = drops.includes(p.id);
              return (
                <label key={p.id} className="row check">
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={!on && over <= 0}
                    onChange={() => onDrops(on ? drops.filter((id) => id !== p.id) : [...drops, p.id])}
                  />
                  <PlayerName p={p} extra={gets.includes(p) ? <span className="badge mine">new</span> : undefined} />
                </label>
              );
            })}
          </div>
        </div>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th className="l">Category</th>
              <th title="Projected per week">Before</th>
              <th>After</th>
              <th>Change</th>
              <th title="Change in expected wins per week against the league">Wins / wk</th>
              <th title="League rank, 1 = best">Rank</th>
            </tr>
          </thead>
          <tbody>
            {league.cats.map((c) => {
              const def = CATEGORIES[c];
              const d = a.values[c] - b.values[c];
              const better = def.lowerIsBetter ? -d : d;
              const flat = Math.abs(d) < 0.5 * 10 ** -(def.kind === 'ratio' && c !== 'A/T' ? 3 : def.decimals);
              return (
                <tr key={c}>
                  <td className="l">{c}</td>
                  <td className="num">{formatCat(def, b.values[c])}</td>
                  <td className="num">{formatCat(def, a.values[c])}</td>
                  <td className={`num ${flat ? 'muted' : better > 0 ? 'delta-up' : 'delta-down'}`}>{flat ? '±0' : signed(def, d)}</td>
                  <td className="num"><Delta v={a.catWins[c] - b.catWins[c]} /></td>
                  <td className="num">
                    {b.ranks[c]} → {a.ranks[c]}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
