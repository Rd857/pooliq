import { toCsv } from "./csv";
import { localDateISO, toDate } from "./time";

const iso = (v) => {
  const d = toDate(v);
  return d ? d.toISOString() : "";
};
const round = (v, places = 3) =>
  typeof v === "number" && Number.isFinite(v)
    ? Math.round(v * 10 ** places) / 10 ** places
    : "";
const combined = (tc, fc) =>
  typeof tc === "number" && typeof fc === "number" ? round(tc - fc, 2) : "";

const SPECS = {
  readings: [
    { header: "Date", key: "date" },
    { header: "Time", key: "time" },
    { header: "pH", key: "pH" },
    { header: "Free Chlorine (ppm)", key: "fc" },
    { header: "Total Chlorine (ppm)", key: "tc" },
    { header: "Combined Chlorine (ppm)", get: (r) => combined(r.tc, r.fc) },
    { header: "Total Alkalinity (ppm)", key: "ta" },
    { header: "Calcium Hardness (ppm)", key: "ch" },
    { header: "CYA (ppm)", key: "cya" },
    { header: "Salt (ppm)", key: "salt" },
    { header: "Water Temp (°F)", key: "waterTemp" },
    { header: "Tested By", key: "testedBy" },
    { header: "Notes", key: "notes" },
    { header: "Air Temp (°F)", key: "weatherAirTempF" },
    { header: "Humidity (%)", key: "weatherHumidityPct" },
    { header: "UV Index", key: "weatherUvIndex" },
    { header: "Rain Today (in)", key: "weatherRainIn" },
    { header: "Solar Radiation (W/m²)", key: "weatherSolarRad" },
    { header: "Wind (mph)", key: "weatherWindMph" },
    { header: "Logged At (UTC)", get: (r) => iso(r.createdAt) },
    { header: "ID", key: "id" },
  ],
  doses: [
    { header: "Added At (UTC)", get: (r) => iso(r.at || r.createdAt) },
    { header: "Date", key: "date" },
    { header: "Time", key: "time" },
    { header: "Chemical", key: "chemical" },
    { header: "Adjustment", key: "label" },
    { header: "Amount", key: "amount" },
    { header: "Unit", key: "unit" },
    { header: "Parameter", key: "parameter" },
    { header: "Expected Change", get: (r) => round(r.ppmChange) },
    { header: "Pool Volume (gal)", key: "volumeGallons" },
    { header: "Notes", key: "notes" },
    { header: "ID", key: "id" },
  ],
  cleanings: [
    { header: "Date", key: "date" },
    { header: "Time", key: "time" },
    { header: "Type", key: "type" },
    { header: "Performed By", key: "performedBy" },
    { header: "Notes", key: "notes" },
    { header: "Logged At (UTC)", get: (r) => iso(r.createdAt) },
    { header: "ID", key: "id" },
  ],
  // One row per interval between FC readings (Forecast tab export).
  model: [
    { header: "Start (UTC)", get: (r) => iso(r.startMs) },
    { header: "End (UTC)", get: (r) => iso(r.endMs) },
    { header: "Hours", get: (r) => round(r.hours, 2) },
    { header: "FC Start (ppm)", key: "c0" },
    { header: "FC End (ppm)", key: "c1" },
    { header: "Predicted (ppm)", get: (r) => round(r.prediction && r.prediction.median) },
    { header: "Predicted 5%", get: (r) => round(r.prediction && r.prediction.lo) },
    { header: "Predicted 95%", get: (r) => round(r.prediction && r.prediction.hi) },
    {
      header: "Error (actual − predicted)",
      get: (r) => (r.prediction ? round(r.c1 - r.prediction.median) : ""),
    },
    { header: "UV·h", get: (r) => round(r.uvHours, 2) },
    { header: "Rain (in)", get: (r) => round(r.rainIn, 2) },
    { header: "FC Dosed (ppm)", get: (r) => round(r.dosePpm) },
    { header: "Weather Coverage", get: (r) => round(r.coverage, 3) },
    { header: "Overnight Loss (ppm)", get: (r) => (r.oclt ? round(r.oclt.loss, 2) : "") },
    { header: "Used In Fit", key: "usable" },
    { header: "Flags", get: (r) => (r.flags || []).join("|") },
    { header: "Start Reading ID", key: "startId" },
    { header: "End Reading ID", key: "endId" },
  ],
};

export const EXPORT_KINDS = [
  { id: "readings", label: "Readings" },
  { id: "doses", label: "Doses" },
  { id: "cleanings", label: "Cleanings" },
];

/** @returns {{filename: string, csv: string}} */
export function buildExport(kind, rows) {
  return {
    filename: `pooliq-${kind}-${localDateISO()}.csv`,
    csv: toCsv(rows || [], SPECS[kind]),
  };
}
