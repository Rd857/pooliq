import React, { useEffect, useState } from "react";
import {
  addDoc,
  collection,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
} from "firebase/firestore";
import { db } from "../lib/firebase";
import { getCurrentWeather } from "../lib/ambientWeather";
import { estimateDashboardState } from "../lib/chlorineModel";

const NUMERIC_FIELDS = [
  { key: "pH", label: "pH", step: 0.1, placeholder: "7.4" },
  { key: "fc", label: "Free Chlorine (ppm)", step: 0.1, placeholder: "2.0" },
  { key: "tc", label: "Total Chlorine (ppm)", step: 0.1, placeholder: "2.0" },
  { key: "ta", label: "Total Alkalinity (ppm)", step: 1, placeholder: "100" },
  { key: "ch", label: "Calcium Hardness (ppm)", step: 1, placeholder: "300" },
  { key: "cya", label: "CYA / Stabilizer (ppm)", step: 1, placeholder: "40" },
  { key: "waterTemp", label: "Water Temp (°F)", step: 1, placeholder: "84" },
];

function todayISO() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function nowTimeString() {
  const d = new Date();
  return d.toTimeString().slice(0, 5);
}

export default function LogEntry({ onSaved }) {
  const [values, setValues] = useState({
    pH: "",
    fc: "",
    tc: "",
    ta: "",
    ch: "",
    cya: "",
    waterTemp: "",
    salt: "",
  });
  const [date, setDate] = useState(todayISO());
  const [time, setTime] = useState(nowTimeString());
  const [testedBy, setTestedBy] = useState("Ryan");
  const [notes, setNotes] = useState("");
  const [optionalOpen, setOptionalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);
  const [lastLog, setLastLog] = useState(null);

  // Track the most recent log both to auto-populate water temp and, at
  // save time, to compare the chlorine-decay model's prediction against
  // what actually got measured (see the `calibration` write in
  // handleSubmit below).
  useEffect(() => {
    if (!db) return undefined;
    const q = query(
      collection(db, "logs"),
      orderBy("createdAt", "desc"),
      limit(1)
    );
    const unsub = onSnapshot(q, (snap) => {
      if (snap.empty) {
        setLastLog(null);
        return;
      }
      const last = snap.docs[0].data();
      setLastLog(last);
      if (last.waterTemp !== undefined && last.waterTemp !== null) {
        setValues((prev) =>
          prev.waterTemp === "" || prev.waterTemp === undefined
            ? { ...prev, waterTemp: String(last.waterTemp) }
            : prev
        );
      }
    });
    return unsub;
  }, []);

  const handleChange = (key) => (e) => {
    setValues((prev) => ({ ...prev, [key]: e.target.value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);

    if (!db) {
      setError("Firestore is not available (Firebase not configured).");
      return;
    }

    setSaving(true);
    try {
      const toNumberOrNull = (v) =>
        v === "" || v === undefined || v === null ? null : Number(v);

      // Snapshot current weather at the moment of logging so the Sheets sync
      // (Cloud Function) can fill in the warranty sheet's weather columns
      // (M-R) with what the conditions actually were at this reading, not
      // just whatever the dashboard happens to show later. Best-effort: if
      // the Worker isn't configured or the fetch fails, weather is just
      // omitted from the doc and the Sheet's M-R cells are left blank.
      const weather = await getCurrentWeather().catch(() => ({
        available: false,
      }));

      await addDoc(collection(db, "logs"), {
        date,
        time,
        pH: toNumberOrNull(values.pH),
        fc: toNumberOrNull(values.fc),
        tc: toNumberOrNull(values.tc),
        ta: toNumberOrNull(values.ta),
        ch: toNumberOrNull(values.ch),
        cya: toNumberOrNull(values.cya),
        salt: toNumberOrNull(values.salt),
        waterTemp: toNumberOrNull(values.waterTemp),
        testedBy: testedBy || "Ryan",
        notes: notes || "",
        weatherAirTempF: weather.available ? weather.tempf ?? null : null,
        weatherHumidityPct: weather.available ? weather.humidity ?? null : null,
        weatherUvIndex: weather.available ? weather.uv ?? null : null,
        weatherRainIn: weather.available ? weather.dailyrainin ?? null : null,
        weatherSolarRad: weather.available
          ? weather.solarradiation ?? null
          : null,
        weatherWindMph: weather.available
          ? weather.windspeedmph ?? null
          : null,
        createdAt: serverTimestamp(),
      });

      // Best-effort model-calibration record: compare what the decay model
      // would have predicted for FC right now (based on the previous log +
      // current weather) against what was actually just measured. Lets
      // History show model-vs-actual accuracy over time without ever
      // blocking the log save itself if this fails or doesn't apply.
      try {
        const actualFC = toNumberOrNull(values.fc);
        if (lastLog && actualFC !== null && weather.available) {
          const prediction = estimateDashboardState({
            lastLog,
            weather,
            now: new Date(),
          });
          if (prediction) {
            await addDoc(collection(db, "calibration"), {
              timestamp: serverTimestamp(),
              actualFC,
              modelFC: prediction.estimatedFC,
              hoursElapsed: prediction.hoursElapsed,
              kTot: prediction.decayRate,
              uvIndex: weather.uv ?? null,
              solarRad: weather.solarradiation ?? null,
              waterTemp: lastLog.waterTemp ?? null,
            });
          }
        }
      } catch (calibrationErr) {
        console.warn(
          "Failed to write calibration record (non-fatal):",
          calibrationErr
        );
      }

      setSaved(true);
      setTimeout(() => {
        setSaved(false);
        if (onSaved) onSaved();
      }, 1200);
    } catch (err) {
      setError(err.message || "Failed to save log entry.");
    } finally {
      setSaving(false);
    }
  };

  if (saved) {
    return (
      <div style={styles.confirmationCard}>
        <div style={{ fontSize: 40 }}>✅</div>
        <div style={{ fontWeight: 700, fontSize: 18, marginTop: 8 }}>
          Logged!
        </div>
        <div style={{ color: "var(--piq-text-muted)", marginTop: 4 }}>
          Returning to dashboard…
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={styles.card}>
        <div style={styles.row}>
          <div style={styles.field}>
            <label style={styles.label}>Date</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              style={styles.input}
              required
            />
          </div>
          <div style={styles.field}>
            <label style={styles.label}>Time</label>
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              style={styles.input}
              required
            />
          </div>
        </div>
      </div>

      <div style={styles.card}>
        <div style={styles.sectionTitle}>Readings</div>
        <div style={styles.grid}>
          {NUMERIC_FIELDS.map((f) => (
            <div style={styles.field} key={f.key}>
              <label style={styles.label}>{f.label}</label>
              <input
                type="number"
                inputMode="decimal"
                step={f.step}
                placeholder={f.placeholder}
                value={values[f.key]}
                onChange={handleChange(f.key)}
                style={styles.bigInput}
              />
            </div>
          ))}
        </div>
      </div>

      <div style={styles.card}>
        <button
          type="button"
          onClick={() => setOptionalOpen((o) => !o)}
          style={styles.disclosureButton}
        >
          {optionalOpen ? "▾" : "▸"} Optional / SWG (Salt)
        </button>
        {optionalOpen && (
          <div style={{ marginTop: 12 }}>
            <div style={styles.field}>
              <label style={styles.label}>Salt (ppm)</label>
              <input
                type="number"
                inputMode="decimal"
                step={10}
                placeholder="n/a — no SWG on this pool"
                value={values.salt}
                onChange={handleChange("salt")}
                style={styles.input}
              />
              <div style={styles.helperText}>
                This pool has no salt water generator. Kept for parity with
                the warranty sheet only — not warranty-flagged.
              </div>
            </div>
          </div>
        )}
      </div>

      <div style={styles.card}>
        <div style={styles.field}>
          <label style={styles.label}>Tested By</label>
          <input
            type="text"
            value={testedBy}
            onChange={(e) => setTestedBy(e.target.value)}
            style={styles.input}
          />
        </div>
        <div style={{ ...styles.field, marginTop: 12 }}>
          <label style={styles.label}>Notes</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            style={styles.textarea}
            rows={3}
            placeholder="Optional notes (backwash, algae, added chemicals, etc.)"
          />
        </div>
      </div>

      {error && <div style={styles.errorBanner}>{error}</div>}

      <button type="submit" disabled={saving} style={styles.submitButton}>
        {saving ? "Saving…" : "Save Log Entry"}
      </button>
    </form>
  );
}

const styles = {
  card: {
    background: "var(--piq-card-bg)",
    border: "1px solid var(--piq-border)",
    borderRadius: 16,
    padding: 18,
    boxShadow: "0 2px 8px rgba(0,0,0,0.04)",
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: 700,
    color: "var(--piq-text-muted)",
    marginBottom: 12,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  row: {
    display: "flex",
    gap: 14,
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 14,
  },
  field: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    flex: 1,
  },
  label: {
    fontSize: 12,
    fontWeight: 600,
    color: "var(--piq-text-muted)",
  },
  input: {
    border: "1px solid var(--piq-border)",
    borderRadius: 10,
    padding: "10px 12px",
    fontSize: 16,
  },
  bigInput: {
    border: "1px solid var(--piq-border)",
    borderRadius: 10,
    padding: "14px 12px",
    fontSize: 20,
    fontWeight: 700,
    color: "var(--piq-primary-dark)",
  },
  textarea: {
    border: "1px solid var(--piq-border)",
    borderRadius: 10,
    padding: "10px 12px",
    fontSize: 15,
    fontFamily: "inherit",
    resize: "vertical",
  },
  disclosureButton: {
    background: "none",
    border: "none",
    padding: 0,
    fontSize: 14,
    fontWeight: 700,
    color: "var(--piq-text-muted)",
    cursor: "pointer",
  },
  helperText: {
    fontSize: 12,
    color: "var(--piq-text-muted)",
    marginTop: 4,
  },
  errorBanner: {
    background: "var(--piq-red-bg)",
    color: "var(--piq-red)",
    borderRadius: 10,
    padding: "10px 14px",
    fontSize: 14,
  },
  submitButton: {
    background: "var(--piq-primary)",
    color: "white",
    border: "none",
    borderRadius: 12,
    padding: "16px",
    fontSize: 17,
    fontWeight: 700,
    cursor: "pointer",
  },
  confirmationCard: {
    textAlign: "center",
    padding: 48,
  },
};
