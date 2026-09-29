"""Season naming and team codes.

basketball-reference names a season by the year it ends: 2026 = the 2025-26 season.
From August on, the upcoming season is "current".
"""
from __future__ import annotations

import datetime as dt

SEASON_MONTHS = ["october", "november", "december", "january", "february", "march", "april"]

NBA_TEAMS = [
    "ATL", "BOS", "BKN", "CHA", "CHI", "CLE", "DAL", "DEN", "DET", "GSW",
    "HOU", "IND", "LAC", "LAL", "MEM", "MIA", "MIL", "MIN", "NOP", "NYK",
    "OKC", "ORL", "PHI", "PHX", "POR", "SAC", "SAS", "TOR", "UTA", "WAS",
]

# basketball-reference uses a few non-standard codes.
BBREF_TO_STD = {"BRK": "BKN", "CHO": "CHA", "PHO": "PHX"}
STD_TO_BBREF = {v: k for k, v in BBREF_TO_STD.items()}


def std_team(code: str) -> str:
    return BBREF_TO_STD.get(code, code)


def bbref_code(team: str) -> str:
    return STD_TO_BBREF.get(team, team)


def season_years(today: dt.date | None = None, cur: int | None = None) -> dict[str, int]:
    today = today or dt.date.today()
    cur = cur or (today.year + 1 if today.month >= 8 else today.year)
    return {"cur": cur, "last": cur - 1, "prev": cur - 2}


def season_label(year: int) -> str:
    return f"{year - 1}-{str(year)[2:]}"
