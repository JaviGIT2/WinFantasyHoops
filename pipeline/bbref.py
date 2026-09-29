"""Parsers for basketball-reference.com pages.

Every parser takes raw HTML and returns small JSON-ready records (the same shapes
the page cache and ``data-cache/normalized`` files use). bbref tags each cell with
``data-stat="<field>"``, which is far more stable than column order, so parsing is
keyed on that attribute. Some tables ship inside HTML comments and are revealed
client-side; comment markers are stripped before parsing so both kinds work.
"""
from __future__ import annotations

import re
from typing import Any

from lxml import html as lh

from .seasons import std_team

Row = dict[str, str]

MONTHS = {
    "Jan": "01", "Feb": "02", "Mar": "03", "Apr": "04", "May": "05", "Jun": "06",
    "Jul": "07", "Aug": "08", "Sep": "09", "Oct": "10", "Nov": "11", "Dec": "12",
    "January": "01", "February": "02", "March": "03", "April": "04", "June": "06", "July": "07",
    "August": "08", "September": "09", "October": "10", "November": "11", "December": "12",
}

STATS = {  # our key -> bbref data-stat
    "fgm": "fg", "fga": "fga", "tpm": "fg3", "tpa": "fg3a", "ftm": "ft", "fta": "fta",
    "oreb": "orb", "dreb": "drb", "reb": "trb", "ast": "ast", "stl": "stl", "blk": "blk", "to": "tov", "pts": "pts",
}


def parse_doc(html: str):
    return lh.fromstring(html.replace("<!--", "").replace("-->", ""))


def table(doc, table_id: str) -> list[Row]:
    """Body rows of table ``table_id`` as {data-stat: text} (plus ``<stat>@href`` and ``<stat>@id``)."""
    found = doc.xpath("//table[@id=$id]", id=table_id)
    if not found:
        return []
    rows: list[Row] = []
    for tr in found[0].xpath("./tbody/tr"):
        row: Row = {"__class": tr.get("class", "")}
        for cell in tr.xpath("./th|./td"):
            stat = cell.get("data-stat")
            if not stat:
                continue
            row[stat] = cell.text_content().strip()
            link = cell.xpath(".//a[@href]")
            if link:
                row[f"{stat}@href"] = link[0].get("href")
            csv = cell.get("data-append-csv")
            if csv:
                row[f"{stat}@id"] = csv
        rows.append(row)
    return rows


def num(s: str | None) -> int | float:
    if not s:
        return 0
    try:
        v = float(s)
    except ValueError:
        return 0
    return int(v) if v.is_integer() else v


def minutes(mp: str | None) -> float:
    if not mp:
        return 0.0
    m, _, s = mp.partition(":")
    return float(num(m)) + float(num(s)) / 60


def team_from_href(href: str | None) -> str:
    m = re.search(r"/teams/([A-Z]{3})/", href or "")
    return std_team(m.group(1)) if m else ""


def player_id_from_href(href: str | None) -> str:
    m = re.search(r"/players/\w/([a-z0-9]+)\.html", href or "")
    return m.group(1) if m else ""


def iso_date(text: str) -> str:
    """'Tue, Oct 20, 2026' or 'November 26, 2003' → '2026-10-20'."""
    m = re.search(r"([A-Za-z]+) (\d{1,2}), (\d{4})", text or "")
    if not m or m.group(1) not in MONTHS:
        return ""
    return f"{m.group(3)}-{MONTHS[m.group(1)]}-{int(m.group(2)):02d}"


def stat_line(r: Row) -> dict[str, float]:
    line: dict[str, float] = {"min": minutes(r.get("mp"))}
    for key, stat in STATS.items():
        line[key] = num(r.get(stat))
    return line


# ---------------------------------------------------------------- season totals

def parse_totals(html: str) -> list[dict[str, Any]]:
    """leagues/NBA_<year>_totals.html. Traded players get one aggregate row, then one row per team."""
    out: dict[str, dict[str, Any]] = {}
    for r in table(parse_doc(html), "totals_stats"):
        pid = r.get("name_display@id") or player_id_from_href(r.get("name_display@href"))
        if not pid or "thead" in r["__class"]:
            continue
        abbr = r.get("team_name_abbr", "")
        aggregate = bool(re.fullmatch(r"\dTM", abbr))
        if pid in out:
            if not aggregate:  # per-team stint rows follow the aggregate; the last one is the final team
                out[pid]["team"] = std_team(abbr)
                out[pid]["teams"].append(std_team(abbr))
            continue
        out[pid] = {
            "id": pid,
            "name": r.get("name_display", ""),
            "age": num(r.get("age")),
            "team": "" if aggregate else std_team(abbr),
            "teams": [] if aggregate else [std_team(abbr)],
            "pos": r.get("pos", ""),
            "g": num(r.get("games")),
            "gs": num(r.get("games_started")),
            "min": num(r.get("mp")),
            **{key: num(r.get(stat)) for key, stat in STATS.items()},
            "td": num(r.get("tpl_dbl")),
        }
    return list(out.values())


# ---------------------------------------------------------------- game logs

def parse_game_log(html: str, pid: str) -> dict[str, list]:
    """players/<x>/<id>/gamelog/<year>: regular-season games played plus games missed."""
    games, missed = [], []
    for r in table(parse_doc(html), "player_game_log_reg"):
        if not r.get("date") or "thead" in r["__class"]:
            continue
        team, opp, flag = std_team(r.get("team_name_abbr", "")), std_team(r.get("opp_name_abbr", "")), r.get("is_starter", "")
        if not r.get("mp"):
            missed.append({"date": r["date"], "team": team, "reason": flag or "DNP"})
            continue
        games.append({
            "pid": pid, "date": r["date"], "team": team, "opp": opp,
            "home": r.get("game_location", "").strip() != "@", "gs": flag == "*", **stat_line(r),
        })
    return {"games": games, "missed": missed}


# ---------------------------------------------------------------- box scores

def parse_box_score(html: str, box_id: str) -> dict[str, Any] | None:
    """boxscores/<YYYYMMDD0HOM>.html → both teams' lines; starters are the rows above "Reserves"."""
    date = f"{box_id[0:4]}-{box_id[4:6]}-{box_id[6:8]}"
    home = std_team(box_id[9:12])
    codes = list(dict.fromkeys(re.findall(r'id="box-([A-Z]{3})-game-basic"', html)))
    if len(codes) != 2:
        return None
    away = next(std_team(c) for c in codes if std_team(c) != home)
    doc = parse_doc(html)
    players = []
    for code in codes:
        team = std_team(code)
        opp = away if team == home else home
        starter = True
        for r in table(doc, f"box-{code}-game-basic"):
            if "thead" in r["__class"]:
                starter = False  # "Reserves" divider row
                continue
            pid = r.get("player@id") or player_id_from_href(r.get("player@href"))
            if not pid or not re.fullmatch(r"\d+:\d+", r.get("mp", "")):
                continue  # DNP / inactive rows
            players.append({"pid": pid, "date": date, "team": team, "opp": opp, "home": team == home, "gs": starter, **stat_line(r)})
    return {"id": box_id, "date": date, "home": home, "away": away, "players": players}


# ---------------------------------------------------------------- rosters and injuries

def parse_team_page(html: str, team: str) -> dict[str, list]:
    """teams/<TEAM>/<year>.html: current roster and injury report."""
    doc = parse_doc(html)
    roster = []
    for r in table(doc, "roster"):
        pid = player_id_from_href(r.get("player@href"))
        if not pid:
            continue
        ft, _, inch = r.get("height", "").partition("-")
        name = r.get("player", "")
        roster.append({
            "id": pid,
            "name": re.sub(r"\s*\(TW\)\s*$", "", name),
            "team": team,
            "pos": r.get("pos", ""),
            "heightIn": int(num(ft)) * 12 + int(num(inch)) if ft else 0,
            "birthDate": iso_date(r.get("birth_date", "")),
            "rookie": r.get("years_experience", "").strip() == "R",
            "twoWay": "(TW)" in name,
        })
    injuries = []
    for r in table(doc, "injuries"):
        pid = r.get("player@id") or player_id_from_href(r.get("player@href"))
        if pid:
            injuries.append({"id": pid, "team": team, "date": iso_date(r.get("date_update", "")), "note": r.get("note", "")})
    return {"roster": roster, "injuries": injuries}


# ---------------------------------------------------------------- team ratings

def parse_team_advanced(html: str) -> list[dict[str, Any]]:
    """leagues/NBA_<year>.html: pace and ratings from the (commented) advanced team table."""
    out = []
    for r in table(parse_doc(html), "advanced-team"):
        team, pace = team_from_href(r.get("team@href")), num(r.get("pace"))
        if not team or pace <= 0:
            continue
        out.append({
            "team": team, "name": r.get("team", "").rstrip("*"), "wins": num(r.get("wins")), "losses": num(r.get("losses")),
            "pace": pace, "ortg": num(r.get("off_rtg")), "drtg": num(r.get("def_rtg")), "net": num(r.get("net_rtg")),
        })
    return out


# ---------------------------------------------------------------- schedule

def parse_schedule(html: str) -> list[dict[str, Any]]:
    """leagues/NBA_<year>_games-<month>.html"""
    out = []
    for r in table(parse_doc(html), "schedule"):
        game = {"date": iso_date(r.get("date_game", "")), "home": team_from_href(r.get("home_team_name@href")), "away": team_from_href(r.get("visitor_team_name@href"))}
        if not (game["date"] and game["home"] and game["away"]):
            continue
        if r.get("home_pts"):
            game["homePts"] = num(r["home_pts"])
        if r.get("visitor_pts"):
            game["awayPts"] = num(r["visitor_pts"])
        box = re.search(r"/boxscores/(\w+)\.html", r.get("box_score_text@href", ""))
        if box:
            game["boxId"] = box.group(1)
        out.append(game)
    return out
