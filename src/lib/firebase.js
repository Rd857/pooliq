// src/lib/firebase.js
//
// Central Firebase bootstrap for PoolIQ.
//
// This file is defensive by design: in Phase 1 there are no real Firebase
// credentials available in this environment. Ryan will paste real values
// into `.env.local` (see .env.example) once the pooliq-f401b Firebase
// project is wired up. Until then, every REACT_APP_FIREBASE_* var is empty,
// so we skip calling initializeApp() entirely and export `null` for `app`,
// `db`, and `auth`. Consumers (App.jsx especially) must check
// `isFirebaseConfigured` before touching `db`/`auth` so the app renders a
// clear "not configured" screen instead of crashing.

import { initializeApp, getApps } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth, GoogleAuthProvider } from "firebase/auth";

const firebaseConfig = {
  apiKey: process.env.REACT_APP_FIREBASE_API_KEY,
  authDomain: process.env.REACT_APP_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.REACT_APP_FIREBASE_PROJECT_ID,
  storageBucket: process.env.REACT_APP_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.REACT_APP_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.REACT_APP_FIREBASE_APP_ID,
};

// Consider Firebase "configured" only when the two required identifiers are
// present. The other fields matter for specific features but these two are
// enough to tell a real project from an empty .env.
export const isFirebaseConfigured = Boolean(
  firebaseConfig.apiKey && firebaseConfig.projectId
);

let app = null;
let db = null;
let auth = null;
let googleProvider = null;

if (isFirebaseConfigured) {
  try {
    app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
    db = getFirestore(app);
    auth = getAuth(app);
    googleProvider = new GoogleAuthProvider();
  } catch (err) {
    // Defensive: a malformed config shouldn't crash the whole app.
    // eslint-disable-next-line no-console
    console.error("PoolIQ: Firebase failed to initialize.", err);
    app = null;
    db = null;
    auth = null;
    googleProvider = null;
  }
} else {
  // eslint-disable-next-line no-console
  console.warn(
    "PoolIQ: Firebase is not configured. Copy .env.example to .env.local " +
      "and fill in the pooliq-f401b project values to enable sign-in and sync."
  );
}

export { app, db, auth, googleProvider };

/*
 * Firestore collection structure
 * -------------------------------
 * logs (auto-id docs)
 *   date, time, pH, fc, tc, ta, ch, cya, salt, waterTemp, testedBy, notes, createdAt
 *
 * config/pool (single doc)
 *   volumeGallons (null until Ryan sets it), surfaceType ("Pebble Sheen"),
 *   installDate, contractor, ownerName, hasSWG (false)
 *
 * calibration (auto-id docs, Phase 3 — shape only, no UI yet)
 *   timestamp, actualFC, modelFC, uvIndex, solarRad, waterTemp, kTot
 */
