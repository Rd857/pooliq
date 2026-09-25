import React, { useEffect, useState } from "react";
import {
  addDoc,
  collection,
  doc,
  onSnapshot,
  serverTimestamp,
} from "firebase/firestore";
import { db } from "../lib/firebase";
import { DOSING_TABLE, doseEffect } from "../lib/dosing";
import { fromLocalDateTime, localDateISO, localTimeHHMM } from "../lib/time";

export default function DoseLog({ onSaved }) {
  const [date, setDate] = useState(localDateISO());
  const [time, setTime] = useState(localTimeHHMM());
  const [label, setLabel] = useState(DOSING_TABLE[0].label);
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [volumeGallons, setVolumeGallons] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!db) return undefined;
    return onSnapshot(doc(db, "config", "pool"), (snap) =>
      setVolumeGallons(snap.exists() ? snap.data().volumeGallons || null : null)
    );
  }, []);

  const rule = DOSING_TABLE.find((r) => r.label === label);
  const amountNum = amount === "" ? null : Number(amount);
  const effect =
    amountNum > 0 ? doseEffect({ label, amount: amountNum }, volumeGallons) : null;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    if (!db) {
      setError("Firestore is not available (Firebase not configured).");
      return;
    }
    if (!(amountNum > 0)) {
      setError("Enter how much you added.");
      return;
    }
    const at = fromLocalDateTime(date, time);
    if (!at) {
      setError("Enter a valid date and time.");
      return;
    }

    setSaving(true);
    try {
      await addDoc(collection(db, "doses"), {
        date,
        time,
        at: at.toISOString(),
        parameter: rule.parameter,
        label: rule.label,
        chemical: rule.chemical,
        amount: amountNum,
        unit: rule.unit,
        ppmChange: effect ? effect.change : null,
        volumeGallons: volumeGallons || null,
        notes: notes || "",
        source: "manual",
        createdAt: serverTimestamp(),
      });
      setSaved(true);
      setTimeout(() => {
        setSaved(false);
        setAmount("");
        setNotes("");
        if (onSaved) onSaved();
      }, 1200);
    } catch (err) {
      setError(err.message || "Failed to save dose.");
    } finally {
      setSaving(false);
    }
  };

  if (saved) {
    return (
      <div style={styles.confirmationCard}>
        <div style={styles.confirmationTitle}>Dose logged</div>
        <div style={{ color: "var(--piq-text-muted)", marginTop: 4 }}>
          Returning to dashboard…
        </div>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      style={{ display: "flex", flexDirection: "column", gap: 16 }}
    >
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
            <label style={styles.label}>Time added</label>
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
        <div style={styles.sectionTitle}>What did you add?</div>
        <div style={styles.chemGrid}>
          {DOSING_TABLE.map((r) => (
            <button
              key={r.label}
              type="button"
              onClick={() => setLabel(r.label)}
              style={{
                ...styles.chemButton,
                ...(label === r.label ? styles.chemButtonActive : {}),
              }}
            >
              <span style={styles.chemName}>{r.chemical}</span>
              <span style={styles.chemPurpose}>{r.label}</span>
            </button>
          ))}
        </div>

        <div style={{ ...styles.field, marginTop: 14 }}>
          <label style={styles.label}>Amount ({rule.unit})</label>
          <input
            type="number"
            inputMode="decimal"
            step="any"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            style={styles.bigInput}
            placeholder="0"
          />
          <div style={styles.helperText}>
            {effect
              ? `≈ ${effect.change > 0 ? "+" : ""}${effect.change.toFixed(
                  rule.parameter === "pH" ? 2 : 1
                )} ${rule.parameter === "pH" ? "pH" : "ppm"} in ${volumeGallons.toLocaleString()} gal`
              : volumeGallons
              ? "Enter an amount to see the expected change."
              : "Set pool volume to compute the expected change."}
          </div>
        </div>
      </div>

      <div style={styles.card}>
        <div style={styles.field}>
          <label style={styles.label}>Notes</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            style={styles.textarea}
            rows={2}
            placeholder="Optional (brand, strength, shocking, etc.)"
          />
        </div>
      </div>

      {error && <div style={styles.errorBanner}>{error}</div>}

      <button type="submit" disabled={saving} style={styles.submitButton}>
        {saving ? "Saving…" : "Save Dose"}
      </button>
    </form>
  );
}

const styles = {
  card: {
    background: "var(--piq-card-bg)",
    border: "1px solid var(--piq-border)",
    borderRadius: "var(--piq-radius)",
    padding: 18,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: 700,
    color: "var(--piq-text-muted)",
    marginBottom: 12,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  row: { display: "flex", gap: 14 },
  field: { display: "flex", flexDirection: "column", gap: 6, flex: 1 },
  label: { fontSize: 12, fontWeight: 600, color: "var(--piq-text-muted)" },
  input: {
    border: "1px solid var(--piq-border)",
    borderRadius: "var(--piq-radius)",
    background: "var(--piq-card-bg)",
    color: "var(--piq-text)",
    padding: "10px 12px",
    fontSize: 16,
  },
  bigInput: {
    border: "1px solid var(--piq-border)",
    borderRadius: "var(--piq-radius)",
    background: "var(--piq-bg)",
    padding: "14px 12px",
    fontSize: 20,
    fontWeight: 600,
    fontFamily: "var(--piq-font-mono)",
    color: "var(--piq-primary)",
  },
  textarea: {
    border: "1px solid var(--piq-border)",
    borderRadius: "var(--piq-radius)",
    background: "var(--piq-card-bg)",
    color: "var(--piq-text)",
    padding: "10px 12px",
    fontSize: 15,
    fontFamily: "inherit",
    resize: "vertical",
  },
  chemGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: 8,
  },
  chemButton: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: 3,
    textAlign: "left",
    border: "1px solid var(--piq-border)",
    background: "var(--piq-bg)",
    borderRadius: "var(--piq-radius)",
    padding: "10px 12px",
    color: "var(--piq-text-muted)",
    cursor: "pointer",
  },
  chemButtonActive: {
    borderColor: "var(--piq-primary)",
    color: "var(--piq-text)",
  },
  chemName: { fontSize: 13, fontWeight: 600 },
  chemPurpose: {
    fontSize: 10,
    fontFamily: "var(--piq-font-mono)",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: "var(--piq-text-muted)",
  },
  helperText: { fontSize: 12, color: "var(--piq-text-muted)", marginTop: 2 },
  errorBanner: {
    background: "var(--piq-red-bg)",
    color: "var(--piq-red)",
    borderRadius: "var(--piq-radius)",
    padding: "10px 14px",
    fontSize: 14,
  },
  submitButton: {
    background: "var(--piq-primary)",
    color: "var(--piq-on-accent)",
    border: "none",
    borderRadius: "var(--piq-radius)",
    padding: "16px",
    fontSize: 16,
    fontWeight: 600,
    cursor: "pointer",
  },
  confirmationCard: { textAlign: "center", padding: 48 },
  confirmationTitle: {
    fontWeight: 600,
    fontSize: 18,
    fontFamily: "var(--piq-font-mono)",
    color: "var(--piq-primary)",
  },
};
