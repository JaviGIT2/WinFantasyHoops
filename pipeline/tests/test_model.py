import numpy as np
import pandas as pd
import pytest

from pipeline.features import STATS, build_aggs, featurize
from pipeline.models import eval_trees, export_trees, fit_gbm, fit_glm


def synthetic_rows(seed: int = 3, n_players: int = 24, games: int = 40) -> pd.DataFrame:
    """Two seasons of games among six teams, players with different scoring rates."""
    rng = np.random.default_rng(seed)
    teams = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF"]
    positions = ["PG", "SG", "SF", "PF", "C"]
    rows = []
    for season in (2025, 2026):
        start = pd.Timestamp(f"{season - 1}-10-20")
        for p in range(n_players):
            team = teams[p % 6]
            rate = 0.3 + 0.4 * (p / n_players)
            for g in range(games):
                opp = teams[(p + g + 1) % 6] if teams[(p + g + 1) % 6] != team else teams[(p + g + 2) % 6]
                minutes = float(np.clip(rng.normal(28, 5), 5, 42))
                line = {s: float(rng.poisson(rate * minutes * (0.3 if s in ("dd", "td") else 0.2))) for s in STATS}
                line["dd"], line["td"] = float(line["pts"] > 10), 0.0
                rows.append({
                    "pid": f"p{p}", "season": season, "date": (start + pd.Timedelta(days=2 * g)).strftime("%Y-%m-%d"),
                    "team": team, "opp": opp, "home": g % 2 == 0, "gs": p % 2 == 0, "min": minutes, "pos": positions[p % 5], **line,
                })
    df = pd.DataFrame(rows).sort_values("date", kind="stable").reset_index(drop=True)
    df["season"] = df["season"].astype(np.int64)
    return df


def team_dates(df: pd.DataFrame) -> set:
    return set(zip(df["team"], df["date"]))


def test_leave_one_out_features_ignore_the_target_game():
    rows = synthetic_rows()
    base = featurize(build_aggs(rows), rows, True, team_dates(rows))
    i = 500
    bumped = rows.copy()
    bumped.loc[i, "pts"] += 25  # a monster game…
    feats = featurize(build_aggs(bumped), bumped, True, team_dates(bumped))
    k = STATS.index("pts")
    j = next(x for x in range(len(rows)) if x != i and rows.loc[x, "pid"] == rows.loc[i, "pid"] and rows.loc[x, "opp"] == rows.loc[i, "opp"])
    # It informs his other games against the same opponent…
    informs = feats.h2h[j, k] - base.h2h[j, k]
    assert informs > 0.1
    # …but not its own features: the rate is exact, and dvp/h2h move only through shared priors
    # (every player's rate shrinks toward a positional average that includes this game), which is
    # visible in this 24-player league and negligible in a real one.
    assert feats.rate[i, k] == pytest.approx(base.rate[i, k], rel=1e-12)
    assert abs(feats.dvp[i, k] - base.dvp[i, k]) < 0.05 * informs
    assert abs(feats.h2h[i, k] - base.h2h[i, k]) < 0.05 * informs


def test_frozen_features_use_only_history():
    rows = synthetic_rows()
    cutoff = rows["date"].iloc[int(len(rows) * 0.8)]
    hist, test = rows[rows["date"] < cutoff], rows[rows["date"] >= cutoff]
    feats = featurize(build_aggs(hist), test, False, team_dates(rows))
    assert np.isfinite(feats.rate).all() and (feats.rate > 0).all()
    assert np.isfinite(feats.dvp).all() and np.isfinite(feats.h2h).all()


def test_glm_recovers_coefficients_with_offset():
    rng = np.random.default_rng(11)
    n = 30000
    X = np.column_stack([rng.normal(0, 0.3, n), rng.integers(0, 2, n)])
    offset = np.log(2 + 3 * rng.random(n))
    truth = np.array([0.1, 0.8, -0.3])
    y = rng.poisson(np.exp(offset + truth[0] + X @ truth[1:]))
    glm = fit_glm(X, y, offset, l2=0.0)
    assert glm.coef == pytest.approx(truth, abs=0.03)


def test_exported_trees_match_lightgbm():
    rng = np.random.default_rng(5)
    n = 6000
    X = np.column_stack([rng.normal(0, 0.2, n), rng.normal(0, 0.1, n), rng.normal(0, 0.1, n), rng.integers(0, 2, n), rng.integers(0, 2, n), rng.normal(0, 0.3, n)])
    offset = np.log(5 + rng.random(n))
    y = rng.poisson(np.exp(offset + 0.7 * X[:, 0] + 1.5 * np.maximum(X[:, 5], 0)))
    gbm = fit_gbm(X, y, offset, rounds=60)
    raw = gbm.booster.predict(X[:200], raw_score=True)
    assert eval_trees(export_trees(gbm), X[:200]) == pytest.approx(raw, abs=1e-9)
