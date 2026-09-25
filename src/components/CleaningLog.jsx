import React, { useState } from "react";
import { addDoc, collection, serverTimestamp } from "firebase/firestore";
import { db } from "../lib/firebase";
import { localDateISO, localTimeHHMM } from "../lib/time";

const CLEANING_TYPES = [
  { id: "brush", label: "Brush" },
  { id: "vacuum", label: "Vacuum" },
  { id: "both", label: "Both" },
];

export default function CleaningLog({ onSaved }) {
  const [date, setDate] = useState(localDateISO());
  const [time, setTime] = useState(localTimeHHMM());
  const [type, setType] = useState(null);
  const [notes, setNotes] = useState("");
  const [performedBy, setPerformedBy] = useState("Ryan");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);

    if (!db) {
      setError("Firestore is not available (Firebase not configured).");
      return;
    }
    if (!type) {
      setError("Pick what you did: Brush, Vacuum, or Both.");
      return;
    }

    setSaving(true);
    try {
      await addDoc(collection(db, "cleanings"), {
        date,
        time,
        type,
        notes: notes || "",
        performedBy: performedBy || "Ryan",
        createdAt: serverTimestamp(),
      });

      setSaved(true);
      setTimeout(() => {
        setSaved(false);
        setType(null);
        setNotes("");
        if (onSaved) onSaved();
      }, 1200);
    } catch (err) {
      setError(err.message || "Failed to save cleaning entry.");
    } finally {
      setSaving(false);
    }
  };

  if (saved) {
    return (
      <div style={styles.confirmationCard}>
        <div style={{ fontSize: 40 }}>🧹</div>
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
        <div style={styles.sectionTitle}>What did you do?</div>
        <div style={styles.typeRow}>
          {CLEANING_TYPES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setType(t.id)}
              style={{
                ...styles.typeButton,
                ...(type === t.id ? styles.typeButtonActive : {}),
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div style={styles.card}>
        <div style={styles.field}>
          <label style={styles.label}>Performed By</label>
          <input
            type="text"
            value={performedBy}
            onChange={(e) => setPerformedBy(e.target.value)}
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
            placeholder="Optional notes (algae spot, tile line, deep-end buildup, etc.)"
          />
        </div>
      </div>

      {error && <div style={styles.errorBanner}>{error}</div>}

      <button type="submit" disabled={saving} style={styles.submitButton}>
        {saving ? "Saving…" : "Save Cleaning Entry"}
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
    boxShadow: "var(--piq-shadow)",
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
    borderRadius: "var(--piq-radius)",
    background: "var(--piq-card-bg)",
    color: "var(--piq-text)",
    padding: "10px 12px",
    fontSize: 16,
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
  typeRow: {
    display: "flex",
    gap: 10,
  },
  typeButton: {
    flex: 1,
    border: "1px solid var(--piq-border)",
    background: "var(--piq-bg)",
    borderRadius: "var(--piq-radius)",
    padding: "16px 0",
    fontSize: 14,
    fontWeight: 600,
    fontFamily: "var(--piq-font-mono)",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: "var(--piq-text-muted)",
    cursor: "pointer",
  },
  typeButtonActive: {
    background: "var(--piq-primary)",
    borderColor: "var(--piq-primary)",
    color: "var(--piq-on-accent)",
  },
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
  confirmationCard: {
    textAlign: "center",
    padding: 48,
  },
};
