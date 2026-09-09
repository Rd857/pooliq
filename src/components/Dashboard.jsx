import React, { useEffect, useMemo, useState } from "react";
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
import { estimateDashboardState, FC_FLOOR_PPM } from "../lib/chlorineModel";
import { RANGES, rangeStatus, STATUS_COLOR } from "../lib/ranges";

const WEATHER_REFRESH_MS = 5 * 60 * 1000; // 5 minutes

function StatusPill({ status }) {
  const label = { in: "In range", low: "Low", high: "High", unknown: "—" }[
    status
  ];
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 10px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 700,
        color: "white",
        background: STATUS_COLOR[status],
      }}
    >
      {label}
    </span>
  );
}

function formatHours(hours) {
  if (hours === null || hours === undefined) return "—";
  if (hours === Infinity) return "Not decaying (per model)";
  if (hours <= 0) return "Already at/below floor";
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  return `${hours.toFixed(1)} hrs`;
}

export default function Dashboard() {
  const [lastLog, setLastLog] = useState(undefined); // undefined = loading, null = none
  const [poolConfig, setPoolConfig] = useState(undefined);
  const [weather, setWeather] = useState(null);
  const [weatherLoading, setWeatherLoading] = useState(true);

  useEffect(() => {
    if (!db) return undefined;
    const q = query(
      collection(db, "logs"),
      orderBy("createdAt", "desc"),
      limit(1)
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        if (snap.empty) {
          setLastLog(null);
        } else {
          const d = snap.docs[0];
          setLastLog({ id: d.id, ...d.data() });
        }
      },
      () => setLastLog(null)
    );
    return unsub;
  }, []);

  useEffect(() => {
    if (!db) return undefined;
    const unsub = onSnapshot(
      doc(db, "config", "pool"),
      (snap) => setPoolConfig(snap.exists() ? snap.data() : null),
      () => setPoolConfig(null)
    );
    return unsub;
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadWeather() {
      setWeatherLoading(true);
      const result = await getCurrentWeather();
      if (!cancelled) {
        setWeather(result);
        setWeatherLoading(false);
      }
    }

    loadWeather();
    const interval = setInterval(loadWeather, WEATHER_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const dashboardState = useMemo(() => {
    if (!lastLog || !weather || !weather.available) return null;
    return estimateDashboardState({ lastLog, weather });
  }, [lastLog, weather]);

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

  const fcRangeStatus = dashboardState
    ? rangeStatus("fc", dashboardState.estimatedFC)
    : "unknown";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Hero card: estimated current FC */}
      <div
        style={{
          ...styles.card,
          borderLeft: `6px solid ${STATUS_COLOR[fcRangeStatus]}`,
        }}
      >
        <div style={styles.heroLabel}>ESTIMATED FREE CHLORINE</div>
        {dashboardState ? (
          <>
            <div style={styles.heroValue}>
              {dashboardState.estimatedFC.toFixed(2)}{" "}
              <span style={{ fontSize: 16, fontWeight: 500 }}>ppm</span>{" "}
              <StatusPill status={fcRangeStatus} />
            </div>
            <div style={styles.subMetricsRow}>
              <div>
                <div style={styles.subMetricLabel}>Effective (HOCl) FC</div>
                <div style={styles.subMetricValue}>
                  {dashboardState.effectiveFC !== null
                    ? `${dashboardState.effectiveFC.toFixed(2)} ppm`
                    : "—"}
                </div>
              </div>
              <div>
                <div style={styles.subMetricLabel}>
                  Hours to {FC_FLOOR_PPM.toFixed(1)} ppm floor
                </div>
                <div style={styles.subMetricValue}>
                  {formatHours(dashboardState.hoursToFloor)}
                </div>
              </div>
            </div>
            <div style={styles.estimatedNote}>
              Estimated from last reading ({dashboardState.hoursElapsed.toFixed(
                1
              )}{" "}
              hrs ago) using literature-default decay constants — not yet
              calibrated to this pool.
            </div>
            {dashboardState.rainWarning && (
              <div style={styles.rainBanner}>
                🌧️ Meaningful rain today — dilution may affect chlorine/pH
                beyond what this model accounts for.
              </div>
            )}
          </>
        ) : (
          <div style={{ color: "var(--piq-text-muted)", marginTop: 8 }}>
            {weatherLoading
              ? "Loading weather to compute estimate…"
              : "Weather unavailable — showing last logged reading only."}
          </div>
        )}
      </div>

      {/* Weather strip */}
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
                value={
                  weather.tempf !== undefined ? `${weather.tempf}°F` : "—"
                }
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
                ⚠️ Station data may be stale (last update over 30 min ago).
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

      {/* Last log summary */}
      <div style={styles.card}>
        <div style={styles.sectionTitle}>
          Last Log — {lastLog.date} {lastLog.time ? `· ${lastLog.time}` : ""}
        </div>
        <div style={styles.lastLogGrid}>
          <LastLogStat paramKey="pH" value={lastLog.pH} />
          <LastLogStat paramKey="fc" value={lastLog.fc} />
          <LastLogStat paramKey="tc" value={lastLog.tc} />
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
        <div style={styles.testedBy}>
          Tested by {lastLog.testedBy || "—"}
        </div>
      </div>
    </div>
  );
}

function WeatherStat({ label, value }) {
  return (
    <div style={styles.weatherStat}>
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
  card: {
    background: "var(--piq-card-bg)",
    border: "1px solid var(--piq-border)",
    borderRadius: 16,
    padding: 18,
    boxShadow: "0 2px 8px rgba(0,0,0,0.04)",
  },
  heroLabel: {
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: 0.5,
    color: "var(--piq-text-muted)",
  },
  heroValue: {
    fontSize: 34,
    fontWeight: 800,
    color: "var(--piq-primary-dark)",
    marginTop: 4,
    display: "flex",
    alignItems: "center",
    gap: 10,
  },
  subMetricsRow: {
    display: "flex",
    gap: 24,
    marginTop: 14,
  },
  subMetricLabel: {
    fontSize: 11,
    color: "var(--piq-text-muted)",
    fontWeight: 600,
  },
  subMetricValue: {
    fontSize: 16,
    fontWeight: 700,
    marginTop: 2,
  },
  estimatedNote: {
    marginTop: 12,
    fontSize: 12,
    color: "var(--piq-text-muted)",
    fontStyle: "italic",
  },
  rainBanner: {
    marginTop: 12,
    background: "#e3f2fd",
    color: "#1565c0",
    borderRadius: 10,
    padding: "8px 12px",
    fontSize: 13,
    fontWeight: 600,
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
  weatherStat: {},
  staleBanner: {
    marginTop: 12,
    background: "var(--piq-yellow-bg)",
    color: "#8a6100",
    borderRadius: 10,
    padding: "8px 12px",
    fontSize: 13,
  },
  unavailableBanner: {
    background: "var(--piq-yellow-bg)",
    color: "#8a6100",
    borderRadius: 10,
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
    borderRadius: 10,
    padding: "8px 12px",
  },
  testedBy: {
    marginTop: 10,
    fontSize: 12,
    color: "var(--piq-text-muted)",
  },
};
