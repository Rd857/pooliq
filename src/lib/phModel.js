// src/lib/phModel.js
//
// pH drift from CO2 outgassing. Pool water holds far more CO2 than air at
// equilibrium, so it degasses and pH climbs toward the equilibrium pH (≈ 8.4
// at TA 100) without TA changing. Acid doses lower TA with carbon unchanged,
// which restarts the climb.
//
//   dDIC/dt = −k_aer · (CO2 − CO2_eq)
//
// k_aer (1/h) lumps surface area, waterfalls, swimmers and wind. It's the only
// fitted parameter — everything else is equilibrium chemistry
// (src/lib/carbonate.js) — and it's calibrated the same way as the chlorine
// model: log-normal prior, Student-t likelihood, prequential scoring.

import {
  co2Equilibrium,
  co2FromState,
  phFromState,
  stateFromPhTa,
} from "./carbonate";
import { mixtureQuantiles } from "./chlorineModel";
import { HOUR_MS } from "./weatherHourly";

/** Median ≈ 0.1 pH/day of rise at TA 100 from pH 7.5. */
export const K_AER_PRIOR = { median: 0.01, sigmaLog: 1.0 };
export const PH_TEST_SD = 0.1;
export const PH_PROCESS_VAR_PER_H = 0.0025 / 24; // ≈ (0.05)² per day
/** Phenol red reads 6.8–8.2; readings at either end are really "≤" or "≥". */
export const PH_KIT_RANGE = [6.8, 8.2];
export const PH_HIGH = 7.8;

const GRID_N = 41;
const K_AER_RANGE = [0.0005, 0.5];
const SAMPLE_COUNT = 100;
const MIN_INTERVAL_H = 0.5;
const MAX_INTERVAL_H = 14 * 24;

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

const GRID = (() => {
  const a = Math.log(K_AER_RANGE[0]);
  const step = (Math.log(K_AER_RANGE[1]) - a) / (GRID_N - 1);
  return Array.from({ length: GRID_N }, (_, i) => Math.exp(a + i * step));
})();

function cutPoints(startMs, endMs, doses, extraCuts) {
  const cuts = new Set([startMs, endMs]);
  for (let h = Math.ceil(startMs / HOUR_MS) * HOUR_MS; h < endMs; h += HOUR_MS) cuts.add(h);
  doses.forEach((d) => d.atMs >= startMs && d.atMs < endMs && cuts.add(d.atMs));
  extraCuts.forEach((t) => t > startMs && t < endMs && cuts.add(t));
  return [...cuts].sort((a, b) => a - b);
}

/**
 * @param {object} p
 * @param {object} p.env - {cyaAt(t), tempCAt(t), I}
 * @param {Array} p.carbDoses - [{atMs, dTa, dDic}]
 * @returns {{pH: number, ta: number}}
 */
export function simulatePH({
  startMs,
  endMs,
  pH0,
  ta0,
  env,
  carbDoses = [],
  kAer,
  extraCuts = [],
  onStep,
}) {
  const I = env.I;
  const doses = carbDoses.filter((d) => d.atMs >= startMs && d.atMs < endMs);
  const pts = cutPoints(startMs, endMs, doses, extraCuts);
  let ta = ta0;
  let pH = pH0;
  let { dic } = stateFromPhTa({
    pH,
    ta,
    cya: env.cyaAt(startMs) || 0,
    tempC: env.tempCAt(startMs),
    I,
  });
  let di = 0;
  const sorted = doses.sort((a, b) => a.atMs - b.atMs);
  for (let j = 0; j + 1 < pts.length; j++) {
    const a = pts[j];
    const b = pts[j + 1];
    while (di < sorted.length && sorted[di].atMs === a) {
      ta += sorted[di].dTa;
      dic += sorted[di].dDic;
      di += 1;
    }
    const mid = (a + b) / 2;
    const tempC = env.tempCAt(mid);
    const cya = env.cyaAt(mid) || 0;
    pH = phFromState({ dic, ta, cya, tempC, I, guess: pH });
    const f = co2FromState({ dic, pH, tempC, I }) / dic;
    const dicEq = co2Equilibrium(tempC) / f;
    dic = dicEq + (dic - dicEq) * Math.exp((-kAer * f * (b - a)) / HOUR_MS);
    pH = phFromState({ dic, ta, cya, tempC, I, guess: pH });
    if (onStep) onStep(j, pH, ta, b);
  }
  return { pH, ta };
}

const censored = (pH) => pH <= PH_KIT_RANGE[0] || pH >= PH_KIT_RANGE[1];

/**
 * One interval per pair of consecutive pH readings with a known TA.
 * @param {function} taAt - TA (ppm) at a time, including dose effects
 */
export function buildPHIntervals({ readings, taAt, carbDoses }) {
  const pts = readings.filter((r) => isNum(r.t) && isNum(r.pH)).sort((a, b) => a.t - b.t);
  const out = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const p = pts[i];
    const q = pts[i + 1];
    const hours = (q.t - p.t) / HOUR_MS;
    if (hours < MIN_INTERVAL_H || hours > MAX_INTERVAL_H) continue;
    const ta0 = taAt(p.t);
    const flags = [];
    if (!isNum(ta0)) flags.push("no_ta");
    if (censored(p.pH) || censored(q.pH)) flags.push("ph_off_kit_scale");
    out.push({
      startMs: p.t,
      endMs: q.t,
      hours,
      pH0: p.pH,
      pH1: q.pH,
      ta0,
      doseCount: carbDoses.filter((d) => d.atMs >= p.t && d.atMs < q.t).length,
      flags,
      usable: flags.length === 0,
    });
  }
  return out;
}

const tLogLik = (y, mu, s) => {
  const r = (y - mu) / s;
  return -Math.log(s) - 2.5 * Math.log(1 + (r * r) / 4);
};

function normalizeLog(logW) {
  const max = Math.max(...logW);
  const w = logW.map((v) => Math.exp(v - max));
  const sum = w.reduce((a, b) => a + b, 0);
  return w.map((v) => v / sum);
}

function quantile(values, weights, q) {
  let cum = 0;
  for (let i = 0; i < values.length; i++) {
    cum += weights[i];
    if (cum >= q) return values[i];
  }
  return values[values.length - 1];
}

/** Posterior over k_aer with out-of-sample predictions for each interval. */
export function fitPH(intervals, env, carbDoses) {
  const logPost = GRID.map(
    (k) => -0.5 * ((Math.log(k) - Math.log(K_AER_PRIOR.median)) / K_AER_PRIOR.sigmaLog) ** 2
  );
  const used = intervals.filter((iv) => iv.usable).sort((a, b) => a.startMs - b.startMs);
  const predictions = [];
  for (const iv of used) {
    const mu = GRID.map(
      (kAer) =>
        simulatePH({
          startMs: iv.startMs,
          endMs: iv.endMs,
          pH0: iv.pH0,
          ta0: iv.ta0,
          env,
          carbDoses,
          kAer,
        }).pH
    );
    const s = Math.sqrt(2 * PH_TEST_SD ** 2 + PH_PROCESS_VAR_PER_H * iv.hours);
    const sd = mu.map(() => s);
    const w = normalizeLog(logPost);
    const [lo, median, hi] = mixtureQuantiles(w, mu, sd, [0.05, 0.5, 0.95]);
    predictions.push({ startMs: iv.startMs, endMs: iv.endMs, actual: iv.pH1, median, lo, hi });
    mu.forEach((m, g) => (logPost[g] += tLogLik(iv.pH1, m, s)));
  }
  const w = normalizeLog(logPost);
  const lo = quantile(GRID, w, 0.05);
  const median = quantile(GRID, w, 0.5);
  const hi = quantile(GRID, w, 0.95);
  const samples = [];
  let cum = w[0];
  let i = 0;
  for (let k = 0; k < SAMPLE_COUNT; k++) {
    const u = (k + 0.5) / SAMPLE_COUNT;
    while (u > cum && i < GRID_N - 1) cum += w[++i];
    samples.push(GRID[i]);
  }
  const scored = predictions;
  return {
    samples: { kAer: samples },
    summary: {
      n: used.length,
      status: used.length === 0 ? "prior" : hi / lo < 3 ? "calibrated" : "learning",
      kAer: { median, lo, hi },
      mae: scored.length
        ? scored.reduce((s2, p) => s2 + Math.abs(p.actual - p.median), 0) / scored.length
        : null,
    },
    predictions,
  };
}

/**
 * pH path from the last pH reading through now to `horizonH` ahead, with
 * 10/50/90% bands over k_aer samples.
 */
export function forecastPH({ pH0, ta0, startMs, nowMs, horizonH = 72, env, carbDoses, samples }) {
  const endMs = Math.max(nowMs, startMs) + horizonH * HOUR_MS;
  const S = samples.kAer.length;
  const times = [];
  const paths = [];
  let taNow = ta0;
  samples.kAer.forEach((kAer, s) => {
    const path = [];
    simulatePH({
      startMs,
      endMs,
      pH0,
      ta0,
      env,
      carbDoses,
      kAer,
      extraCuts: [nowMs],
      onStep: (j, pH, ta, t) => {
        path.push(pH);
        if (s === 0) {
          times.push(t);
          if (t <= nowMs) taNow = ta;
        }
      },
    });
    paths.push(path);
  });
  const w = new Array(S).fill(1 / S);
  const points = [{ t: startMs, p10: pH0, p50: pH0, p90: pH0 }];
  times.forEach((t, j) => {
    const sd = Math.sqrt(PH_TEST_SD ** 2 + PH_PROCESS_VAR_PER_H * ((t - startMs) / HOUR_MS));
    const mu = paths.map((p) => p[j]);
    const [p10, p50, p90] = mixtureQuantiles(w, mu, mu.map(() => sd), [0.1, 0.5, 0.9]);
    points.push({ t, p10, p50, p90 });
  });
  const now = points.find((p) => p.t >= nowMs) || points[points.length - 1];
  const high = points.find((p) => p.t >= nowMs && p.p50 >= PH_HIGH);
  return { points, now, taNow, highAtMs: high ? high.t : null };
}
