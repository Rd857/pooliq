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
import { RANGES, rangeStatus } from "../lib/ranges";

const RANGE_PRESETS = [
  { id: "30", label: "30 days", days: 30 },
  { id: "90", label: "90 days", days: 90 },
  { id: "all", label: "All time", days: null },
];

const IN_RANGE_PARAMS = ["pH", "fc", "ta", "ch", "cya"];

function withinRange(dateStr, days) {
  if (!days) return true;
  const entryDate = new Date(dateStr);
  if (Number.isNaN(entryDate.getTime())) return true;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return entryDate >= cutoff;
}

function withinRangeDate(date, days) {
  if (!days) return true;
  if (!date || Number.isNaN(date.getTime())) return true;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return date >= cutoff;
}

export default function History() {
  const [logs, setLogs] = useState(undefined); // undefined = loading
  const [calibration, setCalibration] = useState(undefined); // undefined = loading
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

  useEffect(() => {
    if (!db) {
      setCalibration([]);
      return undefined;
    }
    const q = query(collection(db, "calibration"), orderBy("timestamp", "asc"));
    const unsub = onSnapshot(
      q,
      (snap) => setCalibration(snap.docs.map((d) => d.data())),
      () => setCalibration([])
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

  const inRangeStats = useMemo(() => {
    const stats = {};
    IN_RANGE_PARAMS.forEach((p) => {
      const withValue = filtered.filter(
        (l) => l[p] !== undefined && l[p] !== null
      );
      const inRange = withValue.filter(
        (l) => rangeStatus(p, l[p]) === "in"
      );
      stats[p] = {
        pct: withValue.length ? (inRange.length / withValue.length) * 100 : null,
        count: withValue.length,
        inCount: inRange.length,
      };
    });
    return stats;
  }, [filtered]);

  const filteredCalibration = useMemo(() => {
    if (!calibration) return [];
    return calibration
      .filter((c) => {
        const d = c.timestamp && c.timestamp.toDate ? c.timestamp.toDate() : null;
        return withinRangeDate(d, activeDays);
      })
      .map((c) => {
        const d = c.timestamp && c.timestamp.toDate ? c.timestamp.toDate() : null;
        const error =
          c.actualFC !== undefined && c.modelFC !== undefined
            ? c.actualFC - c.modelFC
            : null;
        return {
          ...c,
          error,
          label: d
            ? `${d.getMonth() + 1}/${d.getDate()}`
            : "",
        };
      });
  }, [calibration, activeDays]);

  const calibrationSummary = useMemo(() => {
    const errors = filteredCalibration
      .map((c) => c.error)
      .filter((e) => e !== null && !Number.isNaN(e));
    if (errors.length === 0) return null;
    const meanError = errors.reduce((a, b) => a + b, 0) / errors.length;
    const meanAbsError =
      errors.reduce((a, b) => a + Math.abs(b), 0) / errors.length;
    return { meanError, meanAbsError, count: errors.length };
  }, [filteredCalibration]);

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

      <div style={styles.card}>
        <div style={styles.sectionTitle}>Days In Range</div>
        <div style={styles.inRangeGrid}>
          {IN_RANGE_PARAMS.map((p) => {
            const s = inRangeStats[p];
            return (
              <div key={p} style={styles.inRangeStat}>
                <div style={styles.subMetricLabel}>{RANGES[p].label}</div>
                <div
                  style={{
                    ...styles.inRangePct,
                    color:
                      s.pct === null
                        ? "var(--piq-text-muted)"
                        : s.pct >= 80
                        ? "#2E7D32"
                        : s.pct >= 50
                        ? "#F9A825"
                        : "#C62828",
                  }}
                >
                  {s.pct === null ? "—" : `${Math.round(s.pct)}%`}
                </div>
                <div style={styles.inRangeSub}>
                  {s.count ? `${s.inCount}/${s.count} readings` : "no data"}
                </div>
              </div>
            );
          })}
        </div>
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

      <div style={styles.card}>
        <div style={styles.sectionTitle}>Decay Model Accuracy</div>
        {filteredCalibration.length === 0 ? (
          <div style={{ color: "var(--piq-text-muted)", fontSize: 13 }}>
            No calibration data yet — this fills in automatically each time
            you log a reading after a previous one, comparing the
            Dashboard's predicted FC (based on the last log + weather) to
            what you actually measured.
          </div>
        ) : (
          <>
            {calibrationSummary && (
              <div style={styles.calibrationSummary}>
                Average error:{" "}
                <strong>
                  {calibrationSummary.meanError >= 0 ? "+" : ""}
                  {calibrationSummary.meanError.toFixed(2)} ppm
                </strong>{" "}
                ({calibrationSummary.meanError >= 0
                  ? "model tends to predict low"
                  : "model tends to predict high"}
                ), mean absolute error{" "}
                <strong>{calibrationSummary.meanAbsError.toFixed(2)} ppm</strong>{" "}
                across {calibrationSummary.count} comparisons.
              </div>
            )}
            <div style={{ width: "100%", height: 220, marginTop: 12 }}>
              <ResponsiveContainer>
                <LineChart
                  data={filteredCalibration}
                  margin={{ top: 8, right: 8, left: -20, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--piq-border)" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line
                    type="monotone"
                    dataKey="actualFC"
                    stroke="#2E75B6"
                    strokeWidth={2}
                    dot={{ r: 3 }}
                    connectNulls
                    name="Actual FC"
                  />
                  <Line
                    type="monotone"
                    dataKey="modelFC"
                    stroke="#9E9E9E"
                    strokeWidth={2}
                    strokeDasharray="4 3"
                    dot={{ r: 3 }}
                    connectNulls
                    name="Model FC"
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div style={styles.calibrationTableWrap}>
              <table style={styles.calibrationTable}>
                <thead>
                  <tr>
                    <th style={styles.th}>Date</th>
                    <th style={styles.th}>Actual</th>
                    <th style={styles.th}>Model</th>
                    <th style={styles.th}>Error</th>
                    <th style={styles.th}>UV</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredCalibration
                    .slice(-10)
                    .reverse()
                    .map((c, i) => (
                      <tr key={i}>
                        <td style={styles.td}>{c.label}</td>
                        <td style={styles.td}>{c.actualFC?.toFixed(2)}</td>
                        <td style={styles.td}>{c.modelFC?.toFixed(2)}</td>
                        <td style={styles.td}>
                          {c.error !== null ? c.error.toFixed(2) : "—"}
                        </td>
                        <td style={styles.td}>
                          {c.uvIndex !== undefined && c.uvIndex !== null
                            ? c.uvIndex
                            : "—"}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            <div style={styles.caveat}>
              Model FC is what the Dashboard would have predicted for FC at
              the moment of this log, based on the previous reading and
              weather since. Scan the UV column alongside the error column
              to eyeball whether sunnier days correlate with faster
              real-world decay than the model assumes.
            </div>
          </>
        )}
      </div>
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
  inRangeGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(90px, 1fr))",
    gap: 12,
  },
  inRangeStat: {
    textAlign: "center",
    padding: "8px 4px",
    background: "var(--piq-bg)",
    borderRadius: 10,
  },
  subMetricLabel: {
    fontSize: 11,
    color: "var(--piq-text-muted)",
    fontWeight: 600,
  },
  inRangePct: {
    fontSize: 22,
    fontWeight: 800,
    marginTop: 4,
  },
  inRangeSub: {
    fontSize: 10,
    color: "var(--piq-text-muted)",
    marginTop: 2,
  },
  calibrationSummary: {
    fontSize: 13,
    color: "var(--piq-text)",
    lineHeight: 1.5,
  },
  calibrationTableWrap: {
    marginTop: 14,
    overflowX: "auto",
  },
  calibrationTable: {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: 12,
  },
  th: {
    textAlign: "left",
    padding: "6px 8px",
    color: "var(--piq-text-muted)",
    fontWeight: 700,
    borderBottom: "1px solid var(--piq-border)",
  },
  td: {
    padding: "6px 8px",
    borderBottom: "1px solid var(--piq-border)",
  },
  caveat: {
    marginTop: 14,
    fontSize: 12,
    fontStyle: "italic",
    color: "var(--piq-text-muted)",
    borderTop: "1px solid var(--piq-border)",
    paddingTop: 10,
  },
};
