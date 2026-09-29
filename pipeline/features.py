"""Player-game rows and the model's matchup features.

Every feature is computed from a *history* of games. In leave-one-out mode the
target games are part of that history and each game's own contribution is removed,
so a game never informs its own features. In frozen mode (holdout evaluation) the
history ends before the target games, like a forecast made on the cutoff date.

Features for player p in a game against opponent o (per stat s):

  rate  p's per-minute rate this season, shrunk toward last season (or his position)
  dvp   log(actual / expected) production of players at p's position against o,
        where "expected" uses those same players' own rates (opponent-adjusted)
  h2h   log(actual / expected) for p himself against o across all seasons, beyond
        what dvp explains, shrunk toward 0
  pace  log of expected game pace relative to p's own team
  home, b2b, and minRatio = log(minutes / usual minutes)
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

STATS = ["fgm", "fga", "tpm", "tpa", "ftm", "fta", "oreb", "dreb", "reb", "ast", "stl", "blk", "to", "pts", "dd", "td"]
S = len(STATS)
POSITIONS = ["PG", "SG", "SF", "PF", "C"]
K_RATE = 250.0  # minutes of prior when blending a season rate toward its prior
C_DVP = 30.0  # player-games of prior for defense vs. position
C_H2H = 4.0  # games of prior for player-vs-opponent history
PRIOR_FLOOR = 2.0  # minimum prior in events, so rare stats aren't swung by one game

FEATURES = ["dvp", "pace", "h2h", "home", "b2b", "minRatio"]


def lookup(frame: pd.DataFrame | pd.Series, keys: list) -> np.ndarray:
    """Rows of ``frame`` (unique MultiIndex) aligned to the given key arrays; NaN where missing."""
    idx = pd.MultiIndex.from_arrays([np.asarray(k) for k in keys]) if len(keys) > 1 else pd.Index(np.asarray(keys[0]))
    return frame.reindex(idx).to_numpy(dtype=float)


def fill(a: np.ndarray, *fallbacks: np.ndarray) -> np.ndarray:
    """Fill NaN rows of ``a`` from each fallback in turn, then with 0."""
    out = a.copy()
    for f in fallbacks:
        mask = np.isnan(out)
        out[mask] = f[mask]
    return np.nan_to_num(out, nan=0.0)


def role(gs) -> np.ndarray:
    return np.where(np.asarray(gs, dtype=bool), "S", "B")


# ---------------------------------------------------------------------------- aggregates

@dataclass
class Aggs:
    player: pd.DataFrame  # (pid, season) → A_* sums, M minutes, G games, starter share, pos
    pos_rate: pd.DataFrame  # (season, pos, role) → per-minute rates
    pos_A: pd.DataFrame  # (season, pos, role) → stat sums (for leave-one-out positional priors)
    pos_M: pd.Series  # (season, pos, role) → minutes
    pos_min: pd.Series  # (season, pos, role) → minutes per game
    rate: pd.DataFrame  # (pid, season) → full-season shrunk rate
    dvp: pd.DataFrame  # (season, opp, pos) → A_* and E_* sums
    dvp_prior: pd.DataFrame  # (season, pos) → prior strength per stat
    h2h: pd.DataFrame  # (pid, opp) → A_* sums, n games, T_* = Σ seasons W ⊙ rate
    h2h_season: pd.DataFrame  # (pid, opp, season) → minutes M, W_* (min × dvp multiplier) and T_* (W ⊙ rate)
    pace: pd.Series  # (season, team) → possessions per 48
    mins: pd.DataFrame  # history minutes (pid, season, date, min), date-ordered


A_COLS = [f"A_{s}" for s in STATS]
E_COLS = [f"E_{s}" for s in STATS]
W_COLS = [f"W_{s}" for s in STATS]
T_COLS = [f"T_{s}" for s in STATS]


def dvp_log(A: np.ndarray, E: np.ndarray, prior: np.ndarray) -> np.ndarray:
    with np.errstate(divide="ignore", invalid="ignore"):
        v = np.log((A + prior) / (E + prior))
    return np.where(np.isfinite(v), v, 0.0)


def build_aggs(hist: pd.DataFrame) -> Aggs:
    Y = hist[STATS].to_numpy(float)
    h = hist[["pid", "season", "opp", "team", "date", "pos", "min"]].copy()
    h["role"] = role(hist["gs"])
    h["gs"] = hist["gs"].astype(float)
    for i, s in enumerate(STATS):
        h[f"A_{s}"] = Y[:, i]

    g = h.groupby(["pid", "season"], sort=False)
    player = g[A_COLS].sum()
    player["M"] = g["min"].sum()
    player["G"] = g.size()
    player["starter"] = g["gs"].mean()
    player["pos"] = g["pos"].last()

    gp = h.groupby(["season", "pos", "role"])
    pos_A = gp[A_COLS].sum()
    pos_M = gp["min"].sum()
    pos_rate = pos_A.div(pos_M.clip(lower=1), axis=0)
    pos_rate.columns = STATS
    pos_min = pos_M / gp.size().clip(lower=1)

    # Full-season rates, shrunk toward the previous season's rate or the positional rate.
    by_season: dict[int, pd.DataFrame] = {}
    for season in sorted(player.index.get_level_values("season").unique()):
        sub = player.xs(season, level="season")
        pids = sub.index.to_numpy()
        prev = lookup(by_season[season - 1], [pids]) if season - 1 in by_season else np.full((len(pids), S), np.nan)
        pos_prior = lookup(pos_rate, [np.full(len(pids), season), sub["pos"].to_numpy(), np.where(sub["starter"] >= 0.5, "S", "B")])
        prior = fill(prev, pos_prior)
        r = (sub[A_COLS].to_numpy() + K_RATE * prior) / (sub["M"].to_numpy()[:, None] + K_RATE)
        by_season[season] = pd.DataFrame(r, columns=STATS, index=pids)
    rate = pd.concat(by_season, names=["season", "pid"]).reorder_levels(["pid", "season"]) if by_season else pd.DataFrame(columns=STATS, dtype=float)

    # Defense vs position: actual vs expected (player's own rate × minutes) by opponent and position.
    full = lookup(rate, [h["pid"], h["season"]])
    e = full * h["min"].to_numpy()[:, None]
    for i, s in enumerate(STATS):
        h[f"E_{s}"] = e[:, i]
    gd = h.groupby(["season", "opp", "pos"])
    dvp = gd[A_COLS + E_COLS].sum()
    gpri = h.groupby(["season", "pos"])
    dvp_prior = (gpri[E_COLS].mean() * C_DVP).clip(lower=PRIOR_FLOOR)
    dvp_prior.columns = STATS

    # Player vs opponent across seasons. W = minutes × full-season dvp multiplier, so the
    # expectation can be rebuilt with any rate for the target's own season (leave-one-out).
    d_row = dvp_log(
        lookup(dvp[A_COLS], [h["season"], h["opp"], h["pos"]]),
        lookup(dvp[E_COLS], [h["season"], h["opp"], h["pos"]]),
        lookup(dvp_prior, [h["season"], h["pos"]]),
    )
    w = np.exp(d_row) * h["min"].to_numpy()[:, None]
    for i, s in enumerate(STATS):
        h[f"W_{s}"] = w[:, i]
        h[f"T_{s}"] = w[:, i] * full[:, i]
    h2h_season = h.groupby(["pid", "opp", "season"])[["min", *W_COLS, *T_COLS]].sum().rename(columns={"min": "M"})
    gh = h.groupby(["pid", "opp"])
    h2h = gh[A_COLS + T_COLS].sum()
    h2h["n"] = gh.size()

    # Pace per team-season: possessions ≈ FGA + 0.44·FTA − OREB + TO, scaled to 240 minutes.
    poss = Y[:, STATS.index("fga")] + 0.44 * Y[:, STATS.index("fta")] - Y[:, STATS.index("oreb")] + Y[:, STATS.index("to")]
    tg = pd.DataFrame({"season": h["season"], "team": h["team"], "date": h["date"], "poss": poss, "min": h["min"]})
    tg = tg.groupby(["season", "team", "date"])[["poss", "min"]].sum()
    tg = tg[tg["min"] >= 150]
    pace = (tg["poss"] * 240 / tg["min"]).groupby(level=["season", "team"]).mean()

    mins = h[["pid", "season", "date", "min"]]
    return Aggs(player, pos_rate, pos_A, pos_M, pos_min, rate, dvp, dvp_prior, h2h, h2h_season, pace, mins)


# ---------------------------------------------------------------------------- features

@dataclass
class Features:
    rows: pd.DataFrame
    Y: np.ndarray  # actual stats (N × S)
    rate: np.ndarray  # per-minute rate (N × S), clamped > 0
    dvp: np.ndarray
    h2h: np.ndarray
    pace: np.ndarray
    home: np.ndarray
    b2b: np.ndarray
    season_min: np.ndarray  # NaN when fewer than 3 games of history
    recent_min: np.ndarray

    def usual_min(self) -> np.ndarray:
        sm = np.where(np.isfinite(self.season_min), self.season_min, self.rows["min"].to_numpy())
        return np.maximum(sm, 1.0)

    def design(self, i: int, minutes: np.ndarray | None = None) -> np.ndarray:
        """Feature matrix for stat i (FEATURES order); minutes default to the actual minutes."""
        m = self.rows["min"].to_numpy() if minutes is None else minutes
        min_ratio = np.log(np.maximum(m, 0.5) / self.usual_min())
        return np.column_stack([self.dvp[:, i], self.pace, self.h2h[:, i], self.home, self.b2b, min_ratio])

    def offset(self, i: int) -> np.ndarray:
        return np.log(self.usual_min()) + np.log(self.rate[:, i])

    def minutes_design(self) -> np.ndarray:
        sm = self.season_min
        rm = np.where(np.isfinite(self.recent_min), self.recent_min, sm)
        return np.column_stack([sm, rm, self.b2b, self.home])

    def subset(self, mask: np.ndarray) -> "Features":
        return Features(
            self.rows[mask].reset_index(drop=True), self.Y[mask], self.rate[mask], self.dvp[mask], self.h2h[mask],
            self.pace[mask], self.home[mask], self.b2b[mask], self.season_min[mask], self.recent_min[mask],
        )


def featurize(ag: Aggs, target: pd.DataFrame, loo: bool, team_dates: set[tuple[str, str]]) -> Features:
    t = target.reset_index(drop=True)
    n = len(t)
    Y = t[STATS].to_numpy(float)
    pid, season, opp, pos, team = (t[c].to_numpy() for c in ("pid", "season", "opp", "pos", "team"))
    mins = t["min"].to_numpy(float)
    L = 1.0 if loo else 0.0

    # Per-minute rate for the target's season (leave-one-out) shrunk toward its prior.
    A_p = lookup(ag.player[A_COLS], [pid, season])
    M_p = lookup(ag.player["M"], [pid, season])
    G_p = lookup(ag.player["G"], [pid, season])
    has_p = np.isfinite(M_p)
    r_row = role(t["gs"])
    # Positional prior for the same season, without this game.
    pos_same = (lookup(ag.pos_A, [season, pos, r_row]) - L * Y) / np.maximum(lookup(ag.pos_M, [season, pos, r_row]) - L * mins, 1)[:, None]
    prior = fill(lookup(ag.rate, [pid, season - 1]), pos_same, lookup(ag.pos_rate, [season - 1, pos, r_row]))
    with np.errstate(invalid="ignore"):
        own = (A_p - L * Y + K_RATE * prior) / ((M_p - L * mins)[:, None] + K_RATE)
    rate = np.where(has_p[:, None], own, prior)

    full = lookup(ag.rate, [pid, season])
    full = np.where(np.isnan(full), rate, full)
    e = full * mins[:, None]

    # Defense vs position, falling back to last season's table for a team with no games yet.
    # Leave-one-out removes the game itself and re-rates the player's other games against this
    # opponent with his leave-one-out rate, so a big game can't raise its own expectation.
    m_same = np.nan_to_num(lookup(ag.h2h_season["M"], [pid, opp, season]))  # his minutes vs this opp this season
    exact_A = lookup(ag.dvp[A_COLS], [season, opp, pos])
    exact_E = lookup(ag.dvp[E_COLS], [season, opp, pos])
    use_exact = np.isfinite(exact_A[:, 0])
    own_E = full * m_same[:, None] - rate * (m_same - mins)[:, None]
    dA = np.where(use_exact[:, None], exact_A - L * Y, lookup(ag.dvp[A_COLS], [season - 1, opp, pos]))
    dE = np.where(use_exact[:, None], exact_E - L * own_E, lookup(ag.dvp[E_COLS], [season - 1, opp, pos]))
    dP = lookup(ag.dvp_prior, [season, pos])
    dP = np.where(np.isnan(dP), lookup(ag.dvp_prior, [season - 1, pos]), dP)
    have_dvp = np.isfinite(dP).all(axis=1) & np.isfinite(dA).all(axis=1)
    dvp = np.where(have_dvp[:, None], dvp_log(np.nan_to_num(dA), np.nan_to_num(dE), np.nan_to_num(dP)), 0.0)

    # Player vs this opponent: other seasons at their own full rates and defense tables; the
    # target's season at the target's leave-one-out rate and defense, without the game itself.
    hA = lookup(ag.h2h[A_COLS], [pid, opp])
    hn = lookup(ag.h2h["n"], [pid, opp]) - L
    t_sum = lookup(ag.h2h[T_COLS], [pid, opp])
    t_same = np.nan_to_num(lookup(ag.h2h_season[T_COLS], [pid, opp, season]))
    E = (t_sum - t_same) + np.exp(dvp) * (m_same - L * mins)[:, None] * rate
    A = hA - L * Y
    with np.errstate(divide="ignore", invalid="ignore"):
        h_prior = np.maximum(C_H2H * E / hn[:, None], PRIOR_FLOOR)
        h2h = np.where(E > 0, np.log((A + h_prior) / (E + h_prior)), 0.0)
    h2h = np.where((np.isfinite(hn) & (hn > 0))[:, None] & np.isfinite(h2h), h2h, 0.0)

    own_pace = lookup(ag.pace, [season, team])
    opp_pace = lookup(ag.pace, [season, opp])
    with np.errstate(invalid="ignore"):
        pace = np.where(np.isfinite(own_pace) & np.isfinite(opp_pace), np.log((own_pace + opp_pace) / (2 * own_pace)), 0.0)

    prev_day = (pd.to_datetime(t["date"]) - pd.Timedelta(days=1)).dt.strftime("%Y-%m-%d").to_numpy()
    b2b = np.array([(tm, d) in team_dates for tm, d in zip(team, prev_day)], dtype=float)

    # Minutes: season average (leave-one-out) and the last five games before this one.
    G = G_p - L
    with np.errstate(invalid="ignore", divide="ignore"):
        season_min = np.where(has_p & (G >= 3), (M_p - L * mins) / G, np.nan)
    if loo:
        order = t.sort_values(["pid", "season", "date"], kind="stable").index
        prev5 = (
            t.loc[order].groupby(["pid", "season"])["min"].transform(lambda s: s.shift(1).rolling(5, min_periods=1).mean())
        )
        recent = prev5.reindex(t.index).to_numpy()
    else:
        last5 = ag.mins.groupby(["pid", "season"])["min"].apply(lambda s: s.tail(5).mean())
        recent = lookup(last5, [pid, season])
    recent = np.where(has_p & np.isfinite(recent), recent, np.where(has_p, season_min, np.nan))

    return Features(t, Y, np.maximum(rate, 1e-6), dvp, h2h, pace, t["home"].to_numpy(float), b2b, season_min, recent)


def h2h_table(ag: Aggs) -> pd.DataFrame:
    """Shrunk player-vs-opponent log multipliers at full-season rates (for the app)."""
    A = ag.h2h[A_COLS].to_numpy()
    E = ag.h2h[T_COLS].to_numpy()
    n = ag.h2h["n"].to_numpy()[:, None]
    prior = np.maximum(C_H2H * E / n, PRIOR_FLOOR)
    with np.errstate(divide="ignore", invalid="ignore"):
        v = np.where(E > 0, np.log((A + prior) / (E + prior)), 0.0)
    out = pd.DataFrame(np.where(np.isfinite(v), v, 0.0), columns=STATS, index=ag.h2h.index)
    out["n"] = ag.h2h["n"]
    return out
