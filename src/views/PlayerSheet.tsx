import { useEffect } from 'react';
import { useApp } from '../AppContext';
import { MovePicker, useRosterMove } from '../components/RosterMove';
import { Icon, InjuryBadge, pct } from '../components/ui';
import { POSITIONS, type Pos, type Role } from '../data/types';
import { factorEffect, predictGame, statIndex } from '../engine/model';
import { availability, playerRates, seasonProjection } from '../engine/projection';
import { addDays, dayName, shortDate } from '../engine/schedule';
import { perGame, type SeasonLine, type StatLine } from '../engine/stats';
import { useLeague, useStore } from '../state/store';

const COLS = [
  ['min', 'MIN'], ['pts', 'PTS'], ['reb', 'REB'], ['ast', 'AST'], ['stl', 'STL'], ['blk', 'BLK'], ['tpm', '3PM'], ['to', 'TO'],
] as const;

const pctOf = (m: number, a: number) => (a > 0 ? (m / a).toFixed(3).replace(/^0/, '') : '–');

function LineRow({ label, line, gp }: { label: string; line: StatLine; gp?: number }) {
  return (
    <tr>
      <td className="l">{label}</td>
      <td className="num">{gp !== undefined ? gp.toFixed(0) : ''}</td>
      {COLS.map(([k]) => <td key={k} className="num">{line[k].toFixed(1)}</td>)}
      <td className="num">{pctOf(line.fgm, line.fga)}</td>
      <td className="num">{pctOf(line.ftm, line.fta)}</td>
    </tr>
  );
}

export function PlayerSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const { ctx, data, today } = useApp();
  const setOverride = useStore((s) => s.setOverride);
  const p = ctx.byId.get(id);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!p) return null;
  const o = ctx.overrides[p.id] ?? {};
  const rates = playerRates(ctx, p);
  const proj = seasonProjection(ctx, p);
  const start = today < data.meta.seasonStart ? data.meta.seasonStart : today;
  const upcoming = (ctx.sched.byTeam.get(p.team) ?? []).filter((g) => g.date >= start && g.date <= addDays(start, 13));
  const seasons: [string, SeasonLine | undefined][] = [
    [data.meta.curLabel, p.cur],
    [data.meta.lastLabel, p.last],
    [data.meta.prevLabel, p.prev],
  ];
  const elig = o.elig ?? p.elig;

  return (
    <div className="backdrop" onClick={onClose}>
      <div className="sheet stack" role="dialog" aria-modal="true" aria-label={p.name} onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <div>
            <h2 style={{ fontSize: 20 }}>{p.name}</h2>
            <div className="secondary small row wrap" style={{ gap: 6 }}>
              {data.teams[p.team]?.name ?? p.team} · {elig.join('/')} · age {p.age || '?'}
              {p.rookie && <span className="badge rookie">Rookie</span>}
              {p.twoWay && <span className="badge rookie">Two-way</span>}
              <InjuryBadge p={p} />
            </div>
          </div>
          <span className="spacer" />
          <button className="icon-btn" onClick={onClose} aria-label="Close">{Icon.close}</button>
        </div>
        {p.injury && <div className="notice small">{p.injury.date}: {p.injury.note}</div>}

        <div className="card">
          <div className="row" style={{ marginBottom: 6 }}>
            <h3>Per game</h3>
            <span className="spacer" />
            <span className="small muted">plays {pct(availability(ctx, p))} of games · {rates.role === 'S' ? 'starter' : 'bench'}</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="l">Season</th>
                  <th>GP</th>
                  {COLS.map(([, l]) => <th key={l}>{l}</th>)}
                  <th>FG%</th>
                  <th>FT%</th>
                </tr>
              </thead>
              <tbody>
                <tr className="mine">
                  <td className="l"><b>Projection</b></td>
                  <td className="num">{proj.gp.toFixed(0)}</td>
                  {COLS.map(([k]) => <td key={k} className="num"><b>{proj.perGame[k].toFixed(1)}</b></td>)}
                  <td className="num">{pctOf(proj.perGame.fgm, proj.perGame.fga)}</td>
                  <td className="num">{pctOf(proj.perGame.ftm, proj.perGame.fta)}</td>
                </tr>
                {seasons.filter(([, s]) => s).map(([label, s]) => <LineRow key={label} label={label} line={perGame(s)} gp={s!.gp} />)}
              </tbody>
            </table>
          </div>
          {rates.noData && (
            <p className="small muted">
              No NBA minutes yet: per-game projections use what each opponent allowed to {rates.role === 'S' ? 'starting' : 'bench'} {p.pos}s
              last season, scaled to {rates.min.toFixed(0)} minutes. Set expected minutes below if you know his role.
            </p>
          )}
        </div>

        {upcoming.length > 0 && (
          <div className="card">
            <h3 style={{ marginBottom: 6 }}>Next two weeks</h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th className="l">Game</th>
                    <th>MIN</th>
                    <th>PTS</th>
                    <th>REB</th>
                    <th>AST</th>
                    <th>3PM</th>
                    <th>STL</th>
                    <th>BLK</th>
                    <th title="Opponent defense vs. his position, effect on points">DvP</th>
                  </tr>
                </thead>
                <tbody>
                  {upcoming.map((g) => {
                    const pr = predictGame(ctx, p, g);
                    const dvp = pr.factors ? factorEffect(data.model, pr, 'pts', 'dvp') * 100 : null;
                    return (
                      <tr key={g.date}>
                        <td className="l small">
                          {dayName(g.date)} {shortDate(g.date)} {g.home ? 'vs' : '@'} {g.opp}
                          {g.b2b && <span className="muted"> · B2B</span>}
                          {pr.factors && pr.factors.h2hGames > 0 && <span className="muted"> · {pr.factors.h2hGames} past</span>}
                        </td>
                        <td className="num">{pr.min.toFixed(0)}</td>
                        {(['pts', 'reb', 'ast', 'tpm', 'stl', 'blk'] as const).map((s) => (
                          <td key={s} className="num">{pr.mean[statIndex[s]].toFixed(1)}</td>
                        ))}
                        <td className={`num ${dvp === null ? 'muted' : dvp > 1 ? 'delta-up' : dvp < -1 ? 'delta-down' : 'muted'}`}>
                          {dvp === null ? 'pos.' : Math.abs(dvp) < 0.5 ? '±0%' : `${dvp > 0 ? '+' : ''}${dvp.toFixed(0)}%`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="small muted">Projected line if he plays. DvP: how much this opponent's defense vs. {p.pos}s moves his scoring.</p>
          </div>
        )}

        <div className="card stack">
          <div className="row">
            <h3>Adjust projection</h3>
            <span className="spacer" />
            {Object.keys(o).length > 0 && <button className="btn small ghost" onClick={() => setOverride(p.id, null)}>Reset</button>}
          </div>
          <div className="row wrap">
            <label className="field">
              Minutes per game
              <input
                type="number"
                min={0}
                max={44}
                placeholder={rates.min.toFixed(1)}
                value={o.min ?? ''}
                onChange={(e) => setOverride(p.id, { min: e.target.value === '' ? undefined : Number(e.target.value) })}
                style={{ width: 100 }}
              />
            </label>
            <label className="field">
              Role
              <select value={o.role ?? ''} onChange={(e) => setOverride(p.id, { role: (e.target.value || undefined) as Role | undefined })}>
                <option value="">Auto</option>
                <option value="S">Starter</option>
                <option value="B">Bench</option>
              </select>
            </label>
            <label className="field">
              Status
              <select value={o.status ?? ''} onChange={(e) => setOverride(p.id, { status: (e.target.value || undefined) as 'out' | 'healthy' | undefined })}>
                <option value="">{p.injury ? `Auto (${p.injury.status.toUpperCase()})` : 'Auto'}</option>
                <option value="healthy">Healthy</option>
                <option value="out">Out</option>
              </select>
            </label>
            <label className="field">
              Plays % of games
              <input
                type="number"
                min={0}
                max={100}
                placeholder={(p.avail * 100).toFixed(0)}
                value={o.avail !== undefined ? Math.round(o.avail * 100) : ''}
                onChange={(e) => setOverride(p.id, { avail: e.target.value === '' ? undefined : Math.max(0, Math.min(100, Number(e.target.value))) / 100 })}
                style={{ width: 100 }}
              />
            </label>
          </div>
          <div>
            <div className="small secondary" style={{ marginBottom: 4 }}>Position eligibility (match Yahoo)</div>
            <div className="chips">
              {POSITIONS.map((pos) => (
                <button
                  key={pos}
                  className="chip"
                  aria-pressed={elig.includes(pos)}
                  onClick={() => {
                    const next = elig.includes(pos) ? elig.filter((x) => x !== pos) : POSITIONS.filter((x) => x === pos || elig.includes(x));
                    if (next.length) setOverride(p.id, { elig: next as Pos[] });
                  }}
                >
                  {pos}
                </button>
              ))}
            </div>
          </div>
        </div>

        <RosterActions key={p.id} pid={p.id} />
      </div>
    </div>
  );
}

/** Where the player is, and moves under the league's rules: add a free agent, drop to waivers, or trade to another team. */
function RosterActions({ pid }: { pid: string }) {
  const { ownerOf } = useApp();
  const teamNames = useLeague((l) => l.settings.teamNames);
  const removeFromRoster = useStore((s) => s.removeFromRoster);
  const { pending, start, cancel } = useRosterMove();
  const owner = ownerOf.get(pid);
  return (
    <div className="card stack" style={{ gap: 10 }}>
      <div className="row wrap">
        <span className="secondary">{owner !== undefined ? `On ${teamNames[owner]}` : 'Free agent'}</span>
        <span className="spacer" />
        {owner !== undefined && (
          <button
            className="btn small"
            onClick={() => {
              cancel();
              removeFromRoster(owner, pid);
            }}
          >
            Drop to waivers
          </button>
        )}
        <select value="" onChange={(e) => start(Number(e.target.value), pid)} aria-label={owner !== undefined ? 'Trade to team' : 'Add to team'}>
          <option value="" disabled>
            {owner !== undefined ? 'Trade to…' : 'Add to…'}
          </option>
          {teamNames.map((n, i) => (i === owner ? null : <option key={i} value={i}>{n}</option>))}
        </select>
      </div>
      {pending && <MovePicker team={pending.team} pid={pid} onDone={cancel} onCancel={cancel} />}
    </div>
  );
}
