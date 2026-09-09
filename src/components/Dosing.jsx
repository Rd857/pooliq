import React, { useEffect, useMemo, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "../lib/firebase";
import { computeAllDoses, DOSING_CAVEAT, DOSING_TABLE } from "../lib/dosing";
import { RANGES } from "../lib/ranges";

const DOSING_PARAMS = ["fc", "cya", "ta", "ch", "pH"];

function midpoint(range) {
  return (range.min + range.max) / 2;
}

export default function Dosing() {
  const [poolConfig, setPoolConfig] = useState(undefined); // undefined = loading
  const [readings, setReadings] = useState({
    fc: "",
    cya: "",
    ta: "",
    ch: "",
    pH: "",
  });

  useEffect(() => {
    if (!db) {
      setPoolConfig(null);
      return undefined;
    }
    const unsub = onSnapshot(
      doc(db, "config", "pool"),
      (snap) => setPoolConfig(snap.exists() ? snap.data() : null),
      () => setPoolConfig(null)
    );
    return unsub;
  }, []);

  const volumeGallons = poolConfig && poolConfig.volumeGallons;

  const targets = useMemo(() => {
    const t = {};
    DOSING_PARAMS.forEach((p) => {
      t[p] = midpoint(RANGES[p]);
    });
    return t;
  }, []);

  const currentValues = useMemo(() => {
    const c = {};
    DOSING_PARAMS.forEach((p) => {
      const raw = readings[p];
      c[p] = raw === "" ? undefined : Number(raw);
    });
    return c;
  }, [readings]);

  const doses = useMemo(() => {
    if (!volumeGallons) return [];
    return computeAllDoses(volumeGallons, currentValues, targets);
  }, [volumeGallons, currentValues, targets]);

  if (poolConfig === undefined) {
    return <div style={styles.loading}>Loading configuration…</div>;
  }

  if (!volumeGallons) {
    return (
      <div style={styles.warningCard}>
        <div style={{ fontSize: 32, marginBottom: 8 }}>⚠️</div>
        <h2 style={{ marginTop: 0 }}>Pool volume not set</h2>
        <p style={{ color: "var(--piq-text-muted)" }}>
          Set your pool volume in <strong>config/pool.volumeGallons</strong>{" "}
          (Firestore, via Config — a dedicated Config screen is a future
          phase) before using the dosing calculator. Without a known volume,
          dose amounts can't be computed reliably.
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={styles.card}>
        <div style={styles.sectionTitle}>Current Readings</div>
        <div style={styles.helperText}>
          Pool volume: {volumeGallons.toLocaleString()} gallons
        </div>
        <div style={styles.grid}>
          {DOSING_PARAMS.map((p) => (
            <div style={styles.field} key={p}>
              <label style={styles.label}>{RANGES[p].label}</label>
              <input
                type="number"
                inputMode="decimal"
                step={p === "pH" ? 0.1 : 1}
                value={readings[p]}
                onChange={(e) =>
                  setReadings((prev) => ({ ...prev, [p]: e.target.value }))
                }
                style={styles.input}
                placeholder={`target ${targets[p]}`}
              />
              <div style={styles.rangeHint}>
                Target range: {RANGES[p].min}–{RANGES[p].max}
                {RANGES[p].unit ? ` ${RANGES[p].unit}` : ""}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div style={styles.card}>
        <div style={styles.sectionTitle}>Dose Recommendations</div>
        {doses.length === 0 ? (
          <div style={{ color: "var(--piq-text-muted)" }}>
            Enter current readings above that fall short of (or exceed) the
            target range to see dose recommendations.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {doses.map((dose, i) => {
              const paramKey = DOSING_TABLE.find(
                (r) => r.label === dose.label
              )?.parameter;
              const current = currentValues[paramKey];
              const target = targets[paramKey];
              return (
                <div key={i} style={styles.doseRow}>
                  <div style={styles.doseHeader}>
                    <span style={{ fontWeight: 700 }}>{dose.label}</span>
                    <span style={styles.doseAmount}>
                      {dose.amount} {dose.unit}
                    </span>
                  </div>
                  <div style={styles.doseSub}>{dose.chemical}</div>
                  <div style={styles.doseVariance}>
                    Current: {current ?? "—"} → Target: {target}
                    {dose.nonLinear && (
                      <span style={styles.roughTag}> (rough estimate)</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <div style={styles.caveat}>{DOSING_CAVEAT}</div>
      </div>
    </div>
  );
}

const styles = {
  loading: { padding: 24, textAlign: "center", color: "var(--piq-text-muted)" },
  warningCard: {
    background: "var(--piq-yellow-bg)",
    border: "1px solid #f4d97a",
    borderRadius: 16,
    padding: 24,
    textAlign: "center",
  },
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
  helperText: {
    fontSize: 13,
    color: "var(--piq-text-muted)",
    marginBottom: 14,
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 14,
  },
  field: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
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
  rangeHint: {
    fontSize: 11,
    color: "var(--piq-text-muted)",
  },
  doseRow: {
    background: "var(--piq-bg)",
    borderRadius: 12,
    padding: "12px 14px",
  },
  doseHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
  },
  doseAmount: {
    fontSize: 18,
    fontWeight: 800,
    color: "var(--piq-primary-dark)",
  },
  doseSub: {
    fontSize: 13,
    color: "var(--piq-text-muted)",
    marginTop: 2,
  },
  doseVariance: {
    fontSize: 12,
    color: "var(--piq-text-muted)",
    marginTop: 6,
  },
  roughTag: {
    color: "var(--piq-yellow)",
    fontWeight: 700,
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
