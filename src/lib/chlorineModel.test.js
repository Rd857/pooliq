import {
  buildFCIntervals,
  buildSegments,
  cyaShield,
  fitFC,
  forecastFC,
  practicalFloor,
  readingTime,
  simulateSegments,
  tempFactor,
} from "./chlorineModel";
import { phAdjustment, doseCarbonateEffect, ionicStrength, fToC } from "./carbonate";
import { doseEffect, normalizeDose } from "./dosing";
import { buildPHIntervals, fitPH, simulatePH } from "./phModel";
import { runModel, serializeModel, stepTimeline } from "./forecast";
import { HOUR_MS, makeUvLookup, toHourly, uvProfile } from "./weatherHourly";
import { localDateISO, localTimeHHMM } from "./time";
import { toCsv } from "./csv";

// ---- Synthetic pool -----------------------------------------------------------

function rng(seed) {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
const roundTo = (x, step) => Math.round(x / step) * step;

const START = new Date(2026, 5, 1, 0, 0).getTime(); // June 1, local midnight
const DAYS = 15;

function syntheticHourly(r) {
  const out = [];
  const cloud = Array.from({ length: DAYS + 4 }, () => 0.35 + 0.65 * r());
  for (let h = 0; h < (DAYS + 4) * 24; h++) {
    const t = START + h * HOUR_MS;
    const hr = new Date(t).getHours() + 0.5;
    const x = (hr - 7.25) / 12.5;
    const clear = x > 0 && x < 1 ? 9 * Math.sin(Math.PI * x) : 0;
    out.push({ t, uv: clear * cloud[Math.floor(h / 24)], solar: clear * 100, tempf: 88, rain: 0, n: 12 });
  }
  return out;
}

const TRUE_K_ORG = 0.02;
const TRUE_K_UV = 0.008;

// Readings at 7:00 and 19:30; 2.5 ppm of chlorine after any reading under 3.5.
function syntheticFC(r, hourly) {
  const env = { uvAt: makeUvLookup(hourly, uvProfile(hourly, START)), cyaAt: () => 40, tempFAt: () => 84 };
  const times = [];
  for (let d = 0; d < DAYS; d++) {
    times.push(START + d * 24 * HOUR_MS + 7 * HOUR_MS);
    times.push(START + d * 24 * HOUR_MS + 19.5 * HOUR_MS);
  }
  let c = 5;
  const readings = [];
  const fcDoses = [];
  times.forEach((t, i) => {
    if (i > 0) {
      const seg = buildSegments(times[i - 1], t, env, fcDoses);
      c = simulateSegments(seg, TRUE_K_ORG, TRUE_K_UV, c).c;
    }
    readings.push({ t, fc: Math.max(0, roundTo(c + 0.2 * gauss(r), 0.2)), id: `r${i}` });
    if (c < 3.5) fcDoses.push({ atMs: t + 5 * 60 * 1000, ppm: 2.5 });
  });
  return { env, readings, fcDoses };
}

const close = (a, b, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

// ---- Exact solution ------------------------------------------------------------

describe("segment integration", () => {
  const constEnv = (uv) => ({
    uvAt: () => ({ uv, known: true, rain: 0 }),
    cyaAt: () => 40,
    tempFAt: () => 80,
  });

  test("UV only → first-order exponential", () => {
    const seg = buildSegments(0, 10 * HOUR_MS, constEnv(6));
    close(simulateSegments(seg, 0, 0.01, 4).c, 4 * Math.exp(-0.01 * 6 * 10));
  });

  test("organic only → linear (zero-order) loss, floored at 0", () => {
    const seg = buildSegments(0, 10 * HOUR_MS, constEnv(0));
    close(simulateSegments(seg, 0.05, 0.01, 2).c, 1.5);
    close(simulateSegments(seg, 0.5, 0.01, 2).c, 0);
  });

  test("both → closed-form mixed-order solution", () => {
    const a = 0.01 * 6;
    const b = 0.03;
    const seg = buildSegments(0, 10 * HOUR_MS, constEnv(6));
    close(simulateSegments(seg, b, 0.01, 4).c, (4 + b / a) * Math.exp(-a * 10) - b / a, 1e-9);
  });

  test("a dose adds and then decays with everything else", () => {
    const env = constEnv(0);
    const seg = buildSegments(0, 10 * HOUR_MS, env, [{ atMs: 4 * HOUR_MS, ppm: 2 }]);
    close(simulateSegments(seg, 0.05, 0.01, 3).c, 3 + 2 - 0.05 * 10);
  });

  test("CYA shielding and temperature scale the right terms", () => {
    close(cyaShield(40), 1);
    expect(cyaShield(0)).toBeCloseTo(21);
    expect(cyaShield(20)).toBeGreaterThan(1.5);
    close(tempFactor(80), 1);
    close(tempFactor(80 + 18), 2, 1e-9); // +10 °C doubles demand (Q10 = 2)
    expect(practicalFloor(40)).toBeCloseTo(3);
  });
});

// ---- Calibration ---------------------------------------------------------------

describe("calibration recovers a known pool", () => {
  const r = rng(7);
  const hourly = syntheticHourly(r);
  const { env, readings, fcDoses } = syntheticFC(r, hourly);
  const intervals = buildFCIntervals({ readings, fcDoses, env });
  const fit = fitFC(intervals, { screen: true });

  test("true constants fall inside the 90% intervals", () => {
    const { kOrg, kUv, n } = fit.summary;
    expect(n).toBeGreaterThan(25);
    expect(kOrg.lo).toBeLessThan(TRUE_K_ORG);
    expect(kOrg.hi).toBeGreaterThan(TRUE_K_ORG);
    expect(kUv.lo).toBeLessThan(TRUE_K_UV);
    expect(kUv.hi).toBeGreaterThan(TRUE_K_UV);
    expect(Math.abs(Math.log(kOrg.median / TRUE_K_ORG))).toBeLessThan(0.35);
    expect(Math.abs(Math.log(kUv.median / TRUE_K_UV))).toBeLessThan(0.35);
  });

  test("out-of-sample predictions are within test-kit noise", () => {
    expect(fit.summary.mae).toBeLessThan(0.35);
    expect(fit.summary.coverage90).toBeGreaterThan(0.8);
  });

  test("every undosed overnight interval is recognized as a loss test", () => {
    const nights = intervals.filter((iv) => new Date(iv.startMs).getHours() === 19);
    const undosed = nights.filter((iv) => iv.dosePpm === 0);
    expect(undosed.length).toBeGreaterThan(2);
    undosed.forEach((iv) => {
      expect(iv.oclt).not.toBeNull();
      close(iv.oclt.loss, iv.c0 - iv.c1, 1e-9);
    });
    nights.filter((iv) => iv.dosePpm > 0).forEach((iv) => expect(iv.oclt).toBeNull());
  });

  test("an unexplained rise is flagged and excluded", () => {
    const bad = [...readings];
    bad[5] = { ...bad[5], fc: bad[4].fc + 2 };
    const iv = buildFCIntervals({ readings: bad, fcDoses: [], env }).find((x) => x.endId === "r5");
    expect(iv.flags).toContain("fc_rose_without_logged_dose");
    expect(iv.usable).toBe(false);
  });

  test("forecast bands are ordered and flag when chlorine runs low", () => {
    const last = readings[readings.length - 1];
    const f = forecastFC({
      c0: last.fc,
      startMs: last.t,
      nowMs: last.t + 6 * HOUR_MS,
      env,
      fcDoses: [],
      samples: fit.samples,
      floor: 3,
    });
    f.points.forEach((p) => {
      expect(p.p10).toBeLessThanOrEqual(p.p50 + 1e-9);
      expect(p.p50).toBeLessThanOrEqual(p.p90 + 1e-9);
    });
    expect(f.points[f.points.length - 1].p90 - f.points[f.points.length - 1].p10).toBeGreaterThan(
      f.now.p90 - f.now.p10
    );
    if (last.fc > 3) expect(f.dueMs).not.toBeNull();
  });
});

// ---- pH ------------------------------------------------------------------------

test("pH calibration recovers the aeration rate", () => {
  const r = rng(11);
  const TRUE_K_AER = 0.02;
  const I = ionicStrength(1000);
  const env = { cyaAt: () => 40, tempCAt: () => fToC(84), I };
  const ta0 = 90;
  const carbDoses = [];
  const readings = [];
  let pH = 7.3;
  let ta = ta0;
  let t = START + 7 * HOUR_MS;
  for (let d = 0; d < 12; d++) {
    readings.push({ t, pH: roundTo(pH + 0.08 * gauss(r), 0.1), id: `p${d}` });
    if (pH > 7.7) {
      const acid = phAdjustment({ pH, ta, cya: 40, tempC: fToC(84), I, targetPH: 7.4, volumeGal: 8500 });
      const e = doseCarbonateEffect({ label: "pH (lower)", amount: acid.amount }, 8500);
      carbDoses.push({ atMs: t + 10 * 60 * 1000, ...e });
    }
    const next = t + 24 * HOUR_MS;
    const out = simulatePH({ startMs: t, endMs: next, pH0: pH, ta0: ta, env, carbDoses, kAer: TRUE_K_AER });
    pH = out.pH;
    ta = out.ta;
    t = next;
  }
  const taAt = stepTimeline([{ t: START, v: ta0 }], carbDoses.map((d) => ({ t: d.atMs, dv: d.dTa })));
  const fit = fitPH(buildPHIntervals({ readings, taAt, carbDoses }), env, carbDoses);
  expect(fit.summary.kAer.lo).toBeLessThan(TRUE_K_AER);
  expect(fit.summary.kAer.hi).toBeGreaterThan(TRUE_K_AER);
  expect(carbDoses.length).toBeGreaterThan(0);
});

// ---- End to end ----------------------------------------------------------------

test("runModel produces fits and forecasts from raw app data", () => {
  const r = rng(3);
  const hourly = syntheticHourly(r);
  const { readings, fcDoses } = syntheticFC(r, hourly);
  const logs = readings.map((x, i) => ({
    id: x.id,
    date: localDateISO(new Date(x.t)),
    time: localTimeHHMM(new Date(x.t)),
    fc: x.fc,
    tc: x.fc + 0.2,
    pH: 7.5,
    ta: i === 0 ? 90 : undefined,
    ch: i === 0 ? 350 : undefined,
    cya: i === 0 ? 40 : undefined,
    waterTemp: 84,
  }));
  const volume = 8500;
  const doseDocs = fcDoses.map((d) => ({
    label: "Free Chlorine",
    parameter: "fc",
    amount: d.ppm * 10.4 * (volume / 10000),
    at: new Date(d.atMs).toISOString(),
  }));
  const nowMs = readings[readings.length - 1].t + 6 * HOUR_MS;
  const result = runModel({ logs, doseDocs, hourly, config: { volumeGallons: volume }, nowMs });

  expect(result.fc.fit.summary.n).toBeGreaterThan(25);
  expect(result.fc.forecast.points.length).toBeGreaterThan(70);
  expect(result.fc.floor).toBeCloseTo(3);
  expect(typeof result.chem.csiNow).toBe("number");
  expect(result.ph.forecast).not.toBeNull();
  expect(result.ph.equilibrium).toBeGreaterThan(7.9);

  const stored = serializeModel(result);
  const walk = (v) => {
    if (v === undefined) throw new Error("undefined in serialized model");
    if (Array.isArray(v)) v.forEach((x) => {
      if (Array.isArray(x)) throw new Error("nested array");
      walk(x);
    });
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(stored);

  // Reusing stored parameters gives the same forecast without refitting.
  const reused = runModel({ logs, doseDocs, hourly, config: { volumeGallons: volume }, nowMs, fit: false, stored });
  close(reused.fc.forecast.now.p50, result.fc.forecast.now.p50, 1e-9);
});

// ---- Small utilities -----------------------------------------------------------

test("hourly aggregation averages readings and sums rain across the midnight reset", () => {
  const t0 = START + 3 * HOUR_MS;
  const samples = [
    { t: t0, uv: 2, tempf: 80, dailyrainin: 0.3 },
    { t: t0 + 5 * 60000, uv: 4, tempf: 82, dailyrainin: 0.4 },
    { t: t0 + 10 * 60000, uv: 6, tempf: 84, dailyrainin: 0.05 },
  ];
  const [h] = toHourly(samples);
  expect(h.uv).toBeCloseTo(4);
  expect(h.rain).toBeCloseTo(0.1 + 0.05);
  expect(h.n).toBe(3);
});

test("reading time uses the form's local date/time", () => {
  const d = readingTime({ date: "2026-09-24", time: "21:15", createdAt: new Date(2026, 8, 25, 9) });
  expect([d.getDate(), d.getHours()]).toEqual([24, 21]);
  expect(localDateISO(new Date(2026, 8, 24, 21, 30))).toBe("2026-09-24");
});

test("dose math inverts the dosing table", () => {
  close(doseEffect({ label: "Free Chlorine", amount: 10.4 }, 10000).change, 1, 1e-9);
  const n = normalizeDose(
    { label: "Free Chlorine", parameter: "fc", amount: 8.84, date: "2026-06-01", time: "12:00" },
    8500
  );
  close(n.ppm, 1, 1e-9);
  expect(n.atMs).toBe(new Date(2026, 5, 1, 12, 0).getTime());
});

test("CSV escaping and formula guard", () => {
  const csv = toCsv(
    [{ a: 'say "hi", ok', b: "=SUM(A1)", c: -3, d: null }],
    ["a", "b", "c", "d"].map((k) => ({ header: k.toUpperCase(), key: k }))
  );
  expect(csv).toBe('﻿A,B,C,D\r\n"say ""hi"", ok",\'=SUM(A1),-3,\r\n');
});
