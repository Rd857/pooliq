import React, { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { db } from "../lib/firebase";
import { RANGES } from "../lib/ranges";

const RANGE_PRESETS = [
  { id: "30", label: "30 days", days: 30 },
  { id: "90", label: "90 days", days: 90 },
  { id: "all", label: "All time", days: null },
];

function withinRange(dateStr, days) {
  if (!days) return true;
  const entryDate = new Date(dateStr);
  if (Number.isNaN(entryDate.getTime())) return true;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return entryDate >= cutoff;
}

export default function History() {
  const [logs, setLogs] = useState(undefined); // undefined = loading
  const [error, setError] = useState(null);
  const [rangeId, setRangeId] = useState("30");

  useEffect(() => {
    if (!db) {
      setError("Firestore is not available (Firebase not configured).");
      setLogs([]);
      return undefined;
    }
    const q = query(collection(db, "logs"), orderBy("date", "asc"));
    const unsub = onSnapshot(
      q,
      (snap) => {
        setLogs(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      },
      (err) => {
        setError(err.message || "Failed to load history.");
        setLogs([]);
      }
    );
    return unsub;
  }, []);

  const activeDays = RANGE_PRESETS.find((r) => r.id === rangeId)?.days ?? 30;

  const filtered = useMemo(() => {
    if (!logs) return [];
    return logs
      .filter((l) => withinRange(l.date, activeDays))
      .map((l) => ({
        ...l,
        label: l.date ? l.date.slice(5) : "", // MM-DD
      }));
  }, [logs, activeDays]);

  if (logs === undefined) {
    return <div style={styles.loading}>Loading history…</div>;
  }

  if (error) {
    return <div style={styles.errorBanner}>{error}</div>;
  }

  if (logs.length === 0) {
    return (
      <div style={styles.card}>
        <h2 style={{ marginTop: 0 }}>No history yet</h2>
        <p style={{ color: "var(--piq-text-muted)" }}>
          Log entries will show up here once you've saved a few readings.
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={styles.filterRow}>
        {RANGE_PRESETS.map((r) => (
          <button
            key={r.id}
            onClick={() => setRangeId(r.id)}
            style={{
              ...styles.filterButton,
              ...(rangeId === r.id ? styles.filterButtonActive : {}),
            }}
          >
            {r.label}
          </button>
        ))}
      </div>

      <ChartCard
        title={`Free Chlorine (target ${RANGES.fc.min}–${RANGES.fc.max} ppm)`}
        data={filtered}
        dataKey="fc"
        color="#2E75B6"
        min={RANGES.fc.min}
        max={RANGES.fc.max}
      />

      <ChartCard
        title={`pH (target ${RANGES.pH.min}–${RANGES.pH.max})`}
        data={filtered}
        dataKey="pH"
        color="#8E24AA"
        min={RANGES.pH.min}
        max={RANGES.pH.max}
      />

      <ChartCard
        title="Total Alkalinity (ppm)"
        data={filtered}
        dataKey="ta"
        color="#00897B"
        min={RANGES.ta.min}
        max={RANGES.ta.max}
      />

      <ChartCard
        title="Calcium Hardness (ppm)"
        data={filtered}
        dataKey="ch"
        color="#F4511E"
        min={RANGES.ch.min}
        max={RANGES.ch.max}
      />

      <ChartCard
        title="CYA / Stabilizer (ppm)"
        data={filtered}
        dataKey="cya"
        color="#6D4C41"
        min={RANGES.cya.min}
        max={RANGES.cya.max}
      />

      <DualLineChartCard
        title="Pool Water Temp vs. Ambient Air Temp (°F)"
        data={filtered}
        series={[
          { dataKey: "waterTemp", color: "#2E75B6", name: "Pool Water" },
          { dataKey: "weatherAirTempF", color: "#F4511E", name: "Ambient Air" },
        ]}
      />
    </div>
  );
}

function ChartCard({ title, data, dataKey, color, min, max }) {
  return (
    <div style={styles.card}>
      <div style={styles.sectionTitle}>{title}</div>
      <div style={{ width: "100%", height: 220 }}>
        <ResponsiveContainer>
          <LineChart data={data} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--piq-border)" />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} />
            <YAxis
              domain={[
                (dataMin) => Math.min(dataMin, min) - (max - min) * 0.15,
                (dataMax) => Math.max(dataMax, max) + (max - min) * 0.15,
              ]}
              tick={{ fontSize: 11 }}
            />
            <Tooltip />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Line
              type="monotone"
              dataKey={dataKey}
              stroke={color}
              strokeWidth={2}
              dot={{ r: 3 }}
              connectNulls
              name={title.split(" (")[0]}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function DualLineChartCard({ title, data, series }) {
  return (
    <div style={styles.card}>
      <div style={styles.sectionTitle}>{title}</div>
      <div style={{ width: "100%", height: 220 }}>
        <ResponsiveContainer>
          <LineChart data={data} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--piq-border)" />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {series.map((s) => (
              <Line
                key={s.dataKey}
                type="monotone"
                dataKey={s.dataKey}
                stroke={s.color}
                strokeWidth={2}
                dot={{ r: 3 }}
                connectNulls
                name={s.name}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

const styles = {
  loading: { padding: 24, textAlign: "center", color: "var(--piq-text-muted)" },
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
    marginBottom: 10,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  filterRow: {
    display: "flex",
    gap: 8,
  },
  filterButton: {
    flex: 1,
    border: "1px solid var(--piq-border)",
    background: "var(--piq-card-bg)",
    borderRadius: 10,
    padding: "8px 0",
    fontSize: 13,
    fontWeight: 600,
    color: "var(--piq-text-muted)",
    cursor: "pointer",
  },
  filterButtonActive: {
    background: "var(--piq-primary)",
    borderColor: "var(--piq-primary)",
    color: "white",
  },
  errorBanner: {
    background: "var(--piq-red-bg)",
    color: "var(--piq-red)",
    borderRadius: 10,
    padding: "10px 14px",
    fontSize: 14,
  },
};
