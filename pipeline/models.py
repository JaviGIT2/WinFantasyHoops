"""Per-stat count models, trained on the features from features.py.

Both models predict  E[stat] = exp(offset + f(x)),  offset = log(usual minutes × per-minute rate),
so they only learn how matchup context moves a player off his own baseline.

- GLM: Poisson regression (scikit-learn). The offset is handled with the standard
  exposure trick: fit y / exposure with sample weight = exposure, which has the same
  likelihood as a log-link Poisson model with offset log(exposure).
- GBM: LightGBM with a Poisson objective and the offset as ``init_score``, so the
  trees model the remaining log-multiplier. It can pick up non-linear effects (e.g.
  double-doubles rising sharply with minutes). Monotone constraints keep "a weaker
  defense" and "more minutes" from ever lowering a projection.

The app evaluates both directly: GLM coefficients, or GBM trees flattened into arrays.
"""
from __future__ import annotations

import warnings
from dataclasses import dataclass

import lightgbm as lgb
import numpy as np
from sklearn.linear_model import PoissonRegressor

from .features import FEATURES

# +1: monotone increasing (dvp, minRatio); 0: unconstrained.
MONOTONE = [1 if f in ("dvp", "minRatio") else 0 for f in FEATURES]

GBM_PARAMS = {
    "objective": "poisson",
    "learning_rate": 0.05,
    "num_leaves": 15,
    "min_data_in_leaf": 300,
    "lambda_l2": 1.0,
    "monotone_constraints": MONOTONE,
    "verbose": -1,
    "seed": 7,
    "deterministic": True,
    "force_row_wise": True,
}


@dataclass
class Glm:
    coef: np.ndarray  # [intercept, *FEATURES]

    def predict(self, X: np.ndarray, offset: np.ndarray) -> np.ndarray:
        return np.exp(np.minimum(offset + self.coef[0] + X @ self.coef[1:], 30))


def fit_glm(X: np.ndarray, y: np.ndarray, offset: np.ndarray, l2: float = 5.0) -> Glm:
    """Ridge-penalized Poisson GLM: maximizes log-likelihood − (l2 / 2)·‖β‖² (intercept unpenalized).

    scikit-learn scales its ``alpha`` by the total sample weight, which here is the total
    exposure: tiny for rare events like triple-doubles. Converting keeps the penalty's
    absolute strength the same for every stat, so rare stats don't overfit.
    """
    exposure = np.exp(offset)
    model = PoissonRegressor(alpha=l2 / exposure.sum(), solver="newton-cholesky", max_iter=300, tol=1e-9)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        model.fit(X, y / exposure, sample_weight=exposure)
    return Glm(np.concatenate([[model.intercept_], model.coef_]))


@dataclass
class Gbm:
    booster: lgb.Booster
    iterations: int

    def predict(self, X: np.ndarray, offset: np.ndarray) -> np.ndarray:
        raw = self.booster.predict(X, num_iteration=self.iterations, raw_score=True)
        return np.exp(np.minimum(offset + raw, 30))


def fit_gbm(X: np.ndarray, y: np.ndarray, offset: np.ndarray, rounds: int) -> Gbm:
    data = lgb.Dataset(X, y, init_score=offset, feature_name=FEATURES, free_raw_data=False)
    booster = lgb.train(GBM_PARAMS, data, num_boost_round=rounds)
    return Gbm(booster, rounds)


def best_rounds(X: np.ndarray, y: np.ndarray, offset: np.ndarray, valid: np.ndarray, max_rounds: int = 600) -> int:
    """Number of boosting rounds by early stopping on a date-ordered validation slice."""
    train = lgb.Dataset(X[~valid], y[~valid], init_score=offset[~valid], feature_name=FEATURES)
    val = lgb.Dataset(X[valid], y[valid], init_score=offset[valid], feature_name=FEATURES, reference=train)
    booster = lgb.train(
        GBM_PARAMS, train, num_boost_round=max_rounds, valid_sets=[val],
        callbacks=[lgb.early_stopping(40, verbose=False)],
    )
    return max(1, booster.best_iteration or max_rounds)


def pearson_phi(y: np.ndarray, mu: np.ndarray, p: int) -> float:
    """Overdispersion: Var(y) ≈ phi × mean."""
    return float(np.sum((y - mu) ** 2 / np.maximum(mu, 1e-9)) / max(1, len(y) - p))


def export_trees(model: Gbm) -> list[dict]:
    """Flatten LightGBM trees into arrays: internal node i splits on feature f[i] at t[i]
    (x <= t goes left); a child index c >= 0 is another node, c < 0 is leaf ~c with value v[~c]."""
    dump = model.booster.dump_model(num_iteration=model.iterations)
    trees = []
    for info in dump["tree_info"]:
        f: list[int] = []
        t: list[float] = []
        left: list[int] = []
        right: list[int] = []
        v: list[float] = []

        def visit(node: dict) -> int:
            if "split_feature" not in node:
                v.append(float(node["leaf_value"]))
                return ~(len(v) - 1)
            if node.get("decision_type", "<=") != "<=":
                raise ValueError(f"unsupported split {node.get('decision_type')}")
            i = len(f)
            f.append(int(node["split_feature"]))
            t.append(float(node["threshold"]))
            left.append(0)
            right.append(0)
            left[i] = visit(node["left_child"])
            right[i] = visit(node["right_child"])
            return i

        visit(info["tree_structure"])
        trees.append({"f": f, "t": t, "l": left, "r": right, "v": v})
    return trees


def eval_trees(trees: list[dict], X: np.ndarray) -> np.ndarray:
    """Reference evaluator for exported trees (mirrors the app's TypeScript version)."""
    out = np.zeros(len(X))
    for tree in trees:
        for k, x in enumerate(X):
            if not tree["f"]:
                out[k] += tree["v"][0]
                continue
            node = 0
            while node >= 0:
                node = tree["l"][node] if x[tree["f"][node]] <= tree["t"][node] else tree["r"][node]
            out[k] += tree["v"][~node]
    return out
