# PoolIQ

A personal, single-user pool-chemistry tracking PWA for a Pebble Sheen
(pebble-finish plaster) pool in Oldsmar, FL. One-tap chemistry logging, a
weather-driven free-chlorine decay estimate between tests, a dosing
calculator, and history charts — with every log entry eventually syncing to
a Google Sheet for pool-warranty documentation.

## Status: Phase 3 — live weather Worker wired in (pooliq-weather.dunnrd.workers.dev)

The full front-end app is built and wired for Firebase + weather, but this
session had **no live API keys or cloud accounts**. Everything that needs a
secret degrades gracefully to a clear "not configured" state instead of
crashing.

Done in Phase 1/2 (this session, locally):
- CRA (react-scripts) app scaffolded — Dashboard / Log / History / Dosing
  tabs via a bottom nav, no react-router.
- `src/lib/firebase.js` — Firestore + Google Auth bootstrap, no-op/safe when
  env vars are empty.
- `src/lib/chlorineModel.js` — the free-chlorine decay model (bulk + solar +
  surface decay, temperature and pH-speciation corrected), all labeled
  "Estimated."
- `src/lib/ambientWeather.js` — weather fetch via a Cloudflare Worker proxy,
  with a graceful "unavailable" fallback.
- `src/lib/dosing.js` — standard dosing rule-of-thumb table, gated behind a
  known pool volume.
- `functions/index.js` — Firestore→Google Sheets Cloud Function, authored
  but not deployed.
- `workers/pooliq-weather/index.js` — Ambient Weather proxy Worker,
  authored but not deployed.
- Local git repo initialized with an initial commit.

Still pending (next phases / Ryan's own account access):
- Paste real Firebase config values into `.env.local` (project
  `pooliq-f401b`, already created with Firestore + Google Auth enabled).
- Create a GitHub repo and push this code (needs Ryan's GitHub auth).
- Deploy the Cloudflare Worker (`workers/pooliq-weather/`) with real Ambient
  Weather API keys, then set `REACT_APP_WEATHER_WORKER_URL`.
- Provide a Google Sheet ID + share it with a service account, and upgrade
  the Firebase project to the Blaze plan, to deploy `functions/index.js`.
- Set the actual pool volume (`config/pool.volumeGallons` in Firestore) —
  unknown for now, intentionally left unset. The Dosing tab stays gated
  until it's set.
- Phase 3: a `calibration` collection (shape already defined in
  `src/lib/firebase.js` comments) to tune the decay model against real
  readings.

## Running locally

```bash
npm install
cp .env.example .env.local   # fill in real values later; blank is fine for now
npm start
```

With `.env.local` blank, the app shows a "Firebase not configured" screen
instead of crashing — that's expected until real Firebase config is added.

```bash
npm run build   # production build to /build
```

## Environment variables

See `.env.example` for the full list and comments. All must keep the
`REACT_APP_` prefix (a CRA requirement — only prefixed vars are exposed to
the browser bundle):

```
REACT_APP_FIREBASE_API_KEY
REACT_APP_FIREBASE_AUTH_DOMAIN
REACT_APP_FIREBASE_PROJECT_ID
REACT_APP_FIREBASE_STORAGE_BUCKET
REACT_APP_FIREBASE_MESSAGING_SENDER_ID
REACT_APP_FIREBASE_APP_ID
REACT_APP_WEATHER_WORKER_URL
```

## Deployment target

Cloudflare Pages, framework preset "Create React App", build command
`npm run build`, output directory `build`. Not deployed yet — that's a
separate step requiring Ryan's own Cloudflare account.

## Data model (Firestore)

- `logs` (auto-id docs): `date, time, pH, fc, tc, ta, ch, cya, salt,
  waterTemp, testedBy, notes, createdAt`
- `config/pool` (single doc): `volumeGallons` (null until set),
  `surfaceType` ("Pebble Sheen"), `installDate`, `contractor`,
  `ownerName`, `hasSWG` (false — no salt water generator on this pool;
  the `salt` field exists for warranty-sheet column parity only)
- `calibration` (Phase 3, shape only): `timestamp, actualFC, modelFC,
  uvIndex, solarRad, waterTemp, kTot`

Pebble Sheen warranty target ranges used for color coding: pH 7.2–7.8,
Free Chlorine 1.0–3.0 ppm, Total Chlorine 1.0–5.0 ppm, Total Alkalinity
80–120 ppm, Calcium Hardness 200–400 ppm, CYA/Stabilizer 30–50 ppm, Water
Temp 60–104°F. (Salt 2700–3400 ppm is tracked but not warranty-flagged
since this pool has no SWG.)
