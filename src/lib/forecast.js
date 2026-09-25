// src/lib/forecast.js
//
// Runs every model from raw data: readings, doses, hourly station weather and
// pool config in; fitted parameters, calibration diagnostics and a 72-hour
// forecast for each chemical out. Pure — Firestore/Worker I/O lives in
// modelData.js.

import {
  csi,
  doseCarbonateEffect,
  equilibriumPH,
  fToC,
  ionicStrength,
  phAdjustment,
} from "./carbonate";
import {
  buildFCIntervals,
  FC_FLOOR_PPM,
  fitFC,
  forecastFC,
  practicalFloor,
  readingTime,
  TARGET_FC_CYA_RATIO,
} from "./chlorineModel";
import { DOSING_TABLE, normalizeDose } from "./dosing";
import { buildPHIntervals, fitPH, forecastPH } from "./phModel";
import { makeUvLookup, uvProfile } from "./weatherHourly";

export const MODEL_VERSION = 3;
export const FORECAST_HOURS = 72;
export const PH_TARGET = 7.5;
/** Calibrate on recent intervals only — conditions (CYA, season) drift. */
export const TRAINING_DAYS = 60;
const DEFAULT_TEMP_F = 80;
const DAY_MS = 24 * 3600 * 1000;

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * Value at time t = the latest reading at or before t (the first reading, if
 * t is earlier) plus every dose change since that reading.
 */
export function stepTimeline(points, deltas = []) {
  const P = points.filter((p) => isNum(p.t) && isNum(p.v)).sort((a, b) => a.t - b.t);
  const D = deltas.filter((d) => isNum(d.t) && isNum(d.dv)).sort((a, b) => a.t - b.t);
  return (t) => {
    if (!P.length) return null;
    let base = P[0];
    for (const p of P) {
      if (p.t <= t) base = p;
      else break;
    }
    let v = base.v;
    for (const d of D) if (d.t >= base.t && d.t <= t) v += d.dv;
    return Math.max(0, v);
  };
}

/** Linear interpolation between readings, flat beyond the ends. */
export function linearTimeline(points) {
  const P = points.filter((p) => isNum(p.t) && isNum(p.v)).sort((a, b) => a.t - b.t);
  return (t) => {
    if (!P.length) return null;
    if (t <= P[0].t) return P[0].v;
    for (let i = 1; i < P.length; i++) {
      if (t <= P[i].t) {
        const f = (t - P[i - 1].t) / (P[i].t - P[i - 1].t);
        return P[i - 1].v + f * (P[i].v - P[i - 1].v);
      }
    }
    return P[P.length - 1].v;
  };
}

function prepare({ logs, doseDocs, hourly, config, nowMs }) {
  const volume = (config && config.volumeGallons) || null;
  const screen = !(config && config.screenEnclosure === false);

  const readings = (logs || [])
    .map((l) => {
      const d = readingTime(l);
      return d ? { ...l, t: d.getTime() } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.t - b.t);

  const doses = (doseDocs || [])
    .map((d) => normalizeDose(d, volume))
    .filter(Boolean)
    .sort((a, b) => a.atMs - b.atMs);

  const series = (key) => readings.filter((r) => isNum(r[key])).map((r) => ({ t: r.t, v: r[key] }));
  const doseDeltas = (param) =>
    doses.filter((d) => d.parameter === param && isNum(d.ppm)).map((d) => ({ t: d.atMs, dv: d.ppm }));
  const carbDoses = doses
    .map((d) => {
      const e = doseCarbonateEffect(d, volume);
      return e ? { atMs: d.atMs, dTa: e.dTa, dDic: e.dDic } : null;
    })
    .filter(Boolean);

  const cyaAt = stepTimeline(series("cya"), doseDeltas("cya"));
  const chAt = stepTimeline(series("ch"), doseDeltas("ch"));
  const taAt = stepTimeline(
    series("ta"),
    carbDoses.map((d) => ({ t: d.atMs, dv: d.dTa }))
  );
  const tempFAt = linearTimeline(series("waterTemp"));

  const lastOf = (key) => {
    const r = [...readings].reverse().find((x) => isNum(x[key]));
    return r ? { value: r[key], t: r.t } : null;
  };
  const salt = lastOf("salt");
  const tds = (config && config.tdsPpm) || (salt ? salt.value + 300 : 1000);
  const I = ionicStrength(tds);

  const profile = uvProfile(hourly, nowMs);
  const env = { uvAt: makeUvLookup(hourly, profile), cyaAt, tempFAt };
  const phEnv = {
    cyaAt: (t) => cyaAt(t) || 0,
    tempCAt: (t) => fToC(isNum(tempFAt(t)) ? tempFAt(t) : DEFAULT_TEMP_F),
    I,
  };

  return {
    volume,
    screen,
    tds,
    I,
    readings,
    doses,
    fcDoses: doses.filter((d) => d.parameter === "fc" && d.ppm > 0),
    carbDoses,
    cyaAt,
    chAt,
    taAt,
    tempFAt,
    env,
    phEnv,
    lastOf,
  };
}

const usableStored = (stored) => stored && stored.version === MODEL_VERSION;

/**
 * @param {object} p
 * @param {Array} p.logs - log docs (with id)
 * @param {Array} p.doseDocs - dose docs
 * @param {Array} p.hourly - hourly station weather (weatherHourly.js)
 * @param {object} p.config - config/pool
 * @param {boolean} [p.fit] - refit (true) or reuse `stored` parameters
 * @param {object} [p.stored] - serialized model (serializeModel)
 */
export function runModel({
  logs,
  doseDocs,
  hourly,
  config,
  nowMs = Date.now(),
  fit = true,
  stored = null,
  trainingDays = TRAINING_DAYS,
}) {
  const x = prepare({ logs, doseDocs, hourly, config, nowMs });

  const training = x.readings.filter((r) => r.t >= nowMs - trainingDays * DAY_MS);
  const fcIntervals = buildFCIntervals({ readings: training, fcDoses: x.fcDoses, env: x.env });
  const phIntervals = buildPHIntervals({ readings: training, taAt: x.taAt, carbDoses: x.carbDoses });

  const fcFit =
    !fit && usableStored(stored)
      ? {
          samples: { kOrg: stored.fc.kOrg, kUv: stored.fc.kUv },
          summary: stored.fc.summary,
          predictions: [],
        }
      : fitFC(fit ? fcIntervals : [], { screen: x.screen });
  const phFit =
    !fit && usableStored(stored)
      ? { samples: { kAer: stored.ph.kAer }, summary: stored.ph.summary, predictions: [] }
      : fitPH(fit ? phIntervals : [], x.phEnv, x.carbDoses);

  const cyaNow = x.cyaAt(nowMs);
  const floor = practicalFloor(cyaNow);
  const lastFc = [...x.readings].reverse().find((r) => isNum(r.fc));
  const fcForecast = lastFc
    ? forecastFC({
        c0: lastFc.fc,
        startMs: lastFc.t,
        nowMs,
        horizonH: FORECAST_HOURS,
        env: x.env,
        fcDoses: x.fcDoses,
        samples: fcFit.samples,
        floor,
      })
    : null;

  const lastPh = [...x.readings].reverse().find((r) => isNum(r.pH) && isNum(x.taAt(r.t)));
  const phForecast = lastPh
    ? forecastPH({
        pH0: lastPh.pH,
        ta0: x.taAt(lastPh.t),
        startMs: lastPh.t,
        nowMs,
        horizonH: FORECAST_HOURS,
        env: x.phEnv,
        carbDoses: x.carbDoses,
        samples: phFit.samples,
      })
    : null;

  // Chlorine to add now to reach the target.
  const targetFC =
    isNum(cyaNow) && cyaNow > 0
      ? Math.max(floor + 1, TARGET_FC_CYA_RATIO * cyaNow)
      : FC_FLOOR_PPM + 2;
  const fcRule = DOSING_TABLE.find((r) => r.parameter === "fc");
  const chlorineNow =
    fcForecast && x.volume
      ? {
          targetFC,
          amount: Math.max(0, targetFC - fcForecast.now.p50) * fcRule.referenceAmount * (x.volume / 10000),
          unit: fcRule.unit,
          chemical: fcRule.chemical,
        }
      : null;

  const tempNowF = x.tempFAt(nowMs);
  const tempC = fToC(isNum(tempNowF) ? tempNowF : DEFAULT_TEMP_F);
  const taNow = x.taAt(nowMs);
  const chNow = x.chAt(nowMs);
  const pHNow = phForecast ? phForecast.now.p50 : null;
  const pH72 = phForecast ? phForecast.points[phForecast.points.length - 1].p50 : null;
  const water = { ta: taNow, ch: chNow, cya: cyaNow || 0, tempC, I: x.I };
  const csiAt = (pH) => (isNum(pH) && isNum(taNow) && isNum(chNow) ? csi({ pH, ...water }) : null);

  return {
    nowMs,
    inputs: { volume: x.volume, screen: x.screen, tds: x.tds },
    fc: {
      intervals: fcIntervals,
      fit: fcFit,
      forecast: fcForecast,
      floor,
      chlorineNow,
      oclts: fcIntervals.filter((iv) => iv.oclt),
    },
    ph: {
      intervals: phIntervals,
      fit: phFit,
      forecast: phForecast,
      acidNow:
        isNum(pHNow) && isNum(taNow) && x.volume
          ? phAdjustment({ pH: pHNow, ...water, targetPH: PH_TARGET, volumeGal: x.volume })
          : null,
      equilibrium: isNum(taNow) ? equilibriumPH({ ta: taNow, cya: water.cya, tempC, I: x.I }) : null,
    },
    chem: {
      ta: { value: taNow, tested: x.lastOf("ta") },
      ch: { value: chNow, tested: x.lastOf("ch") },
      cya: { value: cyaNow, tested: x.lastOf("cya") },
      waterTemp: { value: tempNowF, tested: x.lastOf("waterTemp") },
      csiNow: csiAt(pHNow),
      csi72: csiAt(pH72),
    },
  };
}

/** Compact, Firestore-safe form of the fitted parameters. */
export function serializeModel(result) {
  return {
    version: MODEL_VERSION,
    fittedAt: new Date(result.nowMs).toISOString(),
    fc: {
      kOrg: result.fc.fit.samples.kOrg,
      kUv: result.fc.fit.samples.kUv,
      summary: result.fc.fit.summary,
    },
    ph: {
      kAer: result.ph.fit.samples.kAer,
      summary: result.ph.fit.summary,
    },
  };
}
