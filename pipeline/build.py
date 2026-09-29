"""Train the projection models and write the app's data bundle (public/data/bundle.json).

    python -m pipeline.build

1. Holdout test: train on everything before the last 25% of last season, forecast
   those later games with features frozen at the cutoff, and score three forecasts:
   naive (season average so far), Poisson GLM, LightGBM. For each stat the app uses
   the GBM only if it beats the GLM's error by at least 0.2%; otherwise the GLM.
2. Final models are refit on all games (leave-one-out features).
3. Inference tables for the app: player season lines, defense vs. position, what each
   team allowed by position and role, player-vs-opponent history, pace, schedule.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import sys
import unicodedata
from pathlib import Path

import numpy as np
import pandas as pd

from .dataset import ADJ, Dataset, broad_positions, load_dataset, to_pos
from .features import (
    A_COLS, E_COLS, FEATURES, K_RATE, POSITIONS, S, STATS, Aggs, Features, build_aggs, featurize, h2h_table, lookup, role,
)
from .models import Glm, best_rounds, export_trees, fit_gbm, fit_glm, pearson_phi
from .seasons import NBA_TEAMS, season_label

OUT = Path(os.environ.get("WFH_OUT", "public/data")).resolve()
GBM_MIN_GAIN = 0.002  # GBM must cut holdout RMSE by 0.2% to replace the GLM


def log(msg: str) -> None:
    print(msg, flush=True)


def r(x: float, d: int = 2) -> float:
    return float(round(float(x), d))


def fit_minutes(f: Features) -> tuple[np.ndarray, float]:
    ok = np.isfinite(f.season_min)
    X = np.column_stack([np.ones(ok.sum()), f.minutes_design()[ok]])
    y = f.rows["min"].to_numpy()[ok]
    coef, *_ = np.linalg.lstsq(X, y, rcond=None)
    resid = y - X @ coef
    return coef, float(np.sqrt(resid @ resid / max(1, len(y) - X.shape[1])))


def predict_minutes(coef: np.ndarray, f: Features) -> np.ndarray:
    return np.maximum(0, coef[0] + f.minutes_design() @ coef[1:])


def validation_mask(f: Features) -> np.ndarray:
    """Latest 15% of training games by date, for early stopping."""
    dates = f.rows["date"].to_numpy()
    return dates >= np.sort(dates)[int(len(dates) * 0.85)]


# ------------------------------------------------------------------------ holdout evaluation

def evaluate(ds: Dataset, team_dates: set) -> tuple[dict, dict[str, dict]]:
    rows, y = ds.rows, ds.years
    last = rows[rows["season"] == y["last"]]
    cutoff = last["date"].iloc[int(len(last) * 0.75)]
    train_rows = rows[(rows["season"] == y["prev"]) | ((rows["season"] == y["last"]) & (rows["date"] < cutoff))]
    test_rows = last[last["date"] >= cutoff]
    ag = build_aggs(train_rows)
    ftr = featurize(ag, train_rows, True, team_dates)
    fte = featurize(ag, test_rows, False, team_dates)
    G = lookup(ag.player["G"], [fte.rows["pid"], fte.rows["season"]])
    fte = fte.subset((np.nan_to_num(G) >= 5) & np.isfinite(fte.season_min))

    mcoef, _ = fit_minutes(ftr)
    pred_min = predict_minutes(mcoef, fte)
    actual_min = fte.rows["min"].to_numpy()
    A_pre = lookup(ag.player[A_COLS], [fte.rows["pid"], fte.rows["season"]])
    G_pre = lookup(ag.player["G"], [fte.rows["pid"], fte.rows["season"]])
    naive_all = A_pre / G_pre[:, None]

    def metrics(truth: np.ndarray, pred: np.ndarray) -> tuple[float, float]:
        return float(np.mean(np.abs(truth - pred))), float(np.sqrt(np.mean((truth - pred) ** 2)))

    report: dict = {
        "cutoff": cutoff, "trainRows": len(train_rows), "testRows": len(fte.rows),
        "stats": {},
    }
    mn, mr = metrics(actual_min, fte.season_min)
    pn, pr = metrics(actual_min, pred_min)
    report["minutes"] = {"naive": mn, "model": pn, "naiveRmse": mr, "modelRmse": pr}

    choice: dict[str, dict] = {}
    valid = validation_mask(ftr)
    log(f"  cutoff {cutoff}, train {len(train_rows)} rows, test {len(fte.rows)} rows")
    log(f"  {'stat':5} {'naive':>8} {'GLM':>8} {'GBM':>8}  (RMSE)  chosen")
    for i, s in enumerate(STATS):
        X, off, yy = ftr.design(i), ftr.offset(i), ftr.Y[:, i]
        glm = fit_glm(X, yy, off)
        rounds = best_rounds(X, yy, off, valid)
        gbm = fit_gbm(X, yy, off, rounds)
        Xt, offt, yt = fte.design(i, pred_min), fte.offset(i), fte.Y[:, i]
        n_mae, n_rmse = metrics(yt, naive_all[:, i])
        g_mae, g_rmse = metrics(yt, glm.predict(Xt, offt))
        b_mae, b_rmse = metrics(yt, gbm.predict(Xt, offt))
        use_gbm = b_rmse < g_rmse * (1 - GBM_MIN_GAIN)
        report["stats"][s] = {
            "naive": n_mae, "model": b_mae if use_gbm else g_mae, "naiveRmse": n_rmse, "modelRmse": b_rmse if use_gbm else g_rmse,
            "glmRmse": g_rmse, "gbmRmse": b_rmse, "chosen": "gbm" if use_gbm else "glm",
        }
        choice[s] = {"gbm": use_gbm, "rounds": rounds}
        log(f"  {s:5} {n_rmse:8.3f} {g_rmse:8.3f} {b_rmse:8.3f}          {'GBM' if use_gbm else 'GLM'}  ({(min(g_rmse, b_rmse) / n_rmse - 1) * 100:+.1f}% vs naive)")
    log(f"  min   {mr:8.3f} {pr:8.3f}")
    return report, choice


# ------------------------------------------------------------------------ inference tables

def build_bundle(ds: Dataset, ag: Aggs, fall: Features, models: dict, report: dict | None) -> dict:
    y = ds.years
    rows = ds.rows
    cur_rows = rows[rows["season"] == y["cur"]]
    has_cur = len(cur_rows) > 0
    last_rows = rows[rows["season"] == y["last"]]

    # Pace for upcoming games: current season blended with last season.
    def team_pace(team: str) -> float:
        last = ag.pace.get((y["last"], team), 99.0)
        cur = ag.pace.get((y["cur"], team))
        n = (cur_rows["team"] == team).sum() / 10
        return (n * cur + 10 * last) / (n + 10) if cur is not None and not np.isnan(cur) else last

    # Defense vs position for upcoming games: current season plus half-weighted last season.
    def inference_dvp(team: str, pos: str) -> list[float]:
        A, E = np.zeros(S), np.zeros(S)
        for season, w in ((y["cur"], 1.0), (y["last"], 0.5 if has_cur else 1.0)):
            key = (season, team, pos)
            if key in ag.dvp.index:
                A += w * ag.dvp.loc[key, A_COLS].to_numpy(float)
                E += w * ag.dvp.loc[key, E_COLS].to_numpy(float)
        prior = ag.dvp_prior.loc[(y["last"], pos)].to_numpy(float) if (y["last"], pos) in ag.dvp_prior.index else np.zeros(S)
        with np.errstate(divide="ignore", invalid="ignore"):
            v = np.where(E + prior > 0, np.log((A + prior) / (E + prior)), 0.0)
        return [r(x, 4) for x in v]

    # Per-game lines allowed by position and role (for players with no history), shrunk toward the league.
    src = pd.concat([last_rows, cur_rows]) if has_cur else last_rows
    vals = src[["min", *STATS]].to_numpy(float)
    keyed = src.assign(role=role(src["gs"]))
    team_sum = pd.DataFrame(vals, columns=["min", *STATS]).assign(opp=keyed["opp"].to_numpy(), pos=keyed["pos"].to_numpy(), role=keyed["role"].to_numpy())
    by_team = team_sum.groupby(["opp", "pos", "role"])
    t_sum, t_n = by_team[["min", *STATS]].sum(), by_team.size()
    by_lg = team_sum.groupby(["pos", "role"])
    lg_mean = by_lg[["min", *STATS]].mean()

    def allowed(team: str, pos: str, rl: str) -> list[float]:
        lg = lg_mean.loc[(pos, rl)].to_numpy(float) if (pos, rl) in lg_mean.index else np.zeros(S + 1)
        key = (team, pos, rl)
        s = t_sum.loc[key].to_numpy(float) if key in t_sum.index else np.zeros(S + 1)
        n = t_n.get(key, 0)
        return [r(v, 3) for v in (s + 10 * lg) / (n + 10)]

    teams = {
        t: {
            "abbr": t,
            "name": ds.team_names.get(t, t),
            "pace": r(team_pace(t), 2),
            "dvp": {p: inference_dvp(t, p) for p in POSITIONS},
            "allowed": {p: {"S": allowed(t, p, "S"), "B": allowed(t, p, "B")} for p in POSITIONS},
        }
        for t in NBA_TEAMS
    }

    # Season lines: totals pages (authoritative counting stats) + double/triple-doubles from game logs.
    dd = rows.groupby(["pid", "season"])[["dd", "td"]].sum()
    cur_gs = cur_rows.groupby("pid")["gs"].sum()

    def season_line(pid: str, season: int) -> dict | None:
        if season == y["cur"] and has_cur:
            if (pid, season) not in ag.player.index:
                return None
            p = ag.player.loc[(pid, season)]
            line = {"gp": int(p["G"]), "gs": int(cur_gs.get(pid, 0)), "min": r(p["M"], 1)}
            line.update({s: r(p[f"A_{s}"], 1) for s in STATS})
            return line
        t = ds.totals.get(season, {}).get(pid)
        if not t or not t["g"]:
            return None
        d = dd.loc[(pid, season)] if (pid, season) in dd.index else None
        line = {k: t[k] for k in ("min", "fgm", "fga", "tpm", "tpa", "ftm", "fta", "oreb", "dreb", "reb", "ast", "stl", "blk", "to", "pts")}
        return {"gp": t["g"], "gs": t["gs"], **line, "dd": int(d["dd"]) if d is not None else 0, "td": int(d["td"]) if d is not None else t["td"]}

    starts = sorted(g["date"] for g in ds.schedule)
    season_start = starts[0] if starts else f"{y['cur'] - 1}-10-20"
    season_end = starts[-1] if starts else f"{y['cur']}-04-12"
    start_date = dt.date.fromisoformat(season_start)

    def age_at(birth: str) -> int:
        if not birth:
            return 0
        b = dt.date.fromisoformat(birth)
        return start_date.year - b.year - ((start_date.month, start_date.day) < (b.month, b.day))

    stale_before = f"{y['cur'] - 1}-07-01"  # injury notes left over from last season
    injury: dict[str, dict] = {}
    for inj in ds.injuries:
        if not inj["date"] or inj["date"] < stale_before:
            continue
        note = inj["note"]
        status = "dtd" if "day to day" in note.lower() else "out" if note.lower().startswith("out") else None
        if status:
            injury[inj["id"]] = {"date": inj["date"], "note": note, "status": status}

    team_games = cur_rows.groupby("team")["date"].nunique()
    players = []
    for ro in ds.roster:
        pid = ro["id"]
        last, prev, cur = season_line(pid, y["last"]), season_line(pid, y["prev"]), season_line(pid, y["cur"])
        primary = (
            to_pos(ds.totals.get(y["last"], {}).get(pid, {}).get("pos"))
            or to_pos(ds.totals.get(y["prev"], {}).get(pid, {}).get("pos"))
            or ds.pos_for(pid, y["cur"])
        )
        elig = list(dict.fromkeys([primary, *[p for p in broad_positions(ro["pos"], ro["heightIn"]) if p != primary and p in ADJ[primary]]]))
        # Availability: share of team games played (recent seasons weigh more), averaged with a
        # healthy-player baseline, since one long injury says less about next season than it seems.
        g = possible = 0.0
        if last:
            g, possible = g + last["gp"], possible + 82
        if prev:
            g, possible = g + 0.5 * prev["gp"], possible + 41
        if cur:
            g, possible = g + 2 * cur["gp"], possible + 2 * max(team_games.get(ro["team"], 0), cur["gp"])
        if possible:
            avail = min(0.97, max(0.6, 0.5 * (g + 0.85 * 20) / (possible + 20) + 0.5 * 0.9))
        else:  # no NBA history: deep-bench players often don't see the floor
            avail = 0.35 if ro["twoWay"] else 0.8 if ro["rookie"] else 0.45
        recent = cur_rows.loc[cur_rows["pid"] == pid, "min"].tail(5)
        tot_last = ds.totals.get(y["last"], {}).get(pid)
        player = {
            "id": pid, "name": ro["name"], "team": ro["team"], "pos": primary, "elig": elig,
            "age": age_at(ro["birthDate"]) or (tot_last["age"] + 1 if tot_last else 0),
            "rookie": ro["rookie"], "twoWay": ro["twoWay"], "heightIn": ro["heightIn"],
        }
        for key, line in (("cur", cur), ("last", last), ("prev", prev)):
            if line:
                player[key] = line
        if len(recent):
            player["recentMin"] = r(recent.mean(), 1)
        player["avail"] = r(avail, 3)
        if pid in injury:
            player["injury"] = injury[pid]
        players.append(player)
    roster_ids = {p["id"] for p in players}

    # Player-vs-opponent history (rostered players only; skip negligible entries).
    h2h: dict[str, dict[str, list]] = {}
    table = h2h_table(ag)
    for (pid, opp), row in table.iterrows():
        if pid not in roster_ids:
            continue
        v = [r(row[s], 3) for s in STATS]
        if all(abs(x) < 0.005 for x in v):
            continue
        h2h.setdefault(pid, {})[opp] = [int(row["n"]), *v]

    cur_logs: dict[str, list] = {}
    for rec in cur_rows[cur_rows["pid"].isin(roster_ids)].itertuples(index=False):
        cur_logs.setdefault(rec.pid, []).append([rec.date, rec.opp, r(rec.min, 1), *[float(getattr(rec, s)) for s in STATS]])

    # League scales among rotation players (last season, 20+ games at 15+ minutes).
    rot = [p["last"] for p in players if p.get("last") and p["last"]["gp"] >= 20 and p["last"]["min"] / p["last"]["gp"] >= 15]
    pg = {s: np.array([l[s] / l["gp"] for l in rot]) for s in [*STATS]}
    stat_sd = {s: r(max(float(np.std(pg[s], ddof=1)), 0.05), 4) for s in STATS}

    def ratio(num: str, den: str) -> dict:
        ref = sum(l[num] for l in rot) / sum(l[den] for l in rot)
        return {"ref": r(ref, 4), "sd": r(max(float(np.std(pg[num] - ref * pg[den], ddof=1)), 0.05), 4)}

    pos_rates = {
        p: {
            rl: {
                "min": r(ag.pos_min.get((y["last"], p, rl), 30.0 if rl == "S" else 16.0), 2),
                "rates": [r(x, 5) for x in (ag.pos_rate.loc[(y["last"], p, rl)].to_numpy(float) if (y["last"], p, rl) in ag.pos_rate.index else np.zeros(S))],
            }
            for rl in ("S", "B")
        }
        for p in POSITIONS
    }

    model = {
        "stats": STATS,
        "features": ["const", *FEATURES],
        "coef": {s: [r(c, 5) for c in models["glm"][s].coef] for s in STATS},
        "phi": {s: r(max(0.5, models["phi"][s]), 4) for s in STATS},
        "minutes": {"features": ["const", "baseMin", "recentMin", "b2b", "home"], "coef": [r(c, 5) for c in models["minutes"][0]], "sd": r(models["minutes"][1], 3)},
        "rateShrinkMinutes": K_RATE,
        "posRates": pos_rates,
        "statSd": stat_sd,
        "ratio": {"FG%": ratio("fgm", "fga"), "FT%": ratio("ftm", "fta"), "3P%": ratio("tpm", "tpa"), "A/T": ratio("ast", "to")},
        "trainedOn": {"rows": len(fall.rows), "seasons": sorted({season_label(int(s)) for s in rows["season"].unique()})},
    }
    if models["gbm"]:
        model["gbm"] = {s: {"trees": trees} for s, trees in models["gbm"].items()}
    if report:
        model["eval"] = report

    def sort_key(p: dict) -> str:
        return unicodedata.normalize("NFD", p["name"]).encode("ascii", "ignore").decode().casefold()

    return {
        "meta": {
            "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
            "source": "basketball-reference.com",
            **y,
            "curLabel": season_label(y["cur"]), "lastLabel": season_label(y["last"]), "prevLabel": season_label(y["prev"]),
            "seasonStart": season_start, "seasonEnd": season_end,
            "dataThrough": cur_rows["date"].max() if has_cur else None,
            "curGames": len(set(zip(cur_rows["date"], cur_rows["team"]))) / 2,
        },
        "players": sorted(players, key=sort_key),
        "teams": teams,
        "schedule": [{"d": g["date"], "h": g["home"], "a": g["away"]} for g in ds.schedule],
        "model": model,
        "h2h": h2h,
        "curLogs": cur_logs,
    }


# ------------------------------------------------------------------------ main

def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # Windows consoles default to cp1252
    ds = load_dataset()
    rows = ds.rows
    if len(rows) < 1000:
        log("Not enough game logs to train. Run `python -m pipeline.fetch` first.")
        return 1
    y = ds.years
    log(f"Rows: {len(rows)} player-games (" + ", ".join(f"{season_label(s)}: {(rows['season'] == s).sum()}" for s in (y["prev"], y["last"], y["cur"])) + ")")
    team_dates = set(zip(rows["team"], rows["date"]))  # schedules are public ahead of time: no leakage

    report, choice = None, {s: {"gbm": False, "rounds": 0} for s in STATS}
    if (rows["season"] == y["last"]).sum() >= 2000:
        log("Holdout test (last 25% of last season):")
        report, choice = evaluate(ds, team_dates)

    log("Training final models on all games...")
    ag = build_aggs(rows)
    fall = featurize(ag, rows, True, team_dates)
    models: dict = {"glm": {}, "gbm": {}, "phi": {}, "minutes": fit_minutes(fall)}
    for i, s in enumerate(STATS):
        X, off, yy = fall.design(i), fall.offset(i), fall.Y[:, i]
        glm: Glm = fit_glm(X, yy, off)
        models["glm"][s] = glm
        mu = glm.predict(X, off)
        if choice[s]["gbm"]:
            # More data than in the holdout run: scale the early-stopped round count up a little.
            gbm = fit_gbm(X, yy, off, int(round(choice[s]["rounds"] * 1.1)))
            models["gbm"][s] = export_trees(gbm)
            mu = gbm.predict(X, off)
        models["phi"][s] = pearson_phi(yy, mu, X.shape[1] + 1)
        log(f"  {s:4} GLM coef [{', '.join(f'{c:.3f}' for c in glm.coef)}]{'  -> GBM, ' + str(len(models['gbm'][s])) + ' trees' if s in models['gbm'] else ''}")
    mc, msd = models["minutes"]
    log(f"  minutes coef [{', '.join(f'{c:.3f}' for c in mc)}] sd={msd:.2f}")

    bundle = build_bundle(ds, ag, fall, models, report)
    OUT.mkdir(parents=True, exist_ok=True)
    out = OUT / "bundle.json"
    out.write_text(json.dumps(bundle, ensure_ascii=False, separators=(",", ":"), allow_nan=False), encoding="utf-8")
    log(
        f"Wrote {os.path.relpath(out)} ({out.stat().st_size // 1024} KB): {len(bundle['players'])} players, "
        f"{len(bundle['schedule'])} games, {len(bundle['h2h'])} players with opponent history."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
