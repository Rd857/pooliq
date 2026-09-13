// src/lib/ranges.js
//
// Pebble Sheen (pebble-finish plaster) warranty target ranges, shared by
// Dashboard, History, and LogEntry for in/out-of-range color coding.
//
// Salt is intentionally NOT included here for warranty flagging — this pool
// has no salt water generator (hasSWG = false), so a salt reading being
// "out of range" isn't meaningful and shouldn't be flagged red/yellow.

export const RANGES = {
  pH: { min: 7.2, max: 7.8, label: "pH", critical: true },
  fc: { min: 1.0, max: 3.0, label: "Free Chlorine", unit: "ppm" },
  tc: { min: 1.0, max: 5.0, label: "Total Chlorine", unit: "ppm" },
  ta: { min: 80, max: 120, label: "Total Alkalinity", unit: "ppm" },
  ch: { min: 200, max: 400, label: "Calcium Hardness", unit: "ppm" },
  cya: { min: 30, max: 50, label: "CYA / Stabilizer", unit: "ppm" },
  waterTemp: { min: 60, max: 104, label: "Water Temp", unit: "°F" },
  // Reference only — not warranty-flagged since hasSWG is false.
  salt: { min: 2700, max: 3400, label: "Salt", unit: "ppm" },
};

/**
 * @param {string} paramKey - key into RANGES (e.g. "pH", "fc")
 * @param {number} value
 * @returns {"in"|"low"|"high"|"unknown"}
 */
export function rangeStatus(paramKey, value) {
  const range = RANGES[paramKey];
  if (!range || value === undefined || value === null || Number.isNaN(value)) {
    return "unknown";
  }
  if (value < range.min) return "low";
  if (value > range.max) return "high";
  return "in";
}

/** Maps a range status to a UI color, matching the Dashboard/History palette. */
export const STATUS_COLOR = {
  in: "#35E0C7", // phosphor teal
  low: "#F2B84B", // amber
  high: "#FF6B6B", // red
  unknown: "#5C8481", // muted
};
