import pandas as pd

from pipeline.dataset import UNSIGNED_MIN_MINUTES, Dataset, unsigned_players


def make_dataset(totals_last: dict, roster_ids: list[str], rows: list[dict], totals_prev: dict) -> Dataset:
    roster = [{"id": pid} for pid in roster_ids]
    return Dataset(
        years={"cur": 2027, "last": 2026, "prev": 2025},
        totals={2025: totals_prev, 2026: totals_last, 2027: {}},
        roster=roster,
        roster_by={r["id"]: r for r in roster},
        injuries=[],
        schedule=[],
        team_names={},
        rows=pd.DataFrame(rows, columns=["pid", "date", "team"]),
    )


def test_unsigned_players_stay_under_their_last_team():
    def line(pid: str, team: str, pos: str, minutes: int, teams: list[str] | None = None) -> dict:
        return {"id": pid, "name": pid.title(), "team": team, "teams": teams or [team], "pos": pos, "min": minutes}

    totals = {
        "duren": line("duren", "DET", "C", 1976),
        "yabusele": line("yabusele", "CHI", "PF", 1007, ["NYK", "CHI"]),
        "signed": line("signed", "BOS", "SG", 2500),
        "bench": line("bench", "MIA", "SF", UNSIGNED_MIN_MINUTES - 1),
        "waived": line("waived", "LAL", "SG", 900),
    }
    rows = [  # sorted by date, as load_dataset leaves them
        {"pid": "waived", "date": "2026-04-01", "team": "LAL"},
        {"pid": "duren", "date": "2026-04-10", "team": "DET"},
        {"pid": "waived", "date": "2026-11-20", "team": "PHX"},  # this season, before he was waived
    ]
    found = {u["id"]: u for u in unsigned_players(make_dataset(totals, ["signed"], rows, {"yabusele": {"pos": "C"}}))}

    assert set(found) == {"duren", "yabusele", "waived"}  # not the signed player or the deep bench
    assert found["duren"] | {"name": None} == {
        "id": "duren", "name": None, "team": "DET", "pos": "C", "heightIn": 0, "birthDate": "", "rookie": False,
        "twoWay": False, "unsigned": True,
    }
    assert found["yabusele"]["team"] == "CHI"  # no game rows: the last team in his season totals
    assert found["yabusele"]["pos"] == "PF-C"  # last season's listing first, then the one before
    assert found["waived"]["team"] == "PHX"  # the team he last played a game for
