// Hourly weather series built from the station's ~5-minute readings. Every
// model runs on this: [{t (UTC hour start, ms), uv, solar, tempf, rain, n}].

export const HOUR_MS = 3600 * 1000;
export const DAY_MS = 24 * HOUR_MS;
const EXPECTED_PER_HOUR = 12;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * Samples ({t, uv, solar, tempf, dailyrainin}) → one record per UTC hour.
 * Rain comes from the station's daily counter, which resets at midnight.
 */
export function toHourly(samples) {
  const sorted = (samples || []).filter((s) => isNum(s.t)).sort((a, b) => a.t - b.t);
  const byHour = new Map();
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i];
    const h = Math.floor(s.t / HOUR_MS) * HOUR_MS;
    let rec = byHour.get(h);
    if (!rec) {
      rec = { uv: [], solar: [], tempf: [], rain: 0, n: 0 };
      byHour.set(h, rec);
    }
    rec.n += 1;
    if (isNum(s.uv)) rec.uv.push(s.uv);
    if (isNum(s.solar)) rec.solar.push(s.solar);
    if (isNum(s.tempf)) rec.tempf.push(s.tempf);
    const prev = sorted[i - 1];
    if (prev && isNum(s.dailyrainin) && isNum(prev.dailyrainin)) {
      const d = s.dailyrainin - prev.dailyrainin;
      rec.rain += d >= 0 ? d : s.dailyrainin;
    }
  }
  return [...byHour.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, r]) => ({
      t,
      uv: mean(r.uv),
      solar: mean(r.solar),
      tempf: mean(r.tempf),
      rain: r.rain,
      n: r.n,
    }));
}

/** True when an hourly record has enough readings to trust. */
export const isCovered = (rec) => !!rec && rec.n >= EXPECTED_PER_HOUR / 2 && isNum(rec.uv);

const localHour = (t) => new Date(t).getHours();

/**
 * Typical UV for each local hour over the `days` before `endMs`. Falls back
 * to a clear-sky Florida curve for hours with no data.
 * @returns {number[]} 24 values, index = local hour
 */
export function uvProfile(hourly, endMs, days = 7) {
  const sums = new Array(24).fill(0);
  const counts = new Array(24).fill(0);
  const from = endMs - days * DAY_MS;
  for (const rec of hourly || []) {
    if (rec.t < from || rec.t >= endMs || !isCovered(rec)) continue;
    const h = localHour(rec.t);
    sums[h] += rec.uv;
    counts[h] += 1;
  }
  return sums.map((s, h) => (counts[h] ? s / counts[h] : clearSkyUv(h + 0.5)));
}

// Clear-sky UV index for central Florida, peak ~9 at 13:30 local.
function clearSkyUv(localHourFloat) {
  const x = (localHourFloat - 7.25) / 12.5;
  return x > 0 && x < 1 ? 9 * Math.sin(Math.PI * x) : 0;
}

/**
 * UV lookup for any time: measured hour when covered, else the profile
 * value. `known` is false only for uncovered daylight hours (night is 0).
 */
export function makeUvLookup(hourly, profile) {
  const byHour = new Map((hourly || []).map((r) => [r.t, r]));
  return (t) => {
    const h = Math.floor(t / HOUR_MS) * HOUR_MS;
    const rec = byHour.get(h);
    if (isCovered(rec)) return { uv: rec.uv, known: true, rain: rec.rain || 0 };
    const p = profile[localHour(t)];
    return { uv: p, known: p < 0.05, rain: 0 };
  };
}
