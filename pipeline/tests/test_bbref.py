"""Parser tests against trimmed copies of real basketball-reference pages (2025-26 / 2026-27),
so a markup change on their side shows up here before it silently breaks a data build."""
from pathlib import Path

import pytest

from pipeline.bbref import iso_date, parse_box_score, parse_game_log, parse_schedule, parse_team_advanced, parse_team_page, parse_totals

FIXTURES = Path(__file__).parent / "fixtures" / "bbref"


def fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def test_totals_including_traded_players():
    rows = parse_totals(fixture("totals.html"))
    luka = next(r for r in rows if r["id"] == "doncilu01")
    assert luka["team"] == "LAL" and luka["pos"] == "PG"
    assert (luka["g"], luka["pts"], luka["ast"], luka["tpm"]) == (64, 2143, 530, 254)
    traded = next(r for r in rows if len(r["teams"]) > 1)
    assert traded["team"] == traded["teams"][-1]


def test_game_log_starts_home_away_and_missed_games():
    log = parse_game_log(fixture("gamelog.html"), "jamesle01")
    assert log["missed"][0] == {"date": "2025-10-21", "team": "LAL", "reason": "Inactive"}
    g = next(x for x in log["games"] if x["date"] == "2025-11-18")
    assert (g["opp"], g["home"], g["gs"], g["ast"], g["pts"], g["fgm"], g["fga"]) == ("UTA", True, True, 12, 11, 4, 7)
    assert g["min"] == pytest.approx(29.617, abs=1e-3)


def test_roster_with_rookies_and_injuries():
    page = parse_team_page(fixture("team.html"), "CHI")
    assert len(page["roster"]) > 10
    miller = next(r for r in page["roster"] if r["id"] == "millele01")
    assert (miller["pos"], miller["heightIn"], miller["birthDate"], miller["rookie"]) == ("F", 82, "2003-11-26", False)
    assert any(r["rookie"] for r in page["roster"])
    assert "Out" in page["injuries"][0]["note"]


def test_advanced_team_table_hidden_in_a_comment():
    teams = parse_team_advanced(fixture("league.html"))
    assert (teams[0]["team"], teams[0]["pace"], teams[0]["net"]) == ("OKC", 99.3, 11.2)


def test_schedule_uses_standard_team_codes():
    games = parse_schedule(fixture("schedule.html"))
    assert games[0] == {"date": "2026-10-20", "home": "DET", "away": "BOS"}


def test_box_score_marks_five_starters_per_team():
    box = parse_box_score(fixture("boxscore-202510210LAL.html"), "202510210LAL")
    assert (box["date"], box["home"], box["away"]) == ("2025-10-21", "LAL", "GSW")
    for team in ("LAL", "GSW"):
        assert sum(1 for p in box["players"] if p["team"] == team and p["gs"]) == 5
    luka = next(p for p in box["players"] if p["pid"] == "doncilu01")
    assert (luka["pts"], luka["reb"], luka["ast"], luka["opp"], luka["home"]) == (43, 12, 9, "GSW", True)


def test_iso_dates():
    assert iso_date("Tue, Oct 20, 2026") == "2026-10-20"
    assert iso_date("November 26, 2003") == "2003-11-26"
