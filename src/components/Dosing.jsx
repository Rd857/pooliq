import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  addDoc,
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
} from "firebase/firestore";
import { db } from "../lib/firebase";
import { computeAllDoses, DOSING_CAVEAT, DOSING_TABLE } from "../lib/dosing";
import { RANGES } from "../lib/ranges";

const DOSING_PARAMS = ["fc", "cya", "ta", "ch", "pH"];

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function midpoint(range) {
  return (range.min + range.max) / 2;
}

function readingsFromLog(log) {
  const r = {};
  DOSING_PARAMS.forEach((p) => {
    const v = log[p];
    r[p] = v === undefined || v === null ? "" : String(v);
  });
  return r;
}

// How far a custom target can stray past the warranty range before we flag
// it — expressed as a multiple of the range's own width. E.g. for FC
// (1-3 ppm, width 2), a target of 5 (2 past the top) sits right at the
// threshold; anything further out gets a soft warning. Deliberately loose:
// shocking to FC 4-5 is normal and shouldn't nag.
const TARGET_WARNING_MULTIPLE = 1;

function targetWarning(range, target) {
  if (target === undefined || target === null || Number.isNaN(target)) {
    return null;
  }
  const width = range.max - range.min;
  const overBy = target - range.max;
  const underBy = range.min - target;
  if (overBy > width * TARGET_WARNING_MULTIPLE) {
    return `Well above the warranty range (${range.min}–${range.max}${
      range.unit ? ` ${range.unit}` : ""
    }) — double-check before dosing.`;
  }
  if (underBy > width * TARGET_WARNING_MULTIPLE) {
    return `Well below the warranty range (${range.min}–${range.max}${
      range.unit ? ` ${range.unit}` : ""
    }) — double-check before dosing.`;
  }
  return null;
}

export default function Dosing() {
  const [poolConfig, setPoolConfig] = useState(undefined); // undefined = loading
  const [lastLog, setLastLog] = useState(undefined); // undefined = loading, null = none
  const [readings, setReadings] = useState({
    fc: "",
    cya: "",
    ta: "",
    ch: "",
    pH: "",
  });
  const [customTargets, setCustomTargets] = useState({
    fc: "",
    cya: "",
    ta: "",
    ch: "",
    pH: "",
  });
  const autoFilledRef = useRef(false);
  const [loggedDoses, setLoggedDoses] = useState({});

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

  useEffect(() => {
    if (!db) {
      setLastLog(null);
      return undefined;
    }
    const q = query(
      collection(db, "logs"),
      orderBy("createdAt", "desc"),
      limit(1)
    );
    const unsub = onSnapshot(
      q,
      (snap) => setLastLog(snap.empty ? null : snap.docs[0].data()),
      () => setLastLog(null)
    );
    return unsub;
  }, []);

  // Pre-fill the readings from the most recent log, once — so it doesn't
  // clobber values Ryan is mid-typing if a new log arrives via the
  // real-time listener while this screen is open.
  useEffect(() => {
    if (autoFilledRef.current) return;
    if (!lastLog) return;
    autoFilledRef.current = true;
    setReadings(readingsFromLog(lastLog));
  }, [lastLog]);

  function resetToLastLog() {
    if (lastLog) setReadings(readingsFromLog(lastLog));
  }

  async function logDose(dose, paramKey) {
    if (!db) return;
    const key = dose.label;
    setLoggedDoses((prev) => ({ ...prev, [key]: "saving" }));
    try {
      await addDoc(collection(db, "doses"), {
        date: todayISO(),
        parameter: paramKey,
        label: dose.label,
        chemical: dose.chemical,
        amount: dose.amount,
        unit: dose.unit,
        createdAt: serverTimestamp(),
      });
      setLoggedDoses((prev) => ({ ...prev, [key]: "logged" }));
    } catch (err) {
      setLoggedDoses((prev) => ({ ...prev, [key]: undefined }));
    }
  }

  const volumeGallons = poolConfig && poolConfig.volumeGallons;

  const defaultTargets = useMemo(() => {
    const t = {};
    DOSING_PARAMS.forEach((p) => {
      t[p] = midpoint(RANGES[p]);
    });
    return t;
  }, []);

  const targets = useMemo(() => {
    const t = {};
    DOSING_PARAMS.forEach((p) => {
      const raw = customTargets[p];
      const custom = raw === "" ? undefined : Number(raw);
      t[p] =
        custom !== undefined && !Number.isNaN(custom)
          ? custom
          : defaultTargets[p];
    });
    return t;
  }, [customTargets, defaultTargets]);

  const warnings = useMemo(() => {
    const w = {};
    DOSING_PARAMS.forEach((p) => {
      w[p] = targetWarning(RANGES[p], targets[p]);
    });
    return w;
  }, [targets]);

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
        <h2 style={{ marginTop: 0, color: "var(--piq-yellow)" }}>
          Pool volume not set
        </h2>
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
        {lastLog && (
          <div style={styles.autoFillRow}>
            <span>
              Pre-filled from last log — {lastLog.date}
              {lastLog.time ? ` · ${lastLog.time}` : ""}
            </span>
            <button
              type="button"
              onClick={resetToLastLog}
              style={styles.resetLink}
            >
              Reset to last log
            </button>
          </div>
        )}
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
                placeholder={`current`}
              />
              <div style={styles.rangeHint}>
                Target range: {RANGES[p].min}–{RANGES[p].max}
                {RANGES[p].unit ? ` ${RANGES[p].unit}` : ""}
              </div>

              <label style={styles.targetLabel}>
                Goal{" "}
                {customTargets[p] !== "" && (
                  <button
                    type="button"
                    onClick={() =>
                      setCustomTargets((prev) => ({ ...prev, [p]: "" }))
                    }
                    style={styles.clearTargetLink}
                  >
                    reset
                  </button>
                )}
              </label>
              <input
                type="number"
                inputMode="decimal"
                step={p === "pH" ? 0.1 : 1}
                value={customTargets[p]}
                onChange={(e) =>
                  setCustomTargets((prev) => ({ ...prev, [p]: e.target.value }))
                }
                style={styles.targetInput}
                placeholder={`default ${defaultTargets[p]}`}
              />
              {warnings[p] && (
                <div style={styles.targetWarning}>⚠️ {warnings[p]}</div>
              )}
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
              const logState = loggedDoses[dose.label];
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
                  <button
                    type="button"
                    onClick={() => logDose(dose, paramKey)}
                    disabled={logState === "saving" || logState === "logged"}
                    style={{
                      ...styles.logDoseButton,
                      ...(logState === "logged"
                        ? styles.logDoseButtonDone
                        : {}),
                    }}
                  >
                    {logState === "logged"
                      ? "Logged — will show on History"
                      : logState === "saving"
                      ? "Logging…"
                      : "Log this dose"}
                  </button>
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
    border: "1px solid var(--piq-yellow)",
    borderRadius: "var(--piq-radius)",
    padding: 24,
    textAlign: "center",
  },
  card: {
    background: "var(--piq-card-bg)",
    border: "1px solid var(--piq-border)",
    borderRadius: "var(--piq-radius)",
    padding: 18,
    boxShadow: "var(--piq-shadow)",
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
  autoFillRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    fontSize: 12,
    color: "var(--piq-text-muted)",
    background: "var(--piq-bg)",
    borderRadius: "var(--piq-radius)",
    padding: "8px 12px",
    marginBottom: 14,
    marginTop: -6,
  },
  resetLink: {
    background: "none",
    border: "none",
    color: "var(--piq-primary)",
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
    padding: 0,
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
    borderRadius: "var(--piq-radius)",
    background: "var(--piq-card-bg)",
    color: "var(--piq-text)",
    padding: "10px 12px",
    fontSize: 16,
    fontFamily: "var(--piq-font-mono)",
  },
  rangeHint: {
    fontSize: 11,
    color: "var(--piq-text-muted)",
  },
  targetLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: "var(--piq-primary)",
    marginTop: 6,
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  clearTargetLink: {
    background: "none",
    border: "none",
    color: "var(--piq-text-muted)",
    fontSize: 11,
    fontWeight: 600,
    textDecoration: "underline",
    cursor: "pointer",
    padding: 0,
  },
  targetInput: {
    border: "1px solid var(--piq-primary)",
    borderRadius: "var(--piq-radius)",
    background: "var(--piq-card-bg)",
    color: "var(--piq-text)",
    padding: "8px 12px",
    fontSize: 15,
    fontFamily: "var(--piq-font-mono)",
  },
  targetWarning: {
    fontSize: 11,
    color: "var(--piq-yellow)",
    fontWeight: 600,
    lineHeight: 1.4,
  },
  doseRow: {
    background: "var(--piq-bg)",
    border: "1px solid var(--piq-border)",
    borderRadius: "var(--piq-radius)",
    padding: "12px 14px",
  },
  doseHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
  },
  doseAmount: {
    fontSize: 17,
    fontWeight: 600,
    fontFamily: "var(--piq-font-mono)",
    fontVariantNumeric: "tabular-nums",
    color: "var(--piq-primary)",
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
  logDoseButton: {
    marginTop: 10,
    width: "100%",
    background: "none",
    border: "1px solid var(--piq-primary)",
    borderRadius: "var(--piq-radius)",
    color: "var(--piq-primary)",
    fontSize: 12,
    fontWeight: 600,
    fontFamily: "var(--piq-font-mono)",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    padding: "8px 0",
    cursor: "pointer",
  },
  logDoseButtonDone: {
    border: "1px solid var(--piq-border)",
    color: "var(--piq-text-muted)",
    cursor: "default",
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
