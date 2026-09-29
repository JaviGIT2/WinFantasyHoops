import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../AppContext';
import { PlayerName, Segmented, pct } from '../components/ui';
import { CATEGORIES, formatCat, type CatId } from '../engine/categories';
import { expandSlots } from '../engine/lineup';
import { lineValue, valueWeights } from '../engine/matchup';
import { playerWeekAgg } from '../engine/league';
import { dayName, shortDate, weekFor } from '../engine/schedule';
import { planStreams, type StreamPlan } from '../engine/streaming';
import { useStore } from '../state/store';

export function StreamView() {
  const { data, ctx, weeks, today, rosterOf, freeAgents } = useApp();
  const league = useStore((s) => s.league);
  const stream = useStore((s) => s.stream);
  const updateStream = useStore((s) => s.updateStream);
  const opponents = useStore((s) => s.opponents);
  const week = weekFor(weeks, today);
  const weekNo = week?.week ?? 1;
  const mine = useMemo(() => rosterOf(league.myTeam), [rosterOf, league.myTeam]);
  const others = league.teamNames.map((_, i) => i).filter((i) => i !== league.myTeam);
  const oppIdx = opponents[weekNo] ?? others[(weekNo - 1) % Math.max(1, others.length)] ?? 0;
  const opp = useMemo(() => rosterOf(oppIdx), [rosterOf, oppIdx]);
  const planFrom = week ? (today < week.start ? week.start : today > week.end ? week.end : today) : today;
  const addsUsed = stream.addsUsed[weekNo] ?? 0;
  const addsLeft = Math.max(0, league.weeklyAdds - addsUsed);
  const droppable = stream.droppable.filter((id) => mine.some((p) => p.id === id));
  const chase = stream.chase.filter((c) => league.cats.includes(c));
  const mode = stream.mode === 'win' && !opp.length ? 'chase' : stream.mode;

  const [plan, setPlan] = useState<StreamPlan | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setPlan(null), [ctx, mine, opp, stream, league, today]);

  // Suggest the two least valuable players (season-long) as stream spots.
  const suggestDrops = () => {
    const w = valueWeights(data.model, league.cats);
    const ranked = [...mine].sort(
      (a, b) => lineValue(playerWeekAgg(ctx, a, 'proj').mean, w) - lineValue(playerWeekAgg(ctx, b, 'proj').mean, w),
    );
    updateStream({ droppable: ranked.slice(0, 2).map((p) => p.id) });
  };

  const run = () => {
    if (!week) return;
    setBusy(true);
    setTimeout(() => {
      setPlan(
        planStreams(ctx, {
          roster: mine,
          droppable,
          freeAgents,
          days: week.days,
          today: planFrom,
          addsLeft,
          addTiming: league.addTiming,
          slots: expandSlots(league.slots),
          leagueCats: league.cats,
          mode,
          chase,
          opponent: opp.length ? opp : undefined,
        }),
      );
      setBusy(false);
    }, 20);
  };

  if (!week) return <div className="card empty">No schedule in the data bundle yet.</div>;
  if (!mine.length) return <div className="card empty">Draft or add players to your team first.</div>;

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <h2>Streaming planner</h2>
          <span className="spacer" />
          <span className="secondary small">
            Week {week.week}: {shortDate(week.start)}–{shortDate(week.end)} · planning from {dayName(planFrom)} {shortDate(planFrom)}
          </span>
        </div>

        <div className="grid two">
          <div className="stack">
            <label className="field">
              Goal
              <Segmented
                label="Goal"
                value={mode}
                onChange={(m) => updateStream({ mode: m })}
                options={[
                  { value: 'win', label: `Beat ${league.teamNames[oppIdx]}` },
                  { value: 'chase', label: 'Chase categories' },
                ]}
              />
            </label>
            {stream.mode === 'win' && !opp.length && (
              <p className="small notice" style={{ margin: 0 }}>
                {league.teamNames[oppIdx]} has no roster yet, so the planner is chasing the categories below instead. Add their players on the League tab.
              </p>
            )}
            {mode === 'win' ? (
              <p className="small muted" style={{ margin: 0 }}>
                Weights each category by how much one more unit raises your chance of winning it this week, so close categories drive the picks.
                Change the opponent on the Matchup tab.
              </p>
            ) : (
              <div>
                <div className="small secondary" style={{ marginBottom: 6 }}>Maximize these totals</div>
                <div className="chips">
                  {league.cats.map((c) => (
                    <button
                      key={c}
                      className="chip"
                      aria-pressed={chase.includes(c)}
                      onClick={() => updateStream({ chase: chase.includes(c) ? chase.filter((x) => x !== c) : [...chase, c] })}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="row wrap">
              <label className="field">
                Adds used this week
                <input
                  type="number"
                  min={0}
                  max={league.weeklyAdds}
                  value={addsUsed}
                  onChange={(e) => updateStream({ addsUsed: { ...stream.addsUsed, [weekNo]: Math.max(0, Number(e.target.value)) } })}
                  style={{ width: 90 }}
                />
              </label>
              <div className="field">
                Adds left
                <b style={{ fontSize: 20 }}>{addsLeft} <span className="muted small">of {league.weeklyAdds}</span></b>
              </div>
              <div className="field">
                New adds play
                <b>{league.addTiming === 'same' ? 'same day' : 'next day'}</b>
              </div>
            </div>
          </div>

          <div>
            <div className="row" style={{ marginBottom: 6 }}>
              <span className="small secondary">Droppable (stream) spots</span>
              <span className="spacer" />
              <button className="btn small ghost" onClick={suggestDrops}>Suggest</button>
            </div>
            <div className="check-list">
            {mine.map((p) => (
              <label key={p.id} className="row check" style={{ padding: '3px 0' }}>
                <input
                  type="checkbox"
                  checked={droppable.includes(p.id)}
                  onChange={(e) =>
                    updateStream({ droppable: e.target.checked ? [...droppable, p.id] : droppable.filter((x) => x !== p.id) })
                  }
                />
                <PlayerName p={p} />
              </label>
            ))}
            </div>
          </div>
        </div>

        <div className="row" style={{ marginTop: 12 }}>
          <span className="small muted">
            {droppable.length === 0
              ? 'Mark at least one droppable player.'
              : mode === 'chase' && !chase.length
                ? 'Pick at least one category to chase.'
                : addsLeft === 0
                  ? 'No adds left this week.'
                  : `${freeAgents.length} free agents in the pool.`}
          </span>
          <span className="spacer" />
          <button
            className="btn primary"
            onClick={run}
            disabled={busy || !droppable.length || addsLeft === 0 || (mode === 'chase' && !chase.length)}
          >
            {busy ? 'Optimizing…' : 'Optimize streams'}
          </button>
        </div>
      </div>

      {plan && <PlanView plan={plan} mode={mode} oppName={league.teamNames[oppIdx]} />}
    </div>
  );
}

function PlanView({ plan, mode, oppName }: { plan: StreamPlan; mode: 'chase' | 'win'; oppName: string }) {
  const { ctx } = useApp();
  const shown = mode === 'chase' ? plan.chase : plan.chase.filter((c) => Math.abs(c.after - c.before) > 1e-6 || (plan.weights[c.cat] ?? 0) > 0.3);
  return (
    <>
      <div className="stat-tiles">
        {plan.oddsBefore && plan.oddsAfter && (
          <div className="tile">
            <div className="k">Win chance vs {oppName}</div>
            <div className="v num">{pct(plan.oddsBefore.win)} → {pct(plan.oddsAfter.win)}</div>
            <div className="s">
              expected cats {plan.oddsBefore.expWins.toFixed(1)} → {plan.oddsAfter.expWins.toFixed(1)}
            </div>
          </div>
        )}
        <div className="tile">
          <div className="k">Adds used</div>
          <div className="v num">{plan.addsUsed}</div>
          <div className="s">games that count {plan.before.starts.toFixed(1)} → {plan.after.starts.toFixed(1)}</div>
        </div>
      </div>

      <div className="grid two">
        <div className="card">
          <h2 style={{ marginBottom: 8 }}>Moves</h2>
          {!plan.moves.length && <p className="muted">No stream beats keeping your current players for these goals.</p>}
          {plan.moves.map((m, i) => {
            const add = ctx.byId.get(m.add)!;
            const drop = ctx.byId.get(m.drop)!;
            return (
              <div key={i} className="move">
                <div className="small"><b>{dayName(m.decideOn)} {shortDate(m.decideOn)}</b></div>
                <div className="small secondary">
                  {m.decideOn !== m.effective ? `effective ${dayName(m.effective)} ${shortDate(m.effective)}` : 'same-day add'}
                </div>
                <div className="small muted">Add</div>
                <PlayerName p={add} />
                <div className="small muted">Drop</div>
                <PlayerName p={drop} />
                <div className="small muted">Plays</div>
                <div className="small">{m.games.map((d) => `${dayName(d)} ${shortDate(d)}`).join(' · ') || 'no starts'}</div>
              </div>
            );
          })}
        </div>

        <div className="card">
          <h2 style={{ marginBottom: 8 }}>{mode === 'chase' ? 'Chased totals' : 'Category totals'}</h2>
          <table>
            <thead>
              <tr>
                <th className="l">Cat</th>
                <th>Before</th>
                <th>After</th>
                <th>Change</th>
                {mode === 'win' && <th title="Relative weight from marginal win probability">Weight</th>}
              </tr>
            </thead>
            <tbody>
              {shown.map((c) => {
                const def = CATEGORIES[c.cat as CatId];
                const d = c.after - c.before;
                const good = def.lowerIsBetter ? d < 0 : d > 0;
                return (
                  <tr key={c.cat}>
                    <td className="l"><b>{c.cat}</b></td>
                    <td className="num">{formatCat(def, c.before)}</td>
                    <td className="num">{formatCat(def, c.after)}</td>
                    <td className={`num ${Math.abs(d) < 1e-6 ? 'muted' : good ? 'delta-up' : 'delta-down'}`}>
                      {d >= 0 ? '+' : ''}{def.kind === 'ratio' ? d.toFixed(3) : d.toFixed(1)}
                    </td>
                    {mode === 'win' && <td className="num muted">{(plan.weights[c.cat] ?? 0).toFixed(2)}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginBottom: 8 }}>Best streamers for the rest of the week</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th className="l">Player</th>
                <th>Games left</th>
                <th title="Sum of weighted per-game value over usable games">Value</th>
                <th className="l">Days</th>
              </tr>
            </thead>
            <tbody>
              {plan.candidates.slice(0, 15).map((c) => (
                <tr key={c.id}>
                  <td className="l"><PlayerName p={ctx.byId.get(c.id)!} /></td>
                  <td className="num">{c.games.length}</td>
                  <td className="num">{c.value.toFixed(2)}</td>
                  <td className="l small secondary">{c.games.map(dayName).join(' ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted">Only days when your core lineup leaves an open slot he can fill are counted.</p>
      </div>
    </>
  );
}
