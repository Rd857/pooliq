// Loads everything the models need (Firestore + weather Worker), runs them,
// and stores fitted parameters in model/current so screens that don't refit
// (Dashboard) reuse the latest calibration.

import { useCallback, useEffect, useState } from "react";
import {
  collection,
  doc,
  documentId,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  setDoc,
  where,
} from "firebase/firestore";
import { db } from "./firebase";
import { fetchHistoryDay } from "./ambientWeather";
import { readingTime } from "./chlorineModel";
import { MODEL_VERSION, runModel, serializeModel, TRAINING_DAYS } from "./forecast";
import { DAY_MS, HOUR_MS, toHourly } from "./weatherHourly";

const MAX_DOCS = 400;
const MAX_GAP_DAYS = 14;
const PROFILE_DAYS = 8;
// Bounds the first backfill; remaining days load on later runs.
const MAX_FETCHES_PER_RUN = 21;

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const modelRef = () => doc(db, "model", "current");

// UTC days covering each training interval, the time since the last reading,
// and the last week (for the forecast's typical-day UV).
function daysNeeded(readingTimes, nowMs) {
  const days = new Set();
  const cover = (a, b) => {
    for (let d = Math.floor(a / DAY_MS) * DAY_MS; d <= b; d += DAY_MS) days.add(utcDay(d));
  };
  const t = readingTimes.filter((x) => x >= nowMs - TRAINING_DAYS * DAY_MS).sort((a, b) => a - b);
  for (let i = 0; i + 1 < t.length; i++) {
    if (t[i + 1] - t[i] <= MAX_GAP_DAYS * DAY_MS) cover(t[i], t[i + 1]);
  }
  const last = readingTimes.length ? Math.max(...readingTimes) : nowMs;
  cover(Math.max(last, nowMs - MAX_GAP_DAYS * DAY_MS), nowMs);
  cover(nowMs - PROFILE_DAYS * DAY_MS, nowMs);
  return [...days].sort();
}

/**
 * Hourly weather for the given UTC days. Archived days come from Firestore
 * (weatherDays/{day}); the rest come from the Worker, and finished days are
 * archived so calibration data outlives the station's own retention.
 */
export async function getHourlyWeather(days) {
  if (!days.length) return [];
  const archived = new Map();
  const snap = await getDocs(
    query(
      collection(db, "weatherDays"),
      where(documentId(), ">=", days[0]),
      where(documentId(), "<=", days[days.length - 1])
    )
  );
  snap.forEach((d) => archived.set(d.id, d.data()));

  const hourly = [];
  let fetches = 0;
  for (const day of days) {
    const saved = archived.get(day);
    if (saved && Array.isArray(saved.hours)) {
      hourly.push(...saved.hours);
      continue;
    }
    if (fetches >= MAX_FETCHES_PER_RUN) continue;
    fetches += 1;
    let hours;
    try {
      hours = toHourly(await fetchHistoryDay(day));
    } catch (err) {
      console.warn(err.message);
      continue;
    }
    hourly.push(...hours);
    const finished = Date.now() > Date.parse(`${day}T00:00:00Z`) + DAY_MS + HOUR_MS;
    if (finished && hours.length) {
      setDoc(doc(db, "weatherDays", day), {
        day,
        hours,
        archivedAt: new Date().toISOString(),
      }).catch((err) => console.warn("Weather archive write failed:", err));
    }
  }
  return hourly.sort((a, b) => a.t - b.t);
}

/** Recent logs, doses, config, stored model and the weather they span. */
export async function loadModelInputs() {
  const nowMs = Date.now();
  const recent = (name) =>
    getDocs(query(collection(db, name), orderBy("createdAt", "desc"), limit(MAX_DOCS)));
  const [logSnap, doseSnap, configSnap, modelSnap] = await Promise.all([
    recent("logs"),
    recent("doses"),
    getDoc(doc(db, "config", "pool")),
    getDoc(modelRef()),
  ]);
  const logs = logSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const doseDocs = doseSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const times = logs.map((l) => readingTime(l)).filter(Boolean).map((d) => d.getTime());
  const hourly = await getHourlyWeather(daysNeeded(times, nowMs));
  return {
    nowMs,
    logs,
    doseDocs,
    hourly,
    config: configSnap.exists() ? configSnap.data() : {},
    stored: modelSnap.exists() ? modelSnap.data() : null,
  };
}

const hasStored = (stored) => stored && stored.version === MODEL_VERSION;

/** Refit on all current data and store the parameters. */
export async function refitModel() {
  const inputs = await loadModelInputs();
  const result = runModel({ ...inputs, fit: true });
  await setDoc(modelRef(), serializeModel(result));
  return { inputs, result };
}

/**
 * Loads data and runs the models. `fit: false` reuses stored parameters
 * (fast); it still fits once if nothing has been stored yet.
 */
export function useModel({ fit }) {
  const [state, setState] = useState({ status: "loading" });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!db) {
      setState({ status: "error", error: new Error("Firebase not configured.") });
      return undefined;
    }
    let cancelled = false;
    setState((s) => (s.status === "ready" ? { ...s, refreshing: true } : { status: "loading" }));
    (async () => {
      try {
        const inputs = await loadModelInputs();
        // Let the loading state paint before the synchronous fit.
        await new Promise((r) => setTimeout(r, 0));
        const doFit = fit || !hasStored(inputs.stored);
        const result = runModel({ ...inputs, fit: doFit });
        if (doFit) {
          setDoc(modelRef(), serializeModel(result)).catch((err) =>
            console.warn("Model save failed:", err)
          );
        }
        if (!cancelled) setState({ status: "ready", inputs, result });
      } catch (error) {
        if (!cancelled) setState({ status: "error", error });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fit, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, refresh };
}
