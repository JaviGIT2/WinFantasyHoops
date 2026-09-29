"""Download everything the app needs from basketball-reference.com into data-cache/.

    python -m pipeline.fetch                  # current season inferred from today's date
    python -m pipeline.fetch --cur 2027       # force the 2026-27 season
    python -m pipeline.fetch --history 1      # only one past season of game logs

Order matters: small league-wide pages first, then the long tail of per-player
game logs (most recent season first), so an interrupted run still leaves a usable
dataset. Parsed pages are cached, so re-running resumes where it stopped, and a
daily in-season refresh only downloads new box scores.
"""
from __future__ import annotations

import argparse
import calendar
import datetime as dt
import math
import sys

from . import bbref
from .http_cache import CACHE_DIR, Fetcher, RateLimited, cached_page, write_json
from .seasons import NBA_TEAMS, SEASON_MONTHS, bbref_code, season_label, season_years

OUT = CACHE_DIR / "normalized"


def log(msg: str) -> None:
    print(f"[{dt.datetime.now():%H:%M:%S}] {msg}", flush=True)


class Run:
    def __init__(self, fetcher: Fetcher):
        self.f = fetcher

    def totals(self, year: int, ttl: float) -> list[dict]:
        rows, _ = cached_page(self.f, f"/leagues/NBA_{year}_totals.html", bbref.parse_totals, ttl)
        rows = rows or []
        write_json(OUT / f"totals-{year}.json", rows)
        log(f"totals {season_label(year)}: {len(rows)} players")
        return rows

    def team_ratings(self, year: int, ttl: float) -> None:
        teams, _ = cached_page(self.f, f"/leagues/NBA_{year}.html", bbref.parse_team_advanced, ttl)
        write_json(OUT / f"teams-{year}.json", teams or [])
        log(f"team ratings {season_label(year)}: {len(teams or [])} teams")

    def rosters(self, year: int) -> list[dict]:
        roster, injuries = [], []
        for team in NBA_TEAMS:
            page, _ = cached_page(self.f, f"/teams/{bbref_code(team)}/{year}.html", lambda h, t=team: bbref.parse_team_page(h, t), 20)
            if page:
                roster += page["roster"]
                injuries += page["injuries"]
        write_json(OUT / f"rosters-{year}.json", roster)
        write_json(OUT / f"injuries-{year}.json", injuries)
        log(f"rosters {season_label(year)}: {len(roster)} players, {len(injuries)} injury notes")
        return roster

    def schedule(self, year: int) -> list[dict]:
        games = []
        today = dt.date.today()
        for i, month in enumerate(SEASON_MONTHS):
            # Months entirely in the past never change; the rest refresh twice a day.
            cal_year = year - 1 if i < 3 else year
            cal_month = (i + 9) % 12 + 1
            month_end = dt.date(cal_year, cal_month, calendar.monthrange(cal_year, cal_month)[1])
            ttl = math.inf if month_end < today else 12
            page, _ = cached_page(self.f, f"/leagues/NBA_{year}_games-{month}.html", bbref.parse_schedule, ttl)
            games += page or []
        write_json(OUT / f"schedule-{year}.json", games)
        log(f"schedule {season_label(year)}: {len(games)} games, {sum(1 for g in games if g.get('boxId'))} played")
        return games

    def box_scores(self, year: int, games: list[dict]) -> None:
        played = [g for g in games if g.get("boxId")]
        boxes, fetched = [], 0
        for g in played:
            box, from_cache = cached_page(self.f, f"/boxscores/{g['boxId']}.html", lambda h, b=g["boxId"]: bbref.parse_box_score(h, b))
            if not from_cache:
                fetched += 1
                if fetched % 25 == 0:
                    log(f"  box scores: {len(boxes)}/{len(played)}")
            if box:
                boxes.append(box)
        write_json(OUT / f"boxscores-{year}.json", boxes)
        log(f"box scores {season_label(year)}: {len(boxes)} games ({fetched} new)")

    def game_logs(self, year: int, players: list[dict]) -> None:
        games, missed = [], {}
        for i, p in enumerate(players, 1):
            pid = p["id"]
            page, from_cache = cached_page(self.f, f"/players/{pid[0]}/{pid}/gamelog/{year}", lambda h, x=pid: bbref.parse_game_log(h, x))
            if page:
                games += page["games"]
                missed[pid] = len(page["missed"])
            if not from_cache and i % 20 == 0:
                log(f"  game logs {season_label(year)}: {i}/{len(players)}")
        write_json(OUT / f"gamelogs-{year}.json", {"games": games, "missed": missed})
        log(f"game logs {season_label(year)}: {len(games)} player-games from {len(players)} players")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cur", type=int, help="season to treat as current (bbref year, e.g. 2027 = 2026-27)")
    ap.add_argument("--history", type=int, default=2, help="past seasons of per-player game logs (default 2)")
    ap.add_argument("--min-minutes", type=float, default=150, help="skip game logs for players below this many minutes")
    ap.add_argument("--interval", type=float, default=4.0, help="seconds between requests (default 4)")
    args = ap.parse_args(argv)
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # Windows consoles default to cp1252

    years = season_years(cur=args.cur)
    run = Run(Fetcher(args.interval))
    log(f"Seasons: current {season_label(years['cur'])}, last {season_label(years['last'])}, prev {season_label(years['prev'])}")
    try:
        last_totals = run.totals(years["last"], math.inf)
        prev_totals = run.totals(years["prev"], math.inf)
        cur_totals = run.totals(years["cur"], 12)
        run.team_ratings(years["last"], math.inf)
        run.team_ratings(years["cur"], 12)
        roster = run.rosters(years["cur"])
        run.box_scores(years["cur"], run.schedule(years["cur"]))

        # Per-player game logs for opponent history, defense vs. position and model training.
        rostered = {r["id"] for r in roster}

        def pick(rows: list[dict], only_rostered: bool) -> list[dict]:
            keep = [r for r in rows if r["min"] >= args.min_minutes and (not only_rostered or r["id"] in rostered)]
            return sorted(keep, key=lambda r: -r["min"])

        seasons = [years["last"], years["prev"]][: args.history]
        for year in seasons:
            # The most recent past season is fetched for everyone (complete defense-vs-position
            # samples); older seasons only for players still in the league.
            run.game_logs(year, pick(last_totals, False) if year == years["last"] else pick(prev_totals, True))
    except RateLimited as err:
        print(f"\n{err}", file=sys.stderr)
        return 2

    write_json(OUT / "fetch-meta.json", {
        "fetchedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        **years,
        "historySeasons": seasons,
        "curTotals": len(cur_totals),
    })
    log(f"Done. {run.f.requests} network requests this run.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
