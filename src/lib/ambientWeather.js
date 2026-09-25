// src/lib/ambientWeather.js
//
// Fetches current conditions from the pooliq-weather Cloudflare Worker
// proxy (see workers/pooliq-weather/index.js), which in turn proxies the
// Ambient Weather /v1/devices endpoint. We never call Ambient Weather
// directly from the browser — the Worker holds the real API keys server-side.
//
// This module is defensive: if REACT_APP_WEATHER_WORKER_URL is unset, or
// the fetch fails/times out/returns bad data, we resolve to an "unavailable"
// state rather than throwing, so Dashboard.jsx can render a friendly
// "Weather unavailable" message instead of crashing.

const WORKER_URL = process.env.REACT_APP_WEATHER_WORKER_URL;

/** Consider weather data stale if the last station update is older than this. */
export const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

/**
 * @typedef {object} WeatherState
 * @property {boolean} available - false if unconfigured/unreachable/malformed
 * @property {string} [reason] - human-readable reason when unavailable
 * @property {number} [uv] - UV Index, 0-11
 * @property {number} [solarradiation] - W/m^2
 * @property {number} [tempf] - outdoor temp, F
 * @property {number} [dailyrainin] - inches of rain today
 * @property {number} [rainratein] - in/hr
 * @property {number} [humidity] - percent
 * @property {number} [windspeedmph]
 * @property {number} [dateutc] - unix ms of last station update
 * @property {boolean} [stale] - true if dateutc is older than STALE_THRESHOLD_MS
 */

/** @returns {WeatherState} */
function unavailable(reason) {
  return { available: false, reason };
}

/**
 * Fetch and normalize current weather conditions.
 * @returns {Promise<WeatherState>}
 */
export async function getCurrentWeather() {
  if (!WORKER_URL) {
    return unavailable(
      "REACT_APP_WEATHER_WORKER_URL is not set. Deploy the Cloudflare " +
        "Worker in workers/pooliq-weather and point this env var at it."
    );
  }

  let response;
  try {
    response = await fetch(WORKER_URL);
  } catch (err) {
    return unavailable(`Network error reaching weather worker: ${err.message}`);
  }

  if (!response.ok) {
    return unavailable(`Weather worker responded with ${response.status}`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch (err) {
    return unavailable("Weather worker returned invalid JSON.");
  }

  // Ambient Weather /v1/devices returns an array of devices, each with a
  // `lastData` object holding the current readings.
  if (!Array.isArray(payload) || payload.length === 0) {
    return unavailable("Weather worker returned no devices.");
  }

  const device = payload[0];
  const lastData = device && device.lastData;

  if (!lastData) {
    return unavailable("Weather worker response is missing lastData.");
  }

  const dateutc = lastData.dateutc;
  const stale =
    typeof dateutc === "number"
      ? Date.now() - dateutc > STALE_THRESHOLD_MS
      : undefined;

  return {
    available: true,
    uv: lastData.uv,
    solarradiation: lastData.solarradiation,
    tempf: lastData.tempf,
    dailyrainin: lastData.dailyrainin,
    rainratein: lastData.rainratein,
    humidity: lastData.humidity,
    windspeedmph: lastData.windspeedmph,
    dateutc,
    stale,
  };
}

function normalizeSample(r) {
  if (!r || typeof r.dateutc !== "number") return null;
  return {
    t: r.dateutc,
    uv: r.uv,
    solar: r.solarradiation,
    tempf: r.tempf,
    dailyrainin: r.dailyrainin,
  };
}

/**
 * Every station reading (~every 5 min) for one UTC day, via the Worker's
 * edge-cached /history route.
 *
 * @param {string} day - "YYYY-MM-DD" (UTC)
 * @returns {Promise<Array<{t, uv, solar, tempf, dailyrainin}>>}
 */
export async function fetchHistoryDay(day) {
  if (!WORKER_URL) throw new Error("Weather worker not configured.");
  const url = new URL("/history", WORKER_URL);
  url.searchParams.set("day", day);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Weather history for ${day}: HTTP ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error(`Weather history for ${day}: bad response`);
  return rows.map(normalizeSample).filter(Boolean);
}

export const isWeatherConfigured = Boolean(WORKER_URL);
