"""Load the fetched data (data-cache/normalized) into player-game rows."""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import pandas as pd

from .features import POSITIONS, STATS
from .http_cache import CACHE_DIR, read_json
from .seasons import NBA_TEAMS, season_years

IN = CACHE_DIR / "normalized"

# Positions adjacent on the floor; a player is also eligible at a neighbor his roster listing names.
ADJ = {"PG": ["SG"], "SG": ["PG", "SF"], "SF": ["SG", "PF"], "PF": ["SF", "C"], "C": ["PF"]}

# Unsigned players still matter to fantasy leagues (restricted free agents, veterans between deals). Anyone with this
# many minutes last season stays in the player pool, under his last team, until a roster lists him again.
UNSIGNED_MIN_MINUTES = 500


def load(name: str, default: Any) -> Any:
    return read_json(IN / name, default)


def to_pos(s: str | None) -> str | None:
    p = re.split(r"[-,]", s or "")[0].strip()
    return p if p in POSITIONS else None


def broad_positions(broad: str, height_in: int) -> list[str]:
    """Broad roster position (G, F, C, G-F …) → Yahoo positions, most likely first."""
    out: list[str] = []
    for part in (broad or "").split("-"):
        if part == "G":
            out += ["PG", "SG"] if height_in and height_in <= 75 else ["SG", "PG"]
        elif part == "F":
            out += ["PF", "SF"] if height_in >= 81 else ["SF", "PF"]
        elif part in POSITIONS:
            out.append(part)
    return list(dict.fromkeys(out))


@dataclass
class Dataset:
    years: dict[str, int]
    totals: dict[int, dict[str, dict]]
    roster: list[dict]
    roster_by: dict[str, dict]
    injuries: list[dict]
    schedule: list[dict]
    team_names: dict[str, str]
    rows: pd.DataFrame = field(default_factory=pd.DataFrame)

    def pos_for(self, pid: str, season: int) -> str:
        y = self.years
        for s in (season, y["last"], y["prev"]):
            p = to_pos(self.totals.get(s, {}).get(pid, {}).get("pos"))
            if p:
                return p
        r = self.roster_by.get(pid, {})
        return (broad_positions(r.get("pos", "F"), r.get("heightIn", 0)) or ["SF"])[0]


def unsigned_players(ds: Dataset) -> list[dict]:
    """Roster-style entries for players with real minutes last season who are on no current roster.

    The team is the one he last played a game for (so a player waived mid-season keeps the team that waived him),
    and the positions are his recent season listings.
    """
    last_team = ds.rows.groupby("pid")["team"].last().to_dict() if not ds.rows.empty else {}
    out = []
    for pid, t in ds.totals.get(ds.years["last"], {}).items():
        if pid in ds.roster_by or (t.get("min") or 0) < UNSIGNED_MIN_MINUTES:
            continue
        team = last_team.get(pid) or (t.get("teams") or [t.get("team")])[-1]
        if team not in NBA_TEAMS:
            continue
        listed = (to_pos(ds.totals.get(s, {}).get(pid, {}).get("pos")) for s in (ds.years["last"], ds.years["prev"]))
        out.append({
            "id": pid, "name": t["name"], "team": team, "pos": "-".join(dict.fromkeys(p for p in listed if p)),
            "heightIn": 0, "birthDate": "", "rookie": False, "twoWay": False, "unsigned": True,
        })
    return out


def load_dataset() -> Dataset:
    meta = load("fetch-meta.json", None)
    years = {k: meta[k] for k in ("cur", "last", "prev")} if meta else season_years()
    totals = {y: {t["id"]: t for t in load(f"totals-{y}.json", [])} for y in (years["prev"], years["last"], years["cur"])}
    roster = list({r["id"]: r for r in load(f"rosters-{years['cur']}.json", [])}.values())
    names: dict[str, str] = {}
    for y in (years["last"], years["cur"]):
        for t in load(f"teams-{y}.json", []):
            names[t["team"]] = t["name"]
    ds = Dataset(
        years=years,
        totals=totals,
        roster=roster,
        roster_by={r["id"]: r for r in roster},
        injuries=load(f"injuries-{years['cur']}.json", []),
        schedule=load(f"schedule-{years['cur']}.json", []),
        team_names=names,
    )

    games: list[dict] = []
    for season in (years["prev"], years["last"]):
        for g in load(f"gamelogs-{season}.json", {"games": []})["games"]:
            games.append({**g, "season": season})
    for box in load(f"boxscores-{years['cur']}.json", []):
        for g in box["players"]:
            games.append({**g, "season": years["cur"]})
    rows = pd.DataFrame(games)
    if rows.empty:
        ds.rows = rows
        return ds
    rows = rows[(rows["opp"] != "") & (rows["team"] != "") & (rows["min"] > 0)].copy()
    tens = sum((rows[s] >= 10).astype(int) for s in ("pts", "reb", "ast", "stl", "blk"))
    rows["dd"] = (tens >= 2).astype(float)
    rows["td"] = (tens >= 3).astype(float)
    pos_cache = {(p, s): ds.pos_for(p, s) for p, s in set(zip(rows["pid"], rows["season"]))}
    rows["pos"] = [pos_cache[(p, s)] for p, s in zip(rows["pid"], rows["season"])]
    rows["home"] = rows["home"].astype(bool)
    rows["gs"] = rows["gs"].astype(bool)
    rows[STATS] = rows[STATS].astype(float)
    ds.rows = rows.sort_values("date", kind="stable").reset_index(drop=True)[
        ["pid", "season", "date", "team", "opp", "home", "gs", "min", "pos", *STATS]
    ]
    ds.rows["season"] = ds.rows["season"].astype(np.int64)
    return ds
