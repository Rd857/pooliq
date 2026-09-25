// src/lib/chlorineModel.js
//
// Free-chlorine model: the calibration model's structure (organic baseline +
// UV photolysis + doses), solved exactly and calibrated by Bayesian inference.
//
//   dC/dt = −k_uv · S(CYA) · UV(t) · C  −  k_org · Q10^((T − 80°F)/10°C)
//
// • UV photolysis is first-order in C and driven by the station's UV index.
//   S(CYA) = φ(CYA)/φ(40), φ(x) = 1/(1 + x/2 ppm): a single-site binding
//   approximation for CYA shielding (unstabilized chlorine photolyzes ~20×
//   faster than at CYA 40). The screen's UV transmission can't be separated
//   from k_uv using pool data, so it only sets k_uv's prior (× 0.6).
// • Organic demand is zero-order (ppm/h), day and night, with a Q10 = 2
//   temperature correction — the quantity an overnight loss test measures.
// • Doses add instantly. Each segment (≤ 1 h) is solved in closed form,
//   C(t+Δt) = (C + b/a)·e^(−aΔt) − b/a, clamped at 0.
//
// Calibration: k_org and k_uv get log-normal priors and are updated on every
// pair of consecutive FC readings with a Student-t likelihood (robust to the
// odd bad test). Its scale combines test error at both ends (the start error
// propagated through the decay), dose-strength uncertainty and unmodeled
// day-to-day load. Intervals are scored before they update the posterior,
// so the reported accuracy is honest out-of-sample forecasting.

import { fromLocalDateTime, toDate } from "./time";
import { HOUR_MS } from "./weatherHourly";

// ---- Constants and priors ---------------------------------------------------

export const FC_FLOOR_PPM = 1.0;
/** Minimum FC as a fraction of CYA; CYA binds most FC (CYA 40 → FC 3). */
export const MIN_FC_CYA_RATIO = 0.075;
/** Typical FC target as a fraction of CYA. */
export const TARGET_FC_CYA_RATIO = 0.115;

/** Organic demand, ppm/h at 80 °F. Median ≈ 0.18 ppm over a 12 h night. */
export const K_ORG_PRIOR = { median: 0.015, sigmaLog: 0.9 };
/** UV photolysis per UV-index-hour at CYA 40, open sky. */
export const K_UV_OPEN_PRIOR = { median: 0.01, sigmaLog: 0.9 };
/** Screen enclosures pass ~50–70% of UV. */
export const SCREEN_TRANSMISSION = 0.6;
export const Q10_ORG = 2;
export const T_REF_F = 80;
export const CYA_REF = 40;
export const CYA_HALF_BINDING = 2;

/** FC test error, ppm (FAS-DPD reads in 0.2–0.5 ppm steps). */
export const FC_TEST_SD = 0.25;
/** Unmodeled load (swimmers, debris): variance per hour, ≈ (0.3 ppm)² per day. */
export const FC_PROCESS_VAR_PER_H = 0.09 / 24;
/** Liquid chlorine strength varies with age: ±15%. */
export const DOSE_CV = 0.15;

const T_NU = 4;
const GRID_N = 49;
const K_ORG_RANGE = [0.0005, 0.5];
const K_UV_RANGE = [0.0003, 0.3];
const SAMPLE_COUNT = 200;
const MIN_INTERVAL_H = 0.5;
const MAX_INTERVAL_H = 14 * 24;
const UNLOGGED_DOSE_RISE_PPM = 0.5;
const MIN_WEATHER_COVERAGE = 0.8;
const HEAVY_RAIN_IN = 0.25;

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

// ---- Small helpers ------------------------------------------------------------

/** When a reading was taken: the form's local date/time, else write time. */
export function readingTime(log) {
  if (!log) return null;
  return fromLocalDateTime(log.date, log.time) || toDate(log.createdAt);
}

/** FC floor: warranty minimum or the CYA-driven minimum, whichever is higher. */
export function practicalFloor(cya) {
  return isNum(cya) && cya > 0
    ? Math.max(FC_FLOOR_PPM, MIN_FC_CYA_RATIO * cya)
    : FC_FLOOR_PPM;
}

const phi = (cya) => 1 / (1 + Math.max(0, cya) / CYA_HALF_BINDING);

/** UV-rate multiplier relative to CYA 40 (1 when CYA is unknown). */
export function cyaShield(cya) {
  return isNum(cya) ? phi(cya) / phi(CYA_REF) : 1;
}

/** Organic-demand multiplier relative to 80 °F (1 when temp is unknown). */
export function tempFactor(tempF) {
  if (!isNum(tempF)) return 1;
  return Math.pow(Q10_ORG, (((tempF - T_REF_F) * 5) / 9) / 10);
}

function logspace(lo, hi, n) {
  const a = Math.log(lo);
  const step = (Math.log(hi) - a) / (n - 1);
  return Array.from({ length: n }, (_, i) => Math.exp(a + i * step));
}

// Abramowitz & Stegun 7.1.26 (|error| < 1.5e-7).
function normCdf(z) {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf =
    1 -
    t *
      (0.254829592 +
        t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) *
      Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

function tLogLik(y, mu, s) {
  const r = (y - mu) / s;
  return -Math.log(s) - ((T_NU + 1) / 2) * Math.log(1 + (r * r) / T_NU);
}

function normalizeLog(logW) {
  let max = -Infinity;
  for (let i = 0; i < logW.length; i++) if (logW[i] > max) max = logW[i];
  const w = new Float64Array(logW.length);
  let sum = 0;
  for (let i = 0; i < logW.length; i++) {
    w[i] = Math.exp(logW[i] - max);
    sum += w[i];
  }
  for (let i = 0; i < w.length; i++) w[i] /= sum;
  return w;
}

/**
 * Quantiles of a Gaussian mixture (weights sum to 1). Components with
 * negligible weight are skipped.
 */
export function mixtureQuantiles(w, mu, sd, qs, lowerBound = -Infinity) {
  let maxW = 0;
  for (let i = 0; i < w.length; i++) if (w[i] > maxW) maxW = w[i];
  const idx = [];
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < w.length; i++) {
    if (w[i] < maxW * 1e-6) continue;
    idx.push(i);
    lo = Math.min(lo, mu[i] - 6 * sd[i]);
    hi = Math.max(hi, mu[i] + 6 * sd[i]);
  }
  let total = 0;
  idx.forEach((i) => (total += w[i]));
  const cdf = (x) => {
    let s = 0;
    for (const i of idx) s += w[i] * normCdf((x - mu[i]) / sd[i]);
    return s / total;
  };
  return qs.map((q) => {
    let a = lo;
    let b = hi;
    for (let k = 0; k < 40; k++) {
      const m = (a + b) / 2;
      if (cdf(m) < q) a = m;
      else b = m;
    }
    return Math.max(lowerBound, (a + b) / 2);
  });
}

// Systematic resampling of grid points by weight.
function resample(w, count) {
  const out = [];
  let c = w[0];
  let i = 0;
  for (let k = 0; k < count; k++) {
    const u = (k + 0.5) / count;
    while (u > c && i < w.length - 1) c += w[++i];
    out.push(i);
  }
  return out;
}

// ---- Segments ------------------------------------------------------------------

/**
 * Splits [startMs, endMs) at hour boundaries, dose times and `extraCuts`,
 * and precomputes everything that doesn't depend on the rate constants.
 *
 * @param {object} env - {uvAt(t) → {uv, known, rain}, cyaAt(t), tempFAt(t)}
 * @param {Array} fcDoses - [{atMs, ppm}]; a dose at a reading's exact time
 *   counts as added after that reading
 */
export function buildSegments(startMs, endMs, env, fcDoses = [], extraCuts = []) {
  const doses = fcDoses
    .filter((d) => d.atMs >= startMs && d.atMs < endMs && isNum(d.ppm) && d.ppm > 0)
    .sort((a, b) => a.atMs - b.atMs);
  const cuts = new Set([startMs, endMs]);
  for (let h = Math.ceil(startMs / HOUR_MS) * HOUR_MS; h < endMs; h += HOUR_MS) cuts.add(h);
  doses.forEach((d) => cuts.add(d.atMs));
  extraCuts.forEach((t) => t > startMs && t < endMs && cuts.add(t));
  const pts = [...cuts].sort((a, b) => a - b);
  const n = pts.length - 1;

  const seg = {
    startMs,
    endMs,
    n,
    hours: (endMs - startMs) / HOUR_MS,
    tEnd: new Float64Array(n),
    dt: new Float64Array(n),
    uvS: new Float64Array(n),
    tf: new Float64Array(n),
    doseBefore: new Float64Array(n),
    uvHours: 0,
    rainIn: 0,
    dosePpm: 0,
    coverage: 1,
  };
  let knownH = 0;
  let di = 0;
  for (let j = 0; j < n; j++) {
    const a = pts[j];
    const b = pts[j + 1];
    const mid = (a + b) / 2;
    while (di < doses.length && doses[di].atMs === a) {
      seg.doseBefore[j] += doses[di].ppm;
      seg.dosePpm += doses[di].ppm;
      di += 1;
    }
    const w = env.uvAt(mid);
    const dt = (b - a) / HOUR_MS;
    seg.tEnd[j] = b;
    seg.dt[j] = dt;
    seg.uvS[j] = w.uv * cyaShield(env.cyaAt(mid));
    seg.tf[j] = tempFactor(env.tempFAt(mid));
    seg.uvHours += w.uv * dt;
    seg.rainIn += (w.rain || 0) * dt;
    if (w.known) knownH += dt;
  }
  seg.coverage = seg.hours > 0 ? knownH / seg.hours : 1;
  return seg;
}

/**
 * Integrates FC across segments for one (k_org, k_uv).
 * @returns {{c: number, A: number, vd: number}} final FC, ∫a dt (the decay
 *   exponent that damps start-of-interval error), and propagated dose variance
 */
export function simulateSegments(seg, kOrg, kUv, c0, onStep) {
  let c = c0;
  let A = 0;
  let vd = 0;
  for (let j = 0; j < seg.n; j++) {
    const d = seg.doseBefore[j];
    if (d > 0) {
      c += d;
      vd += (DOSE_CV * d) ** 2;
    }
    const a = kUv * seg.uvS[j];
    const b = kOrg * seg.tf[j];
    const dt = seg.dt[j];
    if (a > 1e-12) {
      const e = Math.exp(-a * dt);
      const r = b / a;
      c = Math.max(0, (c + r) * e - r);
      vd *= e * e;
    } else {
      c = Math.max(0, c - b * dt);
    }
    A += a * dt;
    if (onStep) onStep(j, c, A, vd);
  }
  return { c, A, vd };
}

// ---- Calibration intervals -----------------------------------------------------

/**
 * One interval per pair of consecutive FC readings.
 * @param {Array} readings - [{t, fc, id}] (any order)
 */
export function buildFCIntervals({ readings, fcDoses, env }) {
  const pts = readings.filter((r) => isNum(r.t) && isNum(r.fc)).sort((a, b) => a.t - b.t);
  const out = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const p = pts[i];
    const q = pts[i + 1];
    const hours = (q.t - p.t) / HOUR_MS;
    if (hours < MIN_INTERVAL_H || hours > MAX_INTERVAL_H) continue;
    const seg = buildSegments(p.t, q.t, env, fcDoses);
    const flags = [];
    if (seg.dosePpm === 0 && q.fc - p.fc >= UNLOGGED_DOSE_RISE_PPM) {
      flags.push("fc_rose_without_logged_dose");
    }
    if (seg.coverage < MIN_WEATHER_COVERAGE) flags.push("missing_weather");
    if (p.fc <= 0 || q.fc <= 0) flags.push("fc_zero");
    if (seg.rainIn > HEAVY_RAIN_IN) flags.push("heavy_rain");
    const excluding = ["fc_rose_without_logged_dose", "missing_weather", "fc_zero"];
    const oclt =
      seg.dosePpm === 0 &&
      hours >= 6 &&
      hours <= 16 &&
      seg.uvHours <= 0.5 &&
      seg.coverage >= MIN_WEATHER_COVERAGE
        ? { loss: p.fc - q.fc, pass: p.fc - q.fc <= 1.0, ideal: p.fc - q.fc <= 0.5 }
        : null;
    out.push({
      startMs: p.t,
      endMs: q.t,
      hours,
      c0: p.fc,
      c1: q.fc,
      startId: p.id ?? null,
      endId: q.id ?? null,
      seg,
      uvHours: seg.uvHours,
      coverage: seg.coverage,
      rainIn: seg.rainIn,
      dosePpm: seg.dosePpm,
      flags,
      usable: !flags.some((f) => excluding.includes(f)),
      oclt,
    });
  }
  return out;
}

function predictiveSd(hours, A, vd, withEndTest) {
  const test = FC_TEST_SD * FC_TEST_SD;
  return Math.sqrt(
    (withEndTest ? test : 0) + test * Math.exp(-2 * A) + vd + FC_PROCESS_VAR_PER_H * hours
  );
}

// ---- Bayesian fit --------------------------------------------------------------

function priorGrid(screen) {
  const ko = logspace(K_ORG_RANGE[0], K_ORG_RANGE[1], GRID_N);
  const ku = logspace(K_UV_RANGE[0], K_UV_RANGE[1], GRID_N);
  const uvMed = K_UV_OPEN_PRIOR.median * (screen ? SCREEN_TRANSMISSION : 1);
  const logPost = new Float64Array(GRID_N * GRID_N);
  for (let i = 0; i < GRID_N; i++) {
    const zo = (Math.log(ko[i]) - Math.log(K_ORG_PRIOR.median)) / K_ORG_PRIOR.sigmaLog;
    for (let j = 0; j < GRID_N; j++) {
      const zu = (Math.log(ku[j]) - Math.log(uvMed)) / K_UV_OPEN_PRIOR.sigmaLog;
      logPost[i * GRID_N + j] = -0.5 * (zo * zo + zu * zu);
    }
  }
  return { ko, ku, logPost };
}

function marginalQuantiles(values, marginal, qs) {
  const out = [];
  let cum = 0;
  let k = 0;
  for (const q of qs) {
    while (k < marginal.length && cum + marginal[k] < q) cum += marginal[k++];
    const i = Math.min(k, values.length - 1);
    // Interpolate within the cell in log space.
    const frac = marginal[i] > 0 ? (q - cum) / marginal[i] : 0.5;
    const lo = i > 0 ? Math.sqrt(values[i - 1] * values[i]) : values[i];
    const hi = i < values.length - 1 ? Math.sqrt(values[i] * values[i + 1]) : values[i];
    out.push(Math.exp(Math.log(lo) + frac * (Math.log(hi) - Math.log(lo))));
  }
  return out;
}

function summarize(ko, ku, w, n, predictions) {
  const mo = new Float64Array(GRID_N);
  const mu = new Float64Array(GRID_N);
  for (let i = 0; i < GRID_N; i++) {
    for (let j = 0; j < GRID_N; j++) {
      mo[i] += w[i * GRID_N + j];
      mu[j] += w[i * GRID_N + j];
    }
  }
  const [o05, o50, o95] = marginalQuantiles(ko, mo, [0.05, 0.5, 0.95]);
  const [u05, u50, u95] = marginalQuantiles(ku, mu, [0.05, 0.5, 0.95]);
  const narrow = o95 / o05 < 2.5 && u95 / u05 < 2.5;
  const scored = predictions.filter((p) => isNum(p.median));
  return {
    n,
    status: n === 0 ? "prior" : narrow ? "calibrated" : "learning",
    kOrg: { median: o50, lo: o05, hi: o95 },
    kUv: { median: u50, lo: u05, hi: u95 },
    mae: scored.length
      ? scored.reduce((s, p) => s + Math.abs(p.actual - p.median), 0) / scored.length
      : null,
    coverage90: scored.length
      ? scored.filter((p) => p.actual >= p.lo && p.actual <= p.hi).length / scored.length
      : null,
  };
}

/**
 * Posterior over (k_org, k_uv) given usable intervals, oldest first, with a
 * prediction for each interval made before it updated the posterior.
 */
export function fitFC(intervals, { screen = true } = {}) {
  const { ko, ku, logPost } = priorGrid(screen);
  const G = GRID_N * GRID_N;
  const used = intervals.filter((iv) => iv.usable).sort((a, b) => a.startMs - b.startMs);
  const mu = new Float64Array(G);
  const sd = new Float64Array(G);
  const predictions = [];

  for (const iv of used) {
    for (let i = 0; i < GRID_N; i++) {
      for (let j = 0; j < GRID_N; j++) {
        const g = i * GRID_N + j;
        const r = simulateSegments(iv.seg, ko[i], ku[j], iv.c0);
        mu[g] = r.c;
        sd[g] = predictiveSd(iv.hours, r.A, r.vd, true);
      }
    }
    const w = normalizeLog(logPost);
    const [lo, median, hi] = mixtureQuantiles(w, mu, sd, [0.05, 0.5, 0.95], 0);
    predictions.push({
      startMs: iv.startMs,
      endMs: iv.endMs,
      hours: iv.hours,
      start: iv.c0,
      actual: iv.c1,
      median,
      lo,
      hi,
    });
    for (let g = 0; g < G; g++) logPost[g] += tLogLik(iv.c1, mu[g], sd[g]);
  }

  const w = normalizeLog(logPost);
  const picks = resample(w, SAMPLE_COUNT);
  return {
    samples: {
      kOrg: picks.map((g) => ko[Math.floor(g / GRID_N)]),
      kUv: picks.map((g) => ku[g % GRID_N]),
    },
    summary: summarize(ko, ku, w, used.length, predictions),
    predictions,
  };
}

// ---- Forecast ---------------------------------------------------------------------

/**
 * FC path from the last reading through now to `horizonH` hours ahead, as
 * 10/50/90% bands over posterior samples. Future UV comes from `env.uvAt`
 * (recent diurnal profile).
 */
export function forecastFC({ c0, startMs, nowMs, horizonH = 72, env, fcDoses, samples, floor }) {
  const endMs = Math.max(nowMs, startMs) + horizonH * HOUR_MS;
  const seg = buildSegments(startMs, endMs, env, fcDoses, [nowMs]);
  const S = samples.kOrg.length;
  const mu = Array.from({ length: seg.n }, () => new Float64Array(S));
  const sd = Array.from({ length: seg.n }, () => new Float64Array(S));
  for (let s = 0; s < S; s++) {
    simulateSegments(seg, samples.kOrg[s], samples.kUv[s], c0, (j, c, A, vd) => {
      mu[j][s] = c;
      sd[j][s] = predictiveSd((seg.tEnd[j] - startMs) / HOUR_MS, A, vd, false);
    });
  }
  const w = new Float64Array(S).fill(1 / S);
  const points = [{ t: startMs, p10: c0, p50: c0, p90: c0 }];
  for (let j = 0; j < seg.n; j++) {
    const [p10, p50, p90] = mixtureQuantiles(w, mu[j], sd[j], [0.1, 0.5, 0.9], 0);
    points.push({ t: seg.tEnd[j], p10, p50, p90 });
  }
  const now = points.find((p) => p.t >= nowMs) || points[points.length - 1];
  const after = points.filter((p) => p.t >= nowMs);
  const crossing = (key) => {
    const p = after.find((x) => x[key] < floor);
    return p ? p.t : null;
  };
  return {
    points,
    now,
    floor,
    dueMs: crossing("p50"),
    dueEarlyMs: crossing("p10"),
  };
}
