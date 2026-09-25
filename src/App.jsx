import React, { useEffect, useState } from "react";
import { onAuthStateChanged, signInWithPopup, signOut } from "firebase/auth";
import { auth, googleProvider, isFirebaseConfigured } from "./lib/firebase";
import Dashboard from "./components/Dashboard.jsx";
import LogEntry from "./components/LogEntry.jsx";
import CleaningLog from "./components/CleaningLog.jsx";
import DoseLog from "./components/DoseLog.jsx";
import History from "./components/History.jsx";
import Dosing from "./components/Dosing.jsx";
import Forecast from "./components/Forecast.jsx";

const LOG_MODES = [
  { id: "chemistry", label: "Reading" },
  { id: "dose", label: "Dose" },
  { id: "cleaning", label: "Cleaning" },
];

const TABS = [
  { id: "dashboard", label: "Dashboard", icon: "\u{1F4CA}" }, // 📊
  { id: "log", label: "Log", icon: "\u{1F4DD}" }, // 📝
  { id: "forecast", label: "Forecast", icon: "\u{1F52E}" }, // 🔮
  { id: "history", label: "History", icon: "\u{1F4C8}" }, // 📈
  { id: "dosing", label: "Dosing", icon: "\u{1F9EA}" }, // 🧪
];

function NotConfiguredScreen() {
  return (
    <div style={styles.centerScreen}>
      <div style={styles.notConfiguredCard}>
        <div style={{ fontSize: 40, marginBottom: 8 }}>🏊</div>
        <h1 style={{ margin: "0 0 8px", color: "var(--piq-primary)" }}>
          PoolIQ
        </h1>
        <p style={{ color: "var(--piq-text-muted)", marginBottom: 16 }}>
          Firebase not configured yet.
        </p>
        <p style={{ fontSize: 14, color: "var(--piq-text-muted)" }}>
          Copy <code>.env.example</code> to <code>.env.local</code> and fill
          in the <code>REACT_APP_FIREBASE_*</code> values from the{" "}
          <strong>pooliq-f401b</strong> Firebase project, then restart the
          dev server.
        </p>
      </div>
    </div>
  );
}

function SignInScreen({ onSignIn, error }) {
  return (
    <div style={styles.centerScreen}>
      <div style={styles.notConfiguredCard}>
        <div style={{ fontSize: 40, marginBottom: 8 }}>🏊</div>
        <h1 style={{ margin: "0 0 8px", color: "var(--piq-primary)" }}>
          PoolIQ
        </h1>
        <p style={{ color: "var(--piq-text-muted)", marginBottom: 20 }}>
          Pool chemistry tracking for your Pebble Sheen pool.
        </p>
        <button style={styles.signInButton} onClick={onSignIn}>
          Sign in with Google
        </button>
        {error && (
          <p style={{ color: "var(--piq-red)", fontSize: 13, marginTop: 12 }}>
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState("dashboard");
  const [logMode, setLogMode] = useState("chemistry");
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState(null);

  useEffect(() => {
    if (!isFirebaseConfigured || !auth) {
      setAuthLoading(false);
      return;
    }
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setAuthLoading(false);
    });
    return unsubscribe;
  }, []);

  if (!isFirebaseConfigured) {
    return <NotConfiguredScreen />;
  }

  if (authLoading) {
    return (
      <div style={styles.centerScreen}>
        <p style={{ color: "var(--piq-text-muted)" }}>Loading…</p>
      </div>
    );
  }

  const handleSignIn = async () => {
    setAuthError(null);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      setAuthError(err.message || "Sign-in failed. Please try again.");
    }
  };

  if (!user) {
    return <SignInScreen onSignIn={handleSignIn} error={authError} />;
  }

  return (
    <div style={styles.appShell}>
      <header style={styles.header}>
        <div style={styles.headerTitle}>
          <span role="img" aria-label="pool">
            🏊
          </span>{" "}
          PoolIQ
        </div>
        <button style={styles.signOutButton} onClick={() => signOut(auth)}>
          Sign out
        </button>
      </header>

      <main style={styles.main}>
        {activeTab === "dashboard" && (
          <Dashboard onOpenForecast={() => setActiveTab("forecast")} />
        )}
        {activeTab === "forecast" && <Forecast />}
        {activeTab === "log" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={styles.logModeRow}>
              {LOG_MODES.map((m) => (
                <button
                  key={m.id}
                  onClick={() => setLogMode(m.id)}
                  style={{
                    ...styles.logModeButton,
                    ...(logMode === m.id ? styles.logModeButtonActive : {}),
                  }}
                >
                  {m.label}
                </button>
              ))}
            </div>
            {logMode === "chemistry" && (
              <LogEntry onSaved={() => setActiveTab("dashboard")} />
            )}
            {logMode === "dose" && (
              <DoseLog onSaved={() => setActiveTab("dashboard")} />
            )}
            {logMode === "cleaning" && (
              <CleaningLog onSaved={() => setActiveTab("dashboard")} />
            )}
          </div>
        )}
        {activeTab === "history" && <History />}
        {activeTab === "dosing" && <Dosing />}
      </main>

      <nav style={styles.bottomNav}>
        {TABS.map((tab) => {
          const isActive = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{
                ...styles.navButton,
                color: isActive ? "var(--piq-primary)" : "var(--piq-text-muted)",
                fontWeight: isActive ? 700 : 500,
              }}
            >
              <span style={{ fontSize: 20, lineHeight: 1 }}>{tab.icon}</span>
              <span style={{ fontSize: 11, marginTop: 2 }}>{tab.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}

const styles = {
  centerScreen: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    background: "var(--piq-bg)",
  },
  notConfiguredCard: {
    maxWidth: 400,
    textAlign: "center",
    background: "var(--piq-card-bg)",
    border: "1px solid var(--piq-border)",
    borderRadius: "var(--piq-radius)",
    padding: 32,
    boxShadow: "var(--piq-shadow)",
  },
  signInButton: {
    background: "var(--piq-primary)",
    color: "var(--piq-on-accent)",
    border: "none",
    borderRadius: "var(--piq-radius)",
    padding: "14px 24px",
    fontSize: 16,
    fontWeight: 600,
    cursor: "pointer",
    width: "100%",
  },
  appShell: {
    minHeight: "100vh",
    display: "flex",
    flexDirection: "column",
  },
  header: {
    position: "sticky",
    top: 0,
    zIndex: 10,
    background: "var(--piq-bg)",
    color: "var(--piq-text)",
    borderBottom: "1px solid var(--piq-border)",
    padding: "14px 16px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: 600,
    fontFamily: "var(--piq-font-mono)",
    letterSpacing: 0.5,
  },
  signOutButton: {
    background: "transparent",
    color: "var(--piq-text-muted)",
    border: "1px solid var(--piq-border)",
    borderRadius: "var(--piq-radius)",
    padding: "6px 12px",
    fontSize: 12,
    fontFamily: "var(--piq-font-mono)",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    cursor: "pointer",
  },
  main: {
    flex: 1,
    padding: "16px 16px calc(var(--piq-nav-height) + 24px)",
    maxWidth: 640,
    margin: "0 auto",
    width: "100%",
  },
  bottomNav: {
    position: "fixed",
    bottom: 0,
    left: 0,
    right: 0,
    height: "var(--piq-nav-height)",
    background: "var(--piq-card-bg)",
    borderTop: "1px solid var(--piq-border)",
    display: "flex",
    paddingBottom: "env(safe-area-inset-bottom, 0px)",
    boxShadow: "var(--piq-shadow)",
  },
  logModeRow: {
    display: "flex",
    gap: 8,
    background: "var(--piq-card-bg)",
    border: "1px solid var(--piq-border)",
    borderRadius: "var(--piq-radius)",
    padding: 4,
  },
  logModeButton: {
    flex: 1,
    border: "1px solid transparent",
    background: "none",
    borderRadius: "var(--piq-radius)",
    padding: "10px 0",
    fontSize: 13,
    fontWeight: 600,
    fontFamily: "var(--piq-font-mono)",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: "var(--piq-text-muted)",
    cursor: "pointer",
  },
  logModeButtonActive: {
    background: "var(--piq-bg)",
    borderColor: "var(--piq-primary)",
    color: "var(--piq-primary)",
  },
  navButton: {
    flex: 1,
    background: "none",
    border: "none",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: "8px 0",
    cursor: "pointer",
  },
};
