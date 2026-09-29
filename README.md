# Win Fantasy Hoops

Expected-victory tools for Yahoo-style head-to-head **category** fantasy basketball
(9-cat, 8-cat, 7-cat, 5-cat, 11-cat or any custom set). It has two parts:

- **The app** (React + TypeScript) runs in the browser on desktop and phones and
  installs to a home screen as an app (PWA). All projections run on the device;
  there is no server.
- **The data pipeline** (Python: pandas, scikit-learn, LightGBM) downloads NBA data,
  trains the projection model, and writes the bundle the app loads.

| Tab | What it does |
|---|---|
| **Draft** | Snake-draft tracker with two spider charts of your team's category strength: last season's actual stats and this season's projection, each as per-game averages or season totals. The charts update with every pick, and tapping a player previews how he would change them. Also has per-category z-scores, punting, and a "best fit" sort. |
| **Matchup** | Pick a week and opponent. Every scheduled game is projected by the ML model, lineup limits are applied day by day, and it shows win probability per category and overall plus the expected category record. Tap a player to see the game-by-game matchup factors. |
| **League** | Every team's projected strength (expected categories won per week against the league, win %, category ranks). It also finds trade targets, 1-for-1 and 2-for-2 trades that help you without gutting the other team, and waiver pickups. The stat basis is switchable: current-season averages (falling back to last season until a player has 5 games), the blended projection, or last season. |
| **Stream** | Plans this week's add/drops within your remaining adds. It either chases chosen categories or maximizes your chance of beating this week's opponent, respects "next-day" add rules, and only counts games where an open lineup slot exists. |
| **Settings** | League format, roster slots, weekly add limit, team names, a planning date, and the model's accuracy report. |

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173
```

The repository ships with a built data bundle in `public/data/bundle.json`, so the
app works immediately. You only need Python to refresh the data.

## Data

Data comes from basketball-reference.com. (The NBA's own stats API blocks many
home and VPN connections; it refused this machine when the project was set up.)

Requires Python 3.10+ (3.13 is what this was built with). The first run creates a
virtual environment in `.venv` and installs `requirements.txt`; you can also do that
up front with `npm run setup:py`.

```bash
npm run data         # fetch + build
npm run data:fetch   # python -m pipeline.fetch: download into data-cache/ (cached, resumable)
npm run data:build   # python -m pipeline.build: train the model, write public/data/bundle.json
```

- **First run** downloads ~870 pages (season totals, 2026-27 rosters and injuries,
  the full schedule, and every rotation player's game logs for the last two seasons).
  Requests are spaced 4 s apart to stay under Sports Reference's 20-requests-per-minute
  limit, so it takes about an hour. Every page is cached, so an interrupted run resumes.
  If you ever see a rate-limit message, wait an hour and re-run.
- **During the season**, run `npm run data` daily (or whenever). It only downloads
  new box scores (~7 pages per day), refreshed rosters/injuries, and the schedule,
  then retrains. Completed games in the current week use the actual box score;
  remaining games use the model.
- Options: `npm run data:fetch -- --cur 2027 --history 2 --interval 4` (interval in seconds).
- The NBA publishes 1,200 of the 1,230 games up front; the last 30 (NBA Cup knockout
  rounds) appear in December and are picked up by the regular schedule refresh.

## How the projections work

**Season projection (draft).** Each player's per-minute production is a Bayesian blend:
positional average → two seasons ago → last season (adjusted for age) → current
season. Each step weighs the new sample by its minutes, so a 60-game season dominates
and a 3-game start barely moves it. Minutes and games played get the same treatment.
Totals equal games so far plus projected remaining games times the chance he plays.

**Per-game model (matchups, streaming).** One model per stat (`pipeline/`):

```
log E[stat] = log(usual minutes × player's per-minute rate)
            + f(defense vs. position, pace, history vs. this team, home, back-to-back,
                log(minutes ÷ usual minutes))
```

Two kinds of `f` compete on every build: a Poisson regression (scikit-learn) and
gradient-boosted trees (LightGBM, same offset). Each stat uses the trees only if they
beat the regression on held-out games by at least 0.2%. On the 2024-26 data the
regression wins every stat; the trees add variance without adding signal, because
these effects are close to log-linear. The app can evaluate either kind.

- *Defense vs. position* is opponent-adjusted. For example, it compares what point
  guards produced against the Bulls with what those same guards produce against
  everyone, so a team isn't penalized for facing good players.
- *History vs. this team* is the player's own over/under-performance against that
  opponent in past meetings beyond what the defense explains, shrunk toward zero.
- A separate regression predicts minutes (season average, recent games,
  back-to-backs, home).
- **Players with no NBA minutes** (rookies, new arrivals) use what each opponent
  allowed per game to players at their position and role last season, scaled to
  their expected minutes. For example, the Bulls allowed 6.5 assists per game to
  starting point guards in 2025-26 (third-most in the league). Set a rookie's minutes
  and role in his player sheet if you know them.
- The minutes term lets rare, threshold stats scale faster than linearly: the learned
  elasticity is ~1 for counting stats but ~2.6 for double-doubles.
- Training features are leave-one-out: a game never informs its own rate, its
  defense-vs-position number, or its opponent-history feature (tests in
  `pipeline/tests` check this). Before the shipped model is trained, both model
  kinds are scored on the last 25% of last season using only earlier games and
  compared with the naive "season average so far" forecast. The model beats it on
  16 of 17 stats (e.g. points −2.8%, rebounds −2.9%, minutes −6.9% RMSE); only
  triple-doubles, ~200 a season, don't improve. Full table: **Settings → Data & model**.

**Win probability.** Each category's weekly total is treated as normal, with variance
from the model's overdispersion and each player's chance of sitting. Percentages use
projected makes/attempts. Categories combine exactly (dynamic programming over
wins − losses), with ties counted as Yahoo does.

**Lineups.** Each day, players with games are assigned to your active slots
(PG, SG, G, SF, PF, F, C, UTIL…) by maximum-value matching. Players who don't fit sit
on the bench, and their games don't count.

**Streaming.** For each droppable roster spot, a dynamic program over (day, occupant,
adds used) finds the best pickup sequence. A knapsack then splits your remaining adds
across spots. In "beat my opponent" mode, each category is weighted by how much one
more unit raises your chance of winning it (∂P/∂μ), so swing categories drive the picks.

## Deploying

`npm run build` produces a static site in `dist/` that works from any path (relative
URLs, hash routing). Drop it on Netlify, Vercel, Cloudflare Pages, GitHub Pages or
any web server. Open the URL on a phone and choose **Add to Home Screen** to install
it; it works offline after the first visit.

League settings, draft and rosters are stored in the browser on each device
(localStorage). They don't sync between devices.

## Known limits

- **No Yahoo sync.** Enter your league settings and keep rosters current on the
  League tab after trades and waiver moves. The draft tracker records every team's
  picks for you. Yahoo's API needs OAuth with a registered developer app and a small
  server for the token exchange; that's the natural next step if you want automatic
  roster import.
- **Positions** come from basketball-reference (primary position plus adjacent ones
  from the roster listing), which is close to Yahoo's but not identical. Fix any player
  in his sheet.
- **Fantasy weeks** are Monday–Sunday, with week 1 starting on opening night. Yahoo
  sometimes merges weeks (e.g. around the All-Star break); pick the weeks you need.
- **Injuries** use basketball-reference's injury notes, which lag real news. Override
  a player's status or availability in his sheet.
- **Depth-chart changes** from offseason moves are only reflected once games are played.
  Adjust minutes by hand for players in new roles.

## Project layout

```
pipeline/           Python data pipeline
  fetch.py          download (cached, rate-limited) → data-cache/normalized
  bbref.py          basketball-reference page parsers
  dataset.py        player-game rows, positions
  features.py       leave-one-out matchup features
  models.py         Poisson GLM (scikit-learn), LightGBM, tree export
  build.py          holdout test, final training, app bundle
  tests/            pytest: parsers (trimmed real pages), leakage, models
src/engine/         app engine (TypeScript): projection, model, lineup, matchup, league, streaming, z-scores
src/views/          Draft, Matchup, League, Stream, Settings, PlayerSheet
public/data/        bundle.json (players, schedule, team defense tables, model)
tests/              engine tests (vitest), incl. LightGBM tree parity
scripts/py.mjs      runs the pipeline with .venv's Python from npm scripts
```

`npm test` runs both test suites (vitest and pytest); `npm run build` type-checks and builds.
