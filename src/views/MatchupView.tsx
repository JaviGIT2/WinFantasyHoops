import { Fragment, useMemo, useState } from 'react';
import { useApp } from '../AppContext';
import { PlayerName, ProbBar, Segmented, pct } from '../components/ui';
import { CATEGORIES, formatCat } from '../engine/categories';
import { expandSlots } from '../engine/lineup';
import { compareAggs, projectWeek, valueWeights, type TeamWeek } from '../engine/matchup';
import { factorEffect, statIndex } from '../engine/model';
import { dayName, shortDate, weekFor } from '../engine/schedule';
import { useLeague, useStore } from '../state/store';

const signedPct = (x: number) => (Math.abs(x) < 0.5 ? '±0%' : `${x > 0 ? '+' : ''}${x.toFixed(0)}%`);

const SHOW = ['pts', 'reb', 'ast', 'tpm', 'stl', 'blk', 'to'] as const;
const LABEL: Record<(typeof SHOW)[number], string> = { pts: 'PTS', reb: 'REB', ast: 'AST', tpm: '3PM', stl: 'STL', blk: 'BLK', to: 'TO' };

export function MatchupView() {
  const { data, ctx, weeks, today, rosterOf } = useApp();
  const league = useLeague((l) => l.settings);
  const opponents = useLeague((l) => l.opponents);
  const setOpponent = useStore((s) => s.setOpponent);
  const current = weekFor(weeks, today);
  const [weekNo, setWeekNo] = useState(current?.week ?? 1);
  const week = weeks.find((w) => w.week === weekNo) ?? current;
  const others = league.teamNames.map((name, i) => ({ name, i })).filter((t) => t.i !== league.myTeam);
  const oppIdx = opponents[weekNo] ?? others[(weekNo - 1) % Math.max(1, others.length)]?.i ?? 0;
  const [side, setSide] = useState<'mine' | 'opp'>('mine');
  const [open, setOpen] = useState<string | null>(null);

  const mine = useMemo(() => rosterOf(league.myTeam), [rosterOf, league.myTeam]);
  const opp = useMemo(() => rosterOf(oppIdx), [rosterOf, oppIdx]);

  const result = useMemo(() => {
    if (!week) return null;
    const slots = expandSlots(league.slots);
    const w = valueWeights(data.model, league.cats);
    const a = projectWeek(ctx, mine, week.days, slots, w);
    const b = projectWeek(ctx, opp, week.days, slots, w);
    return { a, b, cmp: compareAggs(a.agg, b.agg, league.cats) };
  }, [ctx, data.model, week, mine, opp, league.slots, league.cats]);

  if (!weeks.length) return <div className="card empty">No schedule in the data bundle yet.</div>;
  if (!mine.length) return <div className="card empty">Draft or add players to your team first (Draft or League tab).</div>;
  if (!week || !result) return null;
  const { a, b, cmp } = result;
  const oppName = league.teamNames[oppIdx];

  return (
    <div className="stack">
      <div className="card row wrap">
        <button className="btn small" onClick={() => setWeekNo((w) => Math.max(1, w - 1))} disabled={weekNo <= 1} aria-label="Previous week">‹</button>
        <select value={weekNo} onChange={(e) => setWeekNo(Number(e.target.value))} aria-label="Week">
          {weeks.map((w) => (
            <option key={w.week} value={w.week}>
              Week {w.week}: {shortDate(w.start)}–{shortDate(w.end)}
            </option>
          ))}
        </select>
        <button className="btn small" onClick={() => setWeekNo((w) => Math.min(weeks.length, w + 1))} disabled={weekNo >= weeks.length} aria-label="Next week">›</button>
        <span className="spacer" />
        <span className="row" style={{ gap: 6 }}>
        <span className="secondary small">vs</span>
        <select value={oppIdx} onChange={(e) => setOpponent(weekNo, Number(e.target.value))} aria-label="Opponent">
          {others.map((t) => <option key={t.i} value={t.i}>{t.name}</option>)}
        </select>
        </span>
      </div>

      {!opp.length && (
        <div className="notice">{oppName} has no players yet. Record their picks in the draft or add them on the League tab.</div>
      )}

      <div className="stat-tiles">
        <div className="tile">
          <div className="k">Win probability</div>
          <div className="v num">{pct(cmp.odds.win)}</div>
          <div className="s">tie {pct(cmp.odds.tie)} · loss {pct(cmp.odds.loss)}</div>
        </div>
        <div className="tile">
          <div className="k">Expected record</div>
          <div className="v num">
            {cmp.odds.expWins.toFixed(1)}–{cmp.odds.expLosses.toFixed(1)}
          </div>
          <div className="s">{cmp.odds.expTies.toFixed(1)} ties expected</div>
        </div>
        <div className="tile">
          <div className="k">Games that count</div>
          <div className="v num">
            {a.starts.toFixed(1)} <span className="muted" style={{ fontSize: 16 }}>vs {b.starts.toFixed(1)}</span>
          </div>
          <div className="s">after daily lineup limits and injury risk</div>
        </div>
      </div>

      <div className="grid two">
        <div className="card">
          <div className="card-head">
            <h2>Categories</h2>
            <span className="spacer" />
            <span className="legend">
              <span><i className="dot mine" />{league.teamNames[league.myTeam]}</span>
              <span><i className="dot other" />{oppName}</span>
            </span>
          </div>
          <table>
            <thead>
              <tr>
                <th className="l">Cat</th>
                <th>Me</th>
                <th>Opp</th>
                <th className="l" style={{ width: '38%' }}>Win chance</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {cmp.perCat.map((c) => {
                const def = CATEGORIES[c.cat];
                return (
                  <tr key={c.cat}>
                    <td className="l"><b>{c.cat}</b></td>
                    <td className="num">{formatCat(def, c.a.mean)}</td>
                    <td className="num secondary">{formatCat(def, c.b.mean)}</td>
                    <td className="l"><ProbBar p={c.odds.win + c.odds.tie / 2} label={`${c.cat}: ${pct(c.odds.win)} win chance`} /></td>
                    <td className="num"><b>{pct(c.odds.win)}</b></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="small muted">
            Weekly totals are sums of per-game model projections for games your optimal daily lineup starts. Percentages use projected makes/attempts.
          </p>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>Games per day</h2>
          </div>
          <div className="day-grid">
            {week.days.map((d, i) => {
              const bench = a.days[i].benched.length;
              return (
                <div key={d} className={`day${d < today ? ' past' : ''}${d === today ? ' today' : ''}`}>
                  <div className="muted">{dayName(d)}</div>
                  <b className="row" style={{ justifyContent: 'center', gap: 4 }}><i className="dot mine" />{a.days[i].started.length}</b>
                  <span className="row secondary" style={{ justifyContent: 'center', gap: 4 }}><i className="dot other" />{b.days[i].started.length}</span>
                  {bench > 0 && <div className="small muted" title="Players with a game but no open slot">+{bench} BN</div>}
                </div>
              );
            })}
          </div>
          <p className="small muted">Players starting each day, after lineup limits. “BN” = your players with a game but no open slot.</p>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Player projections</h2>
          <span className="spacer" />
          <Segmented
            label="Team"
            value={side}
            onChange={setSide}
            options={[
              { value: 'mine', label: league.teamNames[league.myTeam] },
              { value: 'opp', label: oppName },
            ]}
          />
        </div>
        <PlayerTable week={side === 'mine' ? a : b} open={open} setOpen={setOpen} />
        <p className="small muted">
          Tap a player for game-by-game detail: opponent defense vs. his position (DvP), his history against that team, pace and rest.
        </p>
      </div>
    </div>
  );
}

function PlayerTable({ week, open, setOpen }: { week: TeamWeek; open: string | null; setOpen: (id: string | null) => void }) {
  const { ctx, data } = useApp();
  const rows = [...week.players].sort((x, y) => y.agg.mean[statIndex.pts] - x.agg.mean[statIndex.pts]);
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th className="l">Player</th>
            <th title="Games started / scheduled">G</th>
            {SHOW.map((s) => <th key={s}>{LABEL[s]}</th>)}
            <th>FG%</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((pw) => {
            const p = ctx.byId.get(pw.id)!;
            const started = pw.games.filter((g) => g.started).length;
            const fg = pw.agg.mean[statIndex.fga] > 0 ? pw.agg.mean[statIndex.fgm] / pw.agg.mean[statIndex.fga] : 0;
            return (
              <Fragment key={pw.id}>
                <tr className="clickable" onClick={() => setOpen(open === pw.id ? null : pw.id)}>
                  <td className="l" onClick={(e) => e.stopPropagation()}><PlayerName p={p} /></td>
                  <td className="num">{started}/{pw.games.length}</td>
                  {SHOW.map((s) => <td key={s} className="num">{pw.agg.mean[statIndex[s]].toFixed(1)}</td>)}
                  <td className="num">{fg ? fg.toFixed(3).replace(/^0/, '') : '–'}</td>
                </tr>
                {open === pw.id &&
                  pw.games.map((g) => {
                    const dvpPts = factorEffect(data.model, g, 'pts', 'dvp') * 100;
                    const h2hPts = factorEffect(data.model, g, 'pts', 'h2h') * 100;
                    return (
                      <tr key={g.date} style={{ opacity: g.started ? 1 : 0.55 }}>
                        <td className="l small">
                          {dayName(g.date)} {shortDate(g.date)} {g.home ? 'vs' : '@'} {g.opp}
                          <div className="muted">
                            {g.source === 'actual' ? 'final' : g.source === 'dnp' ? 'did not play' : g.source === 'positional' ? 'positional baseline' : `${g.min.toFixed(0)} min · ${pct(g.avail)} to play`}
                            {!g.started && g.source !== 'dnp' && ' · benched'}
                            {g.b2b && ' · back-to-back'}
                          </div>
                          {g.factors && (
                            <div className="muted">
                              DvP {signedPct(dvpPts)} pts
                              {g.factors.h2hGames > 0 && ` · vs ${g.opp} in ${g.factors.h2hGames} past games ${signedPct(h2hPts)}`}
                            </div>
                          )}
                        </td>
                        <td />
                        {SHOW.map((s) => <td key={s} className="num small">{g.mean[statIndex[s]].toFixed(1)}</td>)}
                        <td className="num small">
                          {g.mean[statIndex.fga] > 0 ? (g.mean[statIndex.fgm] / g.mean[statIndex.fga]).toFixed(3).replace(/^0/, '') : '–'}
                        </td>
                      </tr>
                    );
                  })}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
