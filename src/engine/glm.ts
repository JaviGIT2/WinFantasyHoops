import { solve } from './mathx';

/**
 * Poisson regression with a log link and an offset, fitted by iteratively
 * reweighted least squares (IRLS):
 *
 *   log E[y] = offset + X·β
 *
 * The per-game stat model uses offset = log(minutes × player per-minute rate), so β
 * only has to learn how matchup context (opponent defense vs. position, pace,
 * player-vs-team history, home court, back-to-backs) scales a player's own baseline.
 * A small ridge penalty (never on the intercept) keeps correlated features stable.
 */
export interface GlmFit {
  coef: number[];
  iterations: number;
  deviance: number;
  /** Pearson overdispersion: Var(y) ≈ phi × mean. */
  phi: number;
  n: number;
}

export function fitPoisson(
  X: number[][],
  y: number[],
  offset: number[],
  opts: { lambda?: number; maxIter?: number; tol?: number } = {},
): GlmFit {
  const { lambda = 1, maxIter = 50, tol = 1e-8 } = opts;
  const n = y.length;
  const p = X[0]?.length ?? 0;
  if (n === 0 || p === 0) throw new Error('fitPoisson: empty design');

  // Start from the intercept-only solution (feature 0 must be the constant column).
  let sumY = 0;
  let sumExp = 0;
  for (let i = 0; i < n; i++) {
    sumY += y[i];
    sumExp += Math.exp(offset[i]);
  }
  const beta = new Array(p).fill(0);
  beta[0] = Math.log(Math.max(sumY, 1e-9) / sumExp);

  let iterations = 0;
  for (; iterations < maxIter; iterations++) {
    const XtWX = Array.from({ length: p }, () => new Array(p).fill(0));
    const XtWz = new Array(p).fill(0);
    for (let i = 0; i < n; i++) {
      const xi = X[i];
      let eta = offset[i];
      for (let j = 0; j < p; j++) eta += xi[j] * beta[j];
      const mu = Math.exp(Math.min(eta, 30));
      const w = Math.max(mu, 1e-10);
      // Working response without the offset.
      const z = eta - offset[i] + (y[i] - mu) / w;
      for (let j = 0; j < p; j++) {
        const wx = w * xi[j];
        XtWz[j] += wx * z;
        for (let k = j; k < p; k++) XtWX[j][k] += wx * xi[k];
      }
    }
    for (let j = 0; j < p; j++) {
      for (let k = 0; k < j; k++) XtWX[j][k] = XtWX[k][j];
      if (j > 0) XtWX[j][j] += lambda;
    }
    const next = solve(XtWX, XtWz);
    const delta = Math.max(...next.map((b, j) => Math.abs(b - beta[j])));
    for (let j = 0; j < p; j++) beta[j] = next[j];
    if (delta < tol) {
      iterations++;
      break;
    }
  }

  let deviance = 0;
  let pearson = 0;
  for (let i = 0; i < n; i++) {
    const mu = predictPoisson(beta, X[i], offset[i]);
    const yi = y[i];
    deviance += 2 * ((yi > 0 ? yi * Math.log(yi / mu) : 0) - (yi - mu));
    pearson += (yi - mu) ** 2 / mu;
  }
  return { coef: beta, iterations, deviance, phi: pearson / Math.max(1, n - p), n };
}

export function predictPoisson(coef: number[], x: number[], offset: number): number {
  let eta = offset;
  for (let j = 0; j < coef.length; j++) eta += coef[j] * x[j];
  return Math.exp(Math.min(eta, 30));
}

/** Ordinary least squares with an optional ridge penalty on non-intercept terms. */
export function fitLinear(X: number[][], y: number[], lambda = 0): { coef: number[]; residualSd: number } {
  const n = y.length;
  const p = X[0].length;
  const XtX = Array.from({ length: p }, () => new Array(p).fill(0));
  const Xty = new Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < p; j++) {
      Xty[j] += X[i][j] * y[i];
      for (let k = 0; k < p; k++) XtX[j][k] += X[i][j] * X[i][k];
    }
  }
  for (let j = 1; j < p; j++) XtX[j][j] += lambda;
  const coef = solve(XtX, Xty);
  let ss = 0;
  for (let i = 0; i < n; i++) {
    let yhat = 0;
    for (let j = 0; j < p; j++) yhat += coef[j] * X[i][j];
    ss += (y[i] - yhat) ** 2;
  }
  return { coef, residualSd: Math.sqrt(ss / Math.max(1, n - p)) };
}

export const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i], 0);
