// src/lib/chlorineModel.js
//
// ESTIMATED free-chlorine decay model.
//
// Core equation:
//   dC/dt = -(k_b + k_sun * UV + k_s) * C
//   C(t)  = C0 * exp(-(k_b + k_sun * UV + k_s) * t)
//
// C0 = last logged FC reading (ppm)
// t  = hours since that log entry
// UV = current UV index from weather data
//
// All rate constants below are literature-default starting points, NOT
// calibrated to this specific Pebble Sheen pool in Oldsmar, FL. Every value
// this module produces should be labeled "Estimated" in the UI. Phase 3
// (the `calibration` Firestore collection) will let Ryan compare
// actualFC vs modelFC over 2-4 weeks of real readings and tune the
// constants exported here.

// ---- Default rate constants (all in 1/hr) -------------------------------

/** Bulk (background) decay rate, independent of sun/pH. */
export const DEFAULT_K_BULK = 0.02;

/** Solar photolysis coefficient, applied per UV-index unit. */
export const DEFAULT_K_SUN = 0.005;

/** Surface/wall demand loss, plaster & pebble-finish pools. */
export const DEFAULT_K_SURFACE = 0.005;

/** Q10 temperature coefficient for the Arrhenius-style correction on k_b. */
export const DEFAULT_Q10 = 1.5;

/** pKa of HOCl <-> OCl- equilibrium at ~25C, used for pH speciation. */
export const PKA_HOCL = 7.5;

/** Warranty-driven "floor" we solve time-to-reach for. */
export const FC_FLOOR_PPM = 1.0;

// ---- Helpers --------------------------------------------------------------

const fToC = (waterTempF) => ((waterTempF - 32) * 5) / 9;

/**
 * Arrhenius/Q10-style temperature correction applied to the bulk decay rate.
 *
 * k_b_corrected = k_b * Q10 ^ ((waterTempC - 20) / 10)
 *
 * @param {number} kBulk - base bulk decay rate (1/hr), defaults to DEFAULT_K_BULK
 * @param {number} waterTempF - water temperature in Fahrenheit. Falls back to
 *   airTempF if water temp isn't available (both optional; if neither is
 *   given, no correction is applied and kBulk is returned unchanged).
 * @param {number} [airTempF] - fallback air temperature in Fahrenheit.
 * @param {number} [q10] - Q10 coefficient, defaults to DEFAULT_Q10.
 * @returns {number} temperature-corrected bulk decay rate (1/hr)
 */
export function temperatureCorrectedKBulk(
  kBulk = DEFAULT_K_BULK,
  waterTempF,
  airTempF,
  q10 = DEFAULT_Q10
) {
  const tempF =
    waterTempF !== undefined && waterTempF !== null ? waterTempF : airTempF;

  if (tempF === undefined || tempF === null || Number.isNaN(tempF)) {
    return kBulk;
  }

  const tempC = fToC(tempF);
  return kBulk * Math.pow(q10, (tempC - 20) / 10);
}

/**
 * Fraction of total free chlorine present as active HOCl at a given pH.
 * fractionHOCl = 1 / (1 + 10 ^ (pH - pKa))
 *
 * @param {number} pH
 * @param {number} [pKa] - defaults to PKA_HOCL (7.5 @ 25C)
 * @returns {number} fraction in [0, 1]
 */
export function fractionHOCl(pH, pKa = PKA_HOCL) {
  if (pH === undefined || pH === null || Number.isNaN(pH)) return null;
  return 1 / (1 + Math.pow(10, pH - pKa));
}

/**
 * "Effective" (HOCl-active) free chlorine given the raw FC reading and pH.
 */
export function effectiveFC(currentFC, pH) {
  const frac = fractionHOCl(pH);
  if (frac === null || currentFC === undefined || currentFC === null) {
    return null;
  }
  return currentFC * frac;
}

/**
 * Total instantaneous decay rate (1/hr), combining bulk (temp-corrected),
 * solar, and surface terms.
 *
 * @param {object} params
 * @param {number} [params.uv] - current UV index (0-11ish). Treated as 0 if missing.
 * @param {number} [params.waterTempF]
 * @param {number} [params.airTempF]
 * @param {number} [params.kBulk]
 * @param {number} [params.kSun]
 * @param {number} [params.kSurface]
 * @param {number} [params.q10]
 * @returns {number} total decay rate, 1/hr
 */
export function totalDecayRate({
  uv,
  waterTempF,
  airTempF,
  kBulk = DEFAULT_K_BULK,
  kSun = DEFAULT_K_SUN,
  kSurface = DEFAULT_K_SURFACE,
  q10 = DEFAULT_Q10,
} = {}) {
  const kBulkCorrected = temperatureCorrectedKBulk(
    kBulk,
    waterTempF,
    airTempF,
    q10
  );
  const uvSafe = uv === undefined || uv === null || Number.isNaN(uv) ? 0 : uv;
  return kBulkCorrected + kSun * uvSafe + kSurface;
}

/**
 * Estimated current FC given the last logged reading, hours elapsed, and
 * the decay rate composed above.
 *
 * C(t) = C0 * exp(-rate * t)
 *
 * @param {number} c0 - last logged FC (ppm)
 * @param {number} hoursElapsed
 * @param {number} decayRate - 1/hr, from totalDecayRate()
 * @returns {number} estimated FC (ppm), never negative
 */
export function estimateCurrentFC(c0, hoursElapsed, decayRate) {
  if (c0 === undefined || c0 === null || Number.isNaN(c0)) return null;
  if (hoursElapsed < 0) hoursElapsed = 0;
  const estimate = c0 * Math.exp(-decayRate * hoursElapsed);
  return Math.max(0, estimate);
}

/**
 * Hours until FC decays to the warranty floor (default 1.0 ppm), inverting
 * the exponential: t = ln(C0 / floor) / rate.
 *
 * @param {number} c0 - current/last FC reading (ppm)
 * @param {number} decayRate - 1/hr total decay rate
 * @param {number} [floor] - target floor, defaults to FC_FLOOR_PPM (1.0)
 * @returns {number|null} hours until floor is reached, or:
 *   - null if c0 is missing/invalid
 *   - 0 if already at or below the floor
 *   - Infinity if decayRate <= 0 (chlorine isn't decaying, by this model)
 */
export function hoursUntilFloor(c0, decayRate, floor = FC_FLOOR_PPM) {
  if (c0 === undefined || c0 === null || Number.isNaN(c0)) return null;
  if (c0 <= floor) return 0;
  if (!decayRate || decayRate <= 0) return Infinity;
  return Math.log(c0 / floor) / decayRate;
}

/**
 * Rain dilution flag for the UI. We do NOT auto-adjust the decay model for
 * rain — we just expose a boolean so Dashboard can show a warning banner
 * when today's rainfall is meaningful (> 0.25 in).
 *
 * @param {number} dailyrainin - inches of rain today (from ambientWeather.js)
 * @returns {boolean}
 */
export function isRainDilutionLikely(dailyrainin) {
  if (dailyrainin === undefined || dailyrainin === null) return false;
  return dailyrainin > 0.25;
}

/**
 * Convenience all-in-one estimator combining the pieces above. Intended for
 * Dashboard.jsx: given the last log entry and current weather, produce
 * everything the hero card needs.
 *
 * @param {object} params
 * @param {object} params.lastLog - { fc, pH, waterTemp, date, time, createdAt }
 * @param {object} params.weather - { uv, tempf, dailyrainin } (see ambientWeather.js)
 * @param {Date} [params.now] - injectable for testing, defaults to `new Date()`
 * @returns {object|null} null if there is no last log to estimate from
 */
export function estimateDashboardState({ lastLog, weather, now = new Date() }) {
  if (!lastLog || lastLog.fc === undefined || lastLog.fc === null) {
    return null;
  }

  const loggedAt = lastLog.createdAt ? new Date(lastLog.createdAt) : null;
  const hoursElapsed = loggedAt
    ? Math.max(0, (now.getTime() - loggedAt.getTime()) / (1000 * 60 * 60))
    : 0;

  const rate = totalDecayRate({
    uv: weather && weather.uv,
    waterTempF: lastLog.waterTemp,
    airTempF: weather && weather.tempf,
  });

  const estimatedFC = estimateCurrentFC(lastLog.fc, hoursElapsed, rate);
  const hoursToFloor = hoursUntilFloor(estimatedFC, rate);
  const hocl = fractionHOCl(lastLog.pH);
  const effFC = hocl !== null ? estimatedFC * hocl : null;
  const rainWarning = isRainDilutionLikely(weather && weather.dailyrainin);

  return {
    estimatedFC,
    effectiveFC: effFC,
    hoursElapsed,
    hoursToFloor,
    decayRate: rate,
    rainWarning,
  };
}
