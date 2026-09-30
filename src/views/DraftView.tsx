import { useCallback, useDeferredValue, useMemo, useState } from 'react';
import { useApp } from '../AppContext';
import { RadarChart } from '../components/RadarChart';
import { PlayerName, Segmented, zStyle } from '../components/ui';
import { searchKey } from '../data/loader';
import type { PlayerData, Pos } from '../data/types';
import { CATEGORIES, catValue, formatCat, type CatId } from '../engine/categories';
import { rosterSize } from '../engine/lineup';
import { seasonProjection } from '../engine/projection';
import { perGame, sumLines, type StatLine } from '../engine/stats';
import { computeZ, teamStrength, weightedValue, type ZResult } from '../engine/zscore';
import { snakeTeam, useLeague, useStore } from '../state/store';

type Mode = 'avg' | 'tot';
type Season = 'last' | 'proj';

const EMPTY: string[] = [];
const NO_WEIGHTS: Partial<Record<CatId, number>> = {};
const POS_FILTERS = ['All', 'PG', 'SG', 'G', 'SF', 'PF', 'F', 'C'] as const;
const matchesPos = (p: PlayerData, f: (typeof POS_FILTERS)[number]) => {
  if (f === 'All') return true;
  if (f === 'G') return p.elig.some((e) => e === 'PG' || e === 'SG');
  if (f === 'F') return p.elig.some((e) => e === 'SF' || e === 'PF');
  return p.elig.includes(f as Pos);
};

/** Stat line for a player under one of the four draft displays. */
function lineFor(ctx: ReturnType<typeof useApp>['ctx'], p: PlayerData, season: Season, mode: Mode): StatLine {
  if (season === 'last') return mode === 'avg' ? perGame(p.last) : p.last ?? perGame(undefined);
  const proj = seasonProjection(ctx, p);
  return mode === 'avg' ? proj.perGame : proj.totals;
}

/** Raw category value for a pool cell; season totals of counting stats show as whole numbers. */
function rawCell(c: CatId, line: StatLine, mode: Mode): string {
  const d = CATEGORIES[c];
  if (!line.min || (d.kind === 'ratio' && !line[d.den!])) return '–';
  const v = catValue(d, line);
  return mode === 'tot' && d.kind === 'count' ? v.toFixed(0) : formatCat(d, v);
}

export function DraftView() {
  const { data, ctx, ownerOf } = useApp();
  const league = useLeague((l) => l.settings);
  const picks = useLeague((l) => l.picks);
  const draft = useStore((s) => s.draft);
  const undoPick = useStore((s) => s.undoPick);
  const resetDraft = useStore((s) => s.resetDraft);
  const updateLeague = useStore((s) => s.updateLeague);

  const cats = league.cats;
  const punts = useMemo(() => league.punts.filter((c) => cats.includes(c)), [league.punts, cats]);
  const weights = league.catWeights ?? NO_WEIGHTS;
  // Multiplier applied to each category's z-score in the pool rankings; punted categories count 0.
  const weightOf = useCallback((c: CatId) => (punts.includes(c) ? 0 : weights[c] ?? 1), [punts, weights]);
  const size = rosterSize(league.slots);
  const poolSize = league.teams * size;
  const totalPicks = poolSize;
  const onClock = league.trackAllTeams ? snakeTeam(picks.length, league.teams) : league.myTeam;
  const storedIds = useLeague((l) => l.rosters[league.myTeam] ?? EMPTY);
  // Ignore ids that are no longer in the data bundle (e.g. a player waived since the draft).
  const myIds = useMemo(() => storedIds.filter((id) => ctx.byId.has(id)), [storedIds, ctx]);
  // Tracking only your own team, the draft ends when your roster is full.
  const done = league.trackAllTeams ? picks.length >= totalPicks : myIds.length >= size;

  // Four valuation tables: {last season, projection} × {per game, totals}.
  const z = useMemo(() => {
    const make = (season: Season, mode: Mode) =>
      computeZ(data.players.map((p) => ({ id: p.id, line: lineFor(ctx, p, season, mode) })), cats, poolSize, punts);
    return { last: { avg: make('last', 'avg'), tot: make('last', 'tot') }, proj: { avg: make('proj', 'avg'), tot: make('proj', 'tot') } };
  }, [data, ctx, cats, poolSize, punts]);

  const [modes, setModes] = useState<Record<Season, Mode>>({ last: 'avg', proj: 'avg' });
  const [mobileRadar, setMobileRadar] = useState<Season>('proj');
  const [query, setQuery] = useState('');
  const [posF, setPosF] = useState<(typeof POS_FILTERS)[number]>('All');
  const [sortBy, setSortBy] = useState<'proj' | 'last' | 'fit'>('proj');
  // Pool rankings on per-game averages or season totals (totals reward games played).
  const [poolMode, setPoolMode] = useState<Mode>('avg');
  // Pool cells as z-scores or raw stats; rankings and shading use z-scores either way.
  const [cellMode, setCellMode] = useState<'z' | 'raw'>('z');
  const [showTaken, setShowTaken] = useState(false);
  const [limit, setLimit] = useState(60);
  const [preview, setPreview] = useState<string | null>(null);
  const deferredQuery = useDeferredValue(query);

  const strength = (season: Season, ids: string[]) => teamStrength(z[season][modes[season]], ids, cats);
  const projStrength = useMemo(() => teamStrength(z.proj[poolMode], myIds, cats), [z, myIds, cats, poolMode]);

  const rows = useMemo(() => {
    const q = searchKey(deferredQuery.trim());
    const zp = z.proj[poolMode];
    const fit = (id: string) =>
      cats.reduce((s, c) => s + weightOf(c) * (zp.rows.get(id)?.z[c] ?? 0) * (1.5 - projStrength[c] / 100), 0);
    return data.players
      .filter((p) => (showTaken || !ownerOf.has(p.id)) && matchesPos(p, posF) && (!q || searchKey(p.name).includes(q)))
      .map((p) => {
        const proj = z.proj[poolMode].rows.get(p.id)!;
        const last = z.last[poolMode].rows.get(p.id)!;
        const value = sortBy === 'fit' ? fit(p.id) : weightedValue(sortBy === 'last' ? last : proj, cats, weightOf);
        return { p, proj, last, value };
      })
      .sort((a, b) => b.value - a.value);
  }, [data, z, deferredQuery, posF, sortBy, poolMode, showTaken, ownerOf, cats, weightOf, projStrength]);

  const togglePunt = (c: CatId) =>
    updateLeague({
      punts: punts.includes(c) ? punts.filter((x) => x !== c) : [...punts, c],
      // A punted category can't also be a target (League → Optimize my team).
      targets: league.targets.filter((x) => x !== c),
    });

  const doDraft = (id: string) => {
    draft(id, onClock);
    if (preview === id) setPreview(null);
  };

  const round = Math.floor(picks.length / league.teams) + 1;
  const pickInRound = (picks.length % league.teams) + 1;
  const myTurn = !done && onClock === league.myTeam;
  const previewPlayer = preview ? ctx.byId.get(preview) : undefined;

  const radarPanel = (season: Season) => {
    const zr: ZResult = z[season][modes[season]];
    const mine = strength(season, myIds);
    const withPreview = previewPlayer ? strength(season, [...myIds, previewPlayer.id]) : null;
    const lines = myIds.map((id) => lineFor(ctx, ctx.byId.get(id)!, season, modes[season]));
    const teamLine = sumLines(lines);
    const previewLine = previewPlayer ? sumLines([...lines, lineFor(ctx, previewPlayer, season, modes[season])]) : null;
    const detail = (line: StatLine) =>
      Object.fromEntries(cats.map((c) => [c, formatCat(CATEGORIES[c], catValue(CATEGORIES[c], line))]));
    const label = season === 'last' ? `${data.meta.lastLabel} actual` : `${data.meta.curLabel} projection`;
    return (
      <div className="card radar-card" key={season}>
        <div className="card-head">
          <h2>{label}</h2>
          <span className="spacer" />
          <Segmented
            label={`${label} basis`}
            value={modes[season]}
            onChange={(m) => setModes((s) => ({ ...s, [season]: m }))}
            options={[
              { value: 'avg', label: 'Averages' },
              { value: 'tot', label: 'Totals' },
            ]}
          />
        </div>
        <RadarChart
          title={`${label}: team strength by category, 50 = average team`}
          axes={cats.map((c) => ({ key: c, label: c === 'TO' ? 'TO (low)' : c, muted: punts.includes(c) }))}
          series={[
            { key: 'mine', label: 'My team', values: mine, detail: detail(teamLine) },
            ...(withPreview && previewLine
              ? [{ key: 'other' as const, label: `+ ${previewPlayer!.name}`, values: withPreview, detail: detail(previewLine) }]
              : []),
          ]}
        />
        <div className="legend">
          <span><i className="swatch-line" />My team ({myIds.length})</span>
          {previewPlayer && <span><i className="swatch-line other" />With {previewPlayer.name}</span>}
          <span><i className="swatch-line avg" />Average team</span>
        </div>
        <p className="small muted" style={{ margin: '6px 0 0' }}>
          Percentile vs. a typical team of the same size drafted from the top {zr.draftableSize} players (player z-scores are vs. all {zr.leagueSize} NBA players).
          {season === 'last' ? ' Rookies have no stats here.' : ' Blends last season, the season before and current games, adjusted for age.'}
        </p>
      </div>
    );
  };

  return (
    <div className="stack">
      <div className={`draft-status${myTurn ? ' your-pick' : ''}`}>
        {done ? (
          <b>Draft complete — {picks.length} picks. Head to Matchup to project your week.</b>
        ) : league.trackAllTeams ? (
          <>
            <b>{myTurn ? 'Your pick!' : `On the clock: ${league.teamNames[onClock]}`}</b>
            <span className="secondary">Round {round}, pick {pickInRound} · #{picks.length + 1} overall</span>
          </>
        ) : (
          <b>Drafting your team only ({myIds.length}/{size})</b>
        )}
        <span className="spacer" />
        <button className="btn small" onClick={undoPick} disabled={!picks.length}>Undo pick</button>
        <button
          className="btn small ghost"
          disabled={!picks.length}
          onClick={() => confirm('Clear every pick and roster?') && resetDraft()}
        >
          Reset
        </button>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Categories</h3>
          <span className="small muted">Tap to punt (ignored in values and fit)</span>
        </div>
        <div className="chips">
          {cats.map((c) => (
            <button key={c} className={`chip${punts.includes(c) ? ' punt' : ''}`} aria-pressed={false} onClick={() => togglePunt(c)} title={CATEGORIES[c].label}>
              {c}
            </button>
          ))}
        </div>
      </div>

      <div className="grid draft">
        <div className="stack radar-col">
          <div className="only-narrow">
            <Segmented
              label="Chart"
              value={mobileRadar}
              onChange={setMobileRadar}
              options={[
                { value: 'last', label: `${data.meta.lastLabel} actual` },
                { value: 'proj', label: `${data.meta.curLabel} projection` },
              ]}
            />
          </div>
          <div className="radar-pair">
            <div className={mobileRadar === 'last' ? '' : 'narrow-hide'}>{radarPanel('last')}</div>
            <div className={mobileRadar === 'proj' ? '' : 'narrow-hide'}>{radarPanel('proj')}</div>
          </div>
          {previewPlayer && !ownerOf.has(previewPlayer.id) && !done && (
            <div className="card row">
              <span className="dot other" />
              <span>Previewing <b>{previewPlayer.name}</b></span>
              <span className="spacer" />
              <button className="btn small ghost" onClick={() => setPreview(null)}>Clear</button>
              <button className={`btn small ${myTurn ? 'mine' : 'primary'}`} onClick={() => doDraft(previewPlayer.id)}>
                {league.trackAllTeams && !myTurn ? `Pick for ${league.teamNames[onClock]}` : 'Draft'}
              </button>
            </div>
          )}
        </div>

        <div className="stack pool-col">
          <CategoryWeights
            cats={cats}
            punts={punts}
            weights={weights}
            onChange={(catWeights) => updateLeague({ catWeights })}
          />
          <div className="card">
              <div className="card-head">
                <h2>Player pool</h2>
                <span className="spacer" />
                <Segmented
                  label="Sort players by"
                  value={sortBy}
                  onChange={setSortBy}
                  options={[
                    { value: 'proj', label: 'Projection' },
                    { value: 'last', label: data.meta.lastLabel },
                    { value: 'fit', label: 'Best fit' },
                  ]}
                />
                <Segmented
                  label="Rank players on"
                  value={poolMode}
                  onChange={setPoolMode}
                  options={[
                    { value: 'avg', label: 'Averages' },
                    { value: 'tot', label: 'Totals' },
                  ]}
                />
                <Segmented
                  label="Show cells as"
                  value={cellMode}
                  onChange={setCellMode}
                  options={[
                    { value: 'z', label: 'Z-scores' },
                    { value: 'raw', label: 'Raw stats' },
                  ]}
                />
              </div>
              <div className="row wrap" style={{ marginBottom: 10 }}>
                <input type="search" placeholder="Search players" value={query} onChange={(e) => setQuery(e.target.value)} style={{ flex: '1 1 160px' }} />
                <select value={posF} onChange={(e) => setPosF(e.target.value as typeof posF)} aria-label="Position">
                  {POS_FILTERS.map((f) => <option key={f}>{f}</option>)}
                </select>
                <label className="check small"><input type="checkbox" checked={showTaken} onChange={(e) => setShowTaken(e.target.checked)} /> Show drafted</label>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th className="l">#</th>
                      <th className="l">Player</th>
                      <th title={`Sum of category z-scores of ${poolMode === 'avg' ? 'per-game averages' : 'season totals'} vs. the whole league, times the category multipliers`}>{sortBy === 'last' ? 'Last' : sortBy === 'fit' ? 'Fit' : 'Value'}</th>
                      {cats.map((c) => (
                        <th
                          key={c}
                          style={{ opacity: punts.includes(c) ? 0.4 : 1 }}
                          title={
                            cellMode === 'z' && CATEGORIES[c].kind === 'ratio' && c !== 'A/T'
                              ? `${CATEGORIES[c].label}, volume-weighted: makes above or below what a league-average shooter makes on the same attempts, so more attempts magnify good and bad shooting`
                              : CATEGORIES[c].label
                          }
                        >
                          {c}
                          {!punts.includes(c) && weightOf(c) !== 1 && <span className="mult">×{weightOf(c)}</span>}
                        </th>
                      ))}
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, limit).map((r, i) => {
                      const zr = sortBy === 'last' ? r.last : r.proj;
                      const owner = ownerOf.get(r.p.id);
                      return (
                        <tr
                          key={r.p.id}
                          className={`clickable${preview === r.p.id ? ' selected' : ''}${owner === league.myTeam ? ' mine' : ''}`}
                          onClick={() => setPreview((cur) => (cur === r.p.id ? null : r.p.id))}
                          onMouseEnter={() => window.matchMedia('(hover: hover)').matches && owner === undefined && setPreview(r.p.id)}
                        >
                          <td className="l muted">{i + 1}</td>
                          <td className="l" onClick={(e) => e.stopPropagation()}>
                            <PlayerName p={r.p} extra={owner !== undefined ? <span className="badge mine">{league.teamNames[owner]}</span> : null} />
                          </td>
                          <td className="num"><b>{r.value.toFixed(1)}</b></td>
                          {cats.map((c) => (
                            <td key={c} className="z num" style={{ ...zStyle(zr.z[c]), opacity: punts.includes(c) ? 0.4 : 1 }}>
                              {cellMode === 'z' ? zr.z[c].toFixed(1) : rawCell(c, zr.line, poolMode)}
                            </td>
                          ))}
                          <td>
                            {owner === undefined && !done && (
                              <button
                                className={`btn small ${myTurn ? 'mine' : 'primary'}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  doDraft(r.p.id);
                                }}
                              >
                                {league.trackAllTeams && !myTurn ? 'Pick' : 'Draft'}
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {rows.length > limit && (
                <div className="row" style={{ justifyContent: 'center', marginTop: 10 }}>
                  <button className="btn" onClick={() => setLimit((l) => l + 60)}>Show more ({rows.length - limit} left)</button>
                </div>
              )}
              <p className="small muted">
                {cellMode === 'z' ? (
                  <>
                    Cells are z-scores of {poolMode === 'avg' ? 'per-game averages' : `season totals (${sortBy === 'last' ? 'actual' : 'projected'}, so games played count)`} vs. every NBA player with minutes (blue = above league average, red = below). Shooting percentages are volume-weighted: a
                    good shooter on more attempts helps more, a poor one hurts more.
                  </>
                ) : (
                  <>
                    Cells are {sortBy === 'last' ? data.meta.lastLabel : 'projected'} {poolMode === 'avg' ? 'per-game averages' : 'season totals'}. Shading and Value still come from z-scores vs. every NBA player with minutes (blue = above league average, red = below),
                    with shooting volume-weighted, so a good percentage on few attempts shades lighter than on many.
                  </>
                )}{' '}
                Tap a row to preview the player on your chart.
                {league.trackAllTeams ? ' “Pick” assigns the player to the team on the clock.' : ''}
              </p>
          </div>
          <div className="grid two">
            <MyRoster ids={myIds} z={z.proj[poolMode]} cats={cats} weightOf={weightOf} />
            {picks.length > 0 && (
              <div className="card">
                <h3 style={{ marginBottom: 6 }}>Recent picks</h3>
                {picks.slice(-8).reverse().map((pk, i) => {
                  const p = ctx.byId.get(pk.pid);
                  return (
                    <div key={pk.pid} className="row small" style={{ padding: '3px 0' }}>
                      <span className="muted num" style={{ width: 32 }}>#{picks.length - i}</span>
                      <span style={{ fontWeight: pk.team === league.myTeam ? 700 : 500 }}>{p?.name}</span>
                      <span className="spacer" />
                      <span className="muted">{league.teamNames[pk.team]}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Per-category multipliers for the pool rankings, shown right above the pool. */
function CategoryWeights({
  cats,
  punts,
  weights,
  onChange,
}: {
  cats: CatId[];
  punts: CatId[];
  weights: Partial<Record<CatId, number>>;
  onChange: (w: Partial<Record<CatId, number>>) => void;
}) {
  const changed = cats.some((c) => !punts.includes(c) && (weights[c] ?? 1) !== 1);
  return (
    <div className="card">
      <div className="card-head" style={{ marginBottom: 8 }}>
        <h3>Category multipliers</h3>
        <span className="small muted">How much each category counts in the rankings below</span>
        <span className="spacer" />
        {changed && (
          <button className="btn small ghost" onClick={() => onChange({})}>
            Reset all to ×1
          </button>
        )}
      </div>
      <div className="weights">
        {cats.map((c) =>
          punts.includes(c) ? (
            <div key={c} className="weight punted" title="Punted: counts 0. Un-punt it in Categories above.">
              <span className="cat">{c}</span>
              <span className="small muted">punted</span>
            </div>
          ) : (
            <WeightInput key={c} cat={c} value={weights[c] ?? 1} onChange={(v) => onChange({ ...weights, [c]: v })} />
          ),
        )}
      </div>
    </div>
  );
}

function WeightInput({ cat, value, onChange }: { cat: CatId; value: number; onChange: (v: number) => void }) {
  // Raw text while editing, so intermediate input like "0." isn't overwritten.
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label className={`weight${value !== 1 ? ' changed' : ''}`} title={CATEGORIES[cat].label}>
      <span className="cat">{cat}</span>
      <span className="row" style={{ gap: 2 }}>
        <span className="muted">×</span>
        <input
          type="number"
          inputMode="decimal"
          min={0}
          max={5}
          step={0.25}
          aria-label={`${cat} multiplier`}
          value={draft ?? String(value)}
          onFocus={(e) => {
            setDraft(String(value));
            e.target.select(); // typing replaces the current multiplier
          }}
          onBlur={() => setDraft(null)}
          onChange={(e) => {
            setDraft(e.target.value);
            const v = Number(e.target.value);
            if (e.target.value.trim() !== '' && Number.isFinite(v) && v >= 0) onChange(Math.min(v, 5));
          }}
        />
      </span>
    </label>
  );
}

function MyRoster({ ids, z, cats, weightOf }: { ids: string[]; z: ZResult; cats: CatId[]; weightOf: (c: CatId) => number }) {
  const { ctx } = useApp();
  if (!ids.length) return null;
  return (
    <div className="card">
      <h3 style={{ marginBottom: 6 }}>My roster ({ids.length})</h3>
      {ids.map((id) => {
        const p = ctx.byId.get(id)!;
        return (
          <div key={id} className="row" style={{ padding: '4px 0', borderBottom: '1px solid var(--grid)' }}>
            <PlayerName p={p} />
            <span className="spacer" />
            <span className="num small secondary">{weightedValue(z.rows.get(id), cats, weightOf).toFixed(1)}</span>
          </div>
        );
      })}
    </div>
  );
}
