# Win Fantasy Hoops

Expected-victory tools for Yahoo-style head-to-head **category** fantasy basketball
(9-cat, 8-cat, 7-cat, 5-cat, 11-cat or any custom set). It has two parts:

- **The app** (React + TypeScript) runs in the browser on desktop and phones and
  installs to a home screen as an app (PWA). All projections run on the device.
  Keep as many leagues as you like, each with its own settings, draft, rosters and
  streaming plan; switch between them from the top bar.
- **Accounts** (optional, [Supabase](https://supabase.com)): sign in with email and
  password and your leagues follow you between phone and desktop. Without it the app
  needs no server and saves leagues on each device.
- **The data pipeline** (Python: pandas, scikit-learn, LightGBM) downloads NBA data,
  trains the projection model, and writes the bundle the app loads.

| Tab | What it does |
|---|---|
| **Draft** | Snake-draft tracker with two spider charts of your team's category strength: last season's actual stats and this season's projection, each as per-game averages or season totals. The charts update with every pick, and tapping a player previews how he would change them. Also has per-category z-scores, punting, and a "best fit" sort. |
| **Matchup** | Pick a week and opponent. Every scheduled game is projected by the ML model, lineup limits are applied day by day, and it shows win probability per category and overall plus the expected category record. Tap a player to see the game-by-game matchup factors. |
| **League** | Every team's projected strength (expected categories won per week against the league, win %, category ranks). It also finds trade targets, 1-for-1 and 2-for-2 trades that help you without gutting the other team, and waiver pickups, ranked by categories you choose to target or give up. You can also get the best offers for one player you want, or shop up to three of your own around the league. The stat basis is switchable: current-season averages (falling back to last season until a player has 5 games), the blended projection, or last season. Its roster editor keeps every team current the way Yahoo does: a free agent joining a full roster means picking someone to drop (IL spots open up for injured players), and a player on another team comes over in a 1-for-1 trade. |
| **Trade** | Trade Analyzer. Pick two teams and add players on both sides (even or uneven). It shows each player's per-game stats (2025-26 averages, the projection, or 2026-27 so far; with the projection you can type in what-if numbers). It judges the trade by value over replacement: each team's trade value is Σ (player value − replacement value) over the players it gets, minus those it sends and drops, so the side getting more players isn't favored for that alone. For each team it also shows how the trade changes its expected categories won, matchup win %, league rank, roster size and every category, with open roster spots filled by replacement-level free agents. A team pushed over its roster limit picks who to drop, and **Process trade** updates both rosters. |
| **Stream** | Plans this week's add/drops within your remaining adds. It either chases chosen categories or maximizes your chance of beating this week's opponent, respects "next-day" add rules, and only counts games where an open lineup slot exists. |
| **Settings** | Your leagues (add, open, delete), then the open league's format, roster slots, weekly add limit and team names, a planning date, the model's accuracy report, and your account. |

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173
```

The repository ships with a built data bundle in `public/data/bundle.json`, so the
app works immediately. You only need Python to refresh the data.

## Accounts

Without setup the app has no sign-in and keeps leagues in the browser on each
device. To add accounts, connect a Supabase project (the free tier is plenty):

1. Create a project at [supabase.com](https://supabase.com).
2. Open **SQL Editor**, paste [`supabase/schema.sql`](supabase/schema.sql) and run it. It
   creates the `leagues` and `user_prefs` tables with row-level security, so each
   account can only read and change its own rows.
3. Under **Authentication → URL Configuration**, set **Site URL** to where the app is
   hosted and add `http://localhost:5173` (plus the hosted URL) to **Redirect URLs**.
   Email links (confirm address, reset password) return there.
4. Copy `.env.example` to `.env.local` and fill in the project URL and publishable key
   from **Project Settings → API** (the legacy anon key also works). Restart
   `npm run dev`.

How it behaves:

- **Existing data.** The first time you sign in on a device that already has leagues
  saved from before accounts, they're added to your account.
- **What's shared.** Each league syncs as a whole: settings, draft, rosters, weekly
  opponents and streaming plan. Player adjustments (minutes, injury status,
  positions) and the planning date belong to the account and apply to every league.
- **Offline.** The app keeps working and saves edits on the device; they sync when
  the connection returns (the top bar says **Offline** meanwhile). If two devices
  edit the same league while apart, the later edit wins; player adjustments from
  both are kept.
- **Signing out** removes the account's leagues from that device; they stay in the
  account.
- **Email.** Supabase asks new accounts to confirm their email address, and its
  built-in mailer only sends a few emails per hour. That's fine for you and a few
  friends; for more, add your own SMTP server (**Authentication → Emails**) or turn
  off **Confirm email** (**Authentication → Sign In / Providers → Email**).

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

**Trade value.** A player's value is his z-score total across the league's categories
(against every player with minutes) for his expected production per game on the chosen
basis, discounted for missed games. That's the same production the team impact credits
him with. The replacement value is the average value of the players ranked just past
the league's roster spots (ranks 131–140 in a 10-team league with 13 spots): the best
players nobody has room for. A team's trade value is Σ (value − replacement value)
over the players it gets, minus the same over the players it sends and drops. In a
2-for-1, the team sending two gets a free agent's worth for its open spot, and the
team getting two gives up a replacement-level player until it picks who to drop. The
team impact counts rosters the same way: each open spot holds a replacement-level free
agent (the tier's average production). A player out injured counts ±0, since he waits
on IL while a free agent takes his spot. What-if projection edits change the edited
players' values, never the replacement level.

## Deploying

`npm run build` produces a static site in `dist/` that works from any path (relative
URLs, hash routing). Drop it on Netlify, Vercel, Cloudflare Pages, GitHub Pages or
any web server. Open the URL on a phone and choose **Add to Home Screen** to install
it; it works offline after the first visit.

For accounts, set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in the
build environment (e.g. your host's environment variables); they're compiled into
the site. Both are meant to be public: row-level security, not the key, keeps each
account's data private. Add the site's URL to Supabase's redirect URLs (step 3
above). Without them, the build runs without accounts and each device keeps its own
leagues in the browser (localStorage).

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
- **Unsigned players** (on no current roster) who played 500+ minutes last season stay in the player
  pool under the team they last played for, marked Unsigned, so they can still be drafted or added.
  Run `npm run data` after they sign to move them to their new team. The Stream tab leaves them out,
  since they can't play this week's games.
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
src/engine/         app engine (TypeScript): projection, model, lineup, matchup, league, trade value, streaming, z-scores
src/state/          leagues (format, migration, merging the account's copy) and the app store
src/cloud/          Supabase client, sign-in, sync
src/views/          Draft, Matchup, League, Trade, Stream, Settings, PlayerSheet, sign-in
supabase/schema.sql tables and row-level security for accounts
public/data/        bundle.json (players, schedule, team defense tables, model)
tests/              engine tests (vitest), incl. LightGBM tree parity; league store and sync merge
scripts/py.mjs      runs the pipeline with .venv's Python from npm scripts
```

`npm test` runs both test suites (vitest and pytest); `npm run build` type-checks and builds.
