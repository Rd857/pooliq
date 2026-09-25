import React, { useEffect, useState } from "react";
import {
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
} from "firebase/firestore";
import { db } from "../lib/firebase";
import { getCurrentWeather } from "../lib/ambientWeather";
import { useModel } from "../lib/modelData";
import { RANGES, rangeStatus, STATUS_COLOR } from "../lib/ranges";

const DAY_MS = 24 * 3600 * 1000;

function StatusPill({ status }) {
  const label = { in: "OK", low: "LOW", high: "HIGH", unknown: "—" }[status];
  const color = STATUS_COLOR[status];
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 2,
        fontSize: 11,
        fontWeight: 600,
        fontFamily: "var(--piq-font-mono)",
        letterSpacing: 0.5,
        color,
        border: `1px solid ${color}`,
        background: "transparent",
      }}
    >
      {label}
    </span>
  );
}

function fmtWhen(ms, nowMs) {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const dayDiff = Math.round(
    (new Date(d).setHours(0, 0, 0, 0) - new Date(nowMs).setHours(0, 0, 0, 0)) / DAY_MS
  );
  if (dayDiff === 0) return `today ${time}`;
  if (dayDiff === 1) return `tomorrow ${time}`;
  return `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

function ChlorineHero({ onOpenForecast }) {
  const model = useModel({ fit: false });
  const f = model.status === "ready" ? model.result.fc.forecast : null;
  const floor = f ? model.result.fc.floor : null;
  const below = f && f.now.p50 < floor;
  const status = !f ? "unknown" : below ? "low" : "in";

  return (
    <div style={{ ...styles.card, borderLeft: `3px solid ${STATUS_COLOR[status]}` }}>
      <div style={styles.heroLabel}>Estimated free chlorine</div>
      {model.status === "loading" && <div style={styles.muted}>Estimating…</div>}
      {model.status === "error" && (
        <div style={styles.muted}>Couldn't estimate: {model.error.message}</div>
      )}
      {model.status === "ready" && !f && (
        <div style={styles.muted}>Log a chlorine reading to start estimating.</div>
      )}
      {f && (
        <>
          <div style={styles.heroValue}>
            {f.now.p50.toFixed(2)}
            <span style={{ fontSize: 15, fontWeight: 500 }}>ppm</span>
            <StatusPill status={status} />
          </div>
          <div style={styles.heroRange}>
            Likely {f.now.p10.toFixed(1)}–{f.now.p90.toFixed(1)} ppm
          </div>
          <div style={{ ...styles.heroNext, color: below ? "var(--piq-yellow)" : "var(--piq-text)" }}>
            {below
              ? `Below the ${floor.toFixed(1)} ppm floor — add chlorine`
              : f.dueMs
              ? `Next chlorine due ${fmtWhen(f.dueMs, model.result.nowMs)}`
              : "Above the floor for the next 3 days"}
          </div>
          <button type="button" onClick={onOpenForecast} style={styles.linkButton}>
            Forecast and calibration →
          </button>
        </>
      )}
    </div>
  );
}

export default function Dashboard({ onOpenForecast }) {
  const [lastLog, setLastLog] = useState(undefined); // undefined = loading, null = none
  const [poolConfig, setPoolConfig] = useState(undefined);
  const [weather, setWeather] = useState(null);
  const [weatherLoading, setWeatherLoading] = useState(true);

  useEffect(() => {
    if (!db) return undefined;
    const q = query(collection(db, "logs"), orderBy("createdAt", "desc"), limit(1));
    return onSnapshot(
      q,
      (snap) =>
        setLastLog(snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() }),
      () => setLastLog(null)
    );
  }, []);

  useEffect(() => {
    if (!db) return undefined;
    return onSnapshot(
      doc(db, "config", "pool"),
      (snap) => setPoolConfig(snap.exists() ? snap.data() : null),
      () => setPoolConfig(null)
    );
  }, []);

  // Current conditions, fetched once per visit.
  useEffect(() => {
    let cancelled = false;
    getCurrentWeather().then((result) => {
      if (cancelled) return;
      setWeather(result);
      setWeatherLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (lastLog === undefined) {
    return <div style={styles.loading}>Loading dashboard…</div>;
  }

  if (lastLog === null) {
    return (
      <div style={styles.card}>
        <h2 style={{ marginTop: 0 }}>Welcome to PoolIQ</h2>
        <p style={{ color: "var(--piq-text-muted)" }}>
          No log entries yet. Head to the <strong>Log</strong> tab to record
          your first pH / chlorine / etc. reading — the dashboard will start
          estimating decay and showing status once there's at least one
          entry.
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <ChlorineHero onOpenForecast={onOpenForecast} />

      <div style={styles.card}>
        <div style={styles.sectionTitle}>Weather</div>
        {weatherLoading ? (
          <div style={{ color: "var(--piq-text-muted)" }}>Loading…</div>
        ) : weather && weather.available ? (
          <>
            <div style={styles.weatherGrid}>
              <WeatherStat label="UV Index" value={weather.uv} />
              <WeatherStat
                label="Solar Rad"
                value={
                  weather.solarradiation !== undefined
                    ? `${Math.round(weather.solarradiation)} W/m²`
                    : "—"
                }
              />
              <WeatherStat
                label="Outdoor Temp"
                value={weather.tempf !== undefined ? `${weather.tempf}°F` : "—"}
              />
              <WeatherStat
                label="Rain Today"
                value={
                  weather.dailyrainin !== undefined
                    ? `${weather.dailyrainin.toFixed(2)} in`
                    : "—"
                }
              />
            </div>
            {weather.stale && (
              <div style={styles.staleBanner}>
                Station data may be stale (last update over 30 min ago).
              </div>
            )}
          </>
        ) : (
          <div style={styles.unavailableBanner}>
            Weather unavailable — check Worker configuration
            {weather && weather.reason ? `: ${weather.reason}` : "."}
          </div>
        )}
      </div>

      <div style={styles.card}>
        <div style={styles.sectionTitle}>
          Last Log — {lastLog.date} {lastLog.time ? `· ${lastLog.time}` : ""}
        </div>
        <div style={styles.lastLogGrid}>
          <LastLogStat paramKey="pH" value={lastLog.pH} />
          <LastLogStat paramKey="fc" value={lastLog.fc} />
          <LastLogStat paramKey="tc" value={lastLog.tc} />
          <LastLogStat
            paramKey="cc"
            value={
              typeof lastLog.tc === "number" && typeof lastLog.fc === "number"
                ? Math.round((lastLog.tc - lastLog.fc) * 10) / 10
                : null
            }
          />
          <LastLogStat paramKey="ta" value={lastLog.ta} />
          <LastLogStat paramKey="ch" value={lastLog.ch} />
          <LastLogStat paramKey="cya" value={lastLog.cya} />
          <LastLogStat paramKey="waterTemp" value={lastLog.waterTemp} />
          {poolConfig && poolConfig.hasSWG && (
            <LastLogStat paramKey="salt" value={lastLog.salt} />
          )}
        </div>
        {lastLog.notes && (
          <div style={styles.notes}>
            <strong>Notes:</strong> {lastLog.notes}
          </div>
        )}
        <div style={styles.testedBy}>Tested by {lastLog.testedBy || "—"}</div>
      </div>
    </div>
  );
}

function WeatherStat({ label, value }) {
  return (
    <div>
      <div style={styles.subMetricLabel}>{label}</div>
      <div style={styles.subMetricValue}>
        {value === undefined || value === null ? "—" : value}
      </div>
    </div>
  );
}

function LastLogStat({ paramKey, value }) {
  const range = RANGES[paramKey];
  const status = rangeStatus(paramKey, value);
  return (
    <div style={styles.lastLogStat}>
      <div style={styles.subMetricLabel}>{range ? range.label : paramKey}</div>
      <div style={styles.subMetricValue}>
        {value === undefined || value === null ? "—" : value}
        {range && range.unit ? ` ${range.unit}` : ""}
      </div>
      <StatusPill status={status} />
    </div>
  );
}

const styles = {
  loading: { padding: 24, textAlign: "center", color: "var(--piq-text-muted)" },
  muted: { color: "var(--piq-text-muted)", marginTop: 8, fontSize: 14 },
  card: {
    background: "var(--piq-card-bg)",
    border: "1px solid var(--piq-border)",
    borderRadius: "var(--piq-radius)",
    padding: 18,
    boxShadow: "var(--piq-shadow)",
  },
  heroLabel: {
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    color: "var(--piq-text-muted)",
  },
  heroValue: {
    fontSize: 32,
    fontWeight: 600,
    fontFamily: "var(--piq-font-mono)",
    fontVariantNumeric: "tabular-nums",
    color: "var(--piq-primary)",
    marginTop: 6,
    display: "flex",
    alignItems: "center",
    gap: 10,
  },
  heroRange: {
    fontSize: 12,
    fontFamily: "var(--piq-font-mono)",
    color: "var(--piq-text-muted)",
    marginTop: 2,
  },
  heroNext: { fontSize: 14, marginTop: 10 },
  linkButton: {
    marginTop: 12,
    background: "none",
    border: "none",
    padding: 0,
    color: "var(--piq-primary)",
    fontSize: 12,
    fontWeight: 600,
    fontFamily: "var(--piq-font-mono)",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    cursor: "pointer",
  },
  subMetricLabel: {
    fontSize: 11,
    color: "var(--piq-text-muted)",
    fontWeight: 600,
  },
  subMetricValue: {
    fontSize: 15,
    fontWeight: 600,
    fontFamily: "var(--piq-font-mono)",
    fontVariantNumeric: "tabular-nums",
    marginTop: 2,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: 700,
    color: "var(--piq-text-muted)",
    marginBottom: 10,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  weatherGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 14,
  },
  staleBanner: {
    marginTop: 12,
    background: "var(--piq-yellow-bg)",
    color: "var(--piq-yellow)",
    borderRadius: "var(--piq-radius)",
    padding: "8px 12px",
    fontSize: 13,
  },
  unavailableBanner: {
    background: "var(--piq-yellow-bg)",
    color: "var(--piq-yellow)",
    borderRadius: "var(--piq-radius)",
    padding: "10px 12px",
    fontSize: 13,
  },
  lastLogGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 14,
  },
  lastLogStat: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    alignItems: "flex-start",
  },
  notes: {
    marginTop: 14,
    fontSize: 13,
    color: "var(--piq-text)",
    background: "var(--piq-bg)",
    borderRadius: "var(--piq-radius)",
    padding: "8px 12px",
  },
  testedBy: {
    marginTop: 10,
    fontSize: 12,
    color: "var(--piq-text-muted)",
  },
};
