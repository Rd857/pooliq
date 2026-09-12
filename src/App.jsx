import React, { useEffect, useState } from "react";
import { onAuthStateChanged, signInWithPopup, signOut } from "firebase/auth";
import { auth, googleProvider, isFirebaseConfigured } from "./lib/firebase";
import Dashboard from "./components/Dashboard.jsx";
import LogEntry from "./components/LogEntry.jsx";
import CleaningLog from "./components/CleaningLog.jsx";
import History from "./components/History.jsx";
import Dosing from "./components/Dosing.jsx";

const TABS = [
  { id: "dashboard", label: "Dashboard", icon: "\u{1F4CA}" }, // 📊
  { id: "log", label: "Log", icon: "\u{1F4DD}" }, // 📝
  { id: "history", label: "History", icon: "\u{1F4C8}" }, // 📈
  { id: "dosing", label: "Dosing", icon: "\u{1F9EA}" }, // 🧪
];

function NotConfiguredScreen() {
  return (
    <div style={styles.centerScreen}>
      <div style={styles.notConfiguredCard}>
        <div style={{ fontSize: 40, marginBottom: 8 }}>🏊</div>
        <h1 style={{ margin: "0 0 8px", color: "var(--piq-primary-dark)" }}>
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
        <h1 style={{ margin: "0 0 8px", color: "var(--piq-primary-dark)" }}>
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
        {activeTab === "dashboard" && <Dashboard />}
        {activeTab === "log" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={styles.logModeRow}>
              <button
                onClick={() => setLogMode("chemistry")}
                style={{
                  ...styles.logModeButton,
                  ...(logMode === "chemistry"
                    ? styles.logModeButtonActive
                    : {}),
                }}
              >
                Chemistry Reading
              </button>
              <button
                onClick={() => setLogMode("cleaning")}
                style={{
                  ...styles.logModeButton,
                  ...(logMode === "cleaning" ? styles.logModeButtonActive : {}),
                }}
              >
                Cleaning
              </button>
            </div>
            {logMode === "chemistry" ? (
              <LogEntry onSaved={() => setActiveTab("dashboard")} />
            ) : (
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
    borderRadius: 16,
    padding: 32,
    boxShadow: "0 2px 10px rgba(0,0,0,0.06)",
  },
  signInButton: {
    background: "var(--piq-primary)",
    color: "white",
    border: "none",
    borderRadius: 10,
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
    background: "var(--piq-primary-dark)",
    color: "white",
    padding: "14px 16px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: 700,
  },
  signOutButton: {
    background: "rgba(255,255,255,0.15)",
    color: "white",
    border: "none",
    borderRadius: 8,
    padding: "6px 12px",
    fontSize: 13,
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
    boxShadow: "0 -2px 8px rgba(0,0,0,0.05)",
  },
  logModeRow: {
    display: "flex",
    gap: 8,
    background: "var(--piq-bg)",
    borderRadius: 12,
    padding: 4,
  },
  logModeButton: {
    flex: 1,
    border: "none",
    background: "none",
    borderRadius: 9,
    padding: "10px 0",
    fontSize: 14,
    fontWeight: 600,
    color: "var(--piq-text-muted)",
    cursor: "pointer",
  },
  logModeButtonActive: {
    background: "var(--piq-card-bg)",
    color: "var(--piq-primary-dark)",
    boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
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
