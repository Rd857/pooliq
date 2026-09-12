/**
 * functions/index.js
 *
 * NOTE: This file is AUTHORED for Phase 1 but NOT deployed. Deploying it
 * requires:
 *   1. Upgrading the pooliq-f401b Firebase project to the Blaze
 *      (pay-as-you-go) plan — Cloud Functions require Blaze even for
 *      free-tier usage.
 *   2. A Google Sheet Ryan creates (or the existing pool_chemistry_tracker
 *      warranty sheet) with its Sheet ID recorded below.
 *   3. A service account with Sheets API access, sharing "Editor" access on
 *      that spreadsheet with the service account's email address.
 *   4. Running `firebase init functions` in this directory (not done here)
 *      and `firebase deploy --only functions`.
 *
 * What it does: a Firestore trigger fires whenever a new document is
 * created in the `logs` collection, and appends one row to the target
 * Google Sheet ("PoolIQ", a copy of the original pool_chemistry_tracker
 * warranty sheet — see https://docs.google.com/spreadsheets/d/1G67uahgg1Gd4wiDN8HvfUEgTx3J2RK6RjJgFUCu4SoM),
 * in its exact column order:
 *
 *   A Date (MM/dd/yyyy)
 *   B Time (h:mm a)
 *   C pH
 *   D Free Chlorine (ppm)
 *   E Total Chlorine (ppm)
 *   F Total Alkalinity (ppm)
 *   G Calcium Hardness (ppm)
 *   H CYA/Stabilizer (ppm)
 *   I Salt (ppm)
 *   J Water Temp (°F)
 *   K Tested By
 *   L Notes
 *   M Air Temp (°F)
 *   N Humidity (%)
 *   O UV Index
 *   P Weekly Rain (in) — actually the daily-rain-to-date reading from
 *     Ambient Weather (`dailyrainin`); the sheet's header predates this
 *     sync and calls it "Weekly", left as-is to match the existing tab.
 *   Q Solar Rad (W/m^2)
 *   R Wind (mph)
 *
 * M-R come from a best-effort weather snapshot LogEntry.jsx takes at the
 * moment of logging (see src/components/LogEntry.jsx and
 * src/lib/ambientWeather.js) and stores on the Firestore doc — this
 * function does not call Ambient Weather itself. If the client couldn't
 * reach the weather worker when the entry was logged, those fields are
 * null and the corresponding Sheet cells are left blank.
 */

const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { initializeApp } = require("firebase-admin/app");
const { google } = require("googleapis");

initializeApp();

// The target spreadsheet: "PoolIQ" in Ryan's "Pool Chemistry" Drive folder,
// a copy of the original warranty tracker (kept separate from the live
// pool_chemistry_tracker sheet the old Apple Shortcut still writes to daily
// — this function must never touch that one). Overridable via env var for
// local testing / if the sheet ever moves.
//
// This function runs as the dedicated pooliq-sheets-sync service account
// (see the `serviceAccount` option below), which has been shared as Editor
// on the target Sheet directly — no IAM roles, no downloaded key file.
// Optionally override via env var if the sheet ID or tab name ever changes:
//   firebase functions:config:set sheets.spreadsheet_id="<SHEET_ID>"
const SHEET_ID =
  process.env.SHEET_ID || "1G67uahgg1Gd4wiDN8HvfUEgTx3J2RK6RjJgFUCu4SoM";
const SHEET_TAB_NAME = process.env.SHEET_TAB_NAME || "Chemistry Log";

const SYNC_SERVICE_ACCOUNT =
  "pooliq-sheets-sync@pooliq-f401b.iam.gserviceaccount.com";

// Cloud Functions supplies Application Default Credentials for whichever
// service account the function runs as (set via `serviceAccount` below) —
// no key file to manage or leak.
async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const authClient = await auth.getClient();
  return google.sheets({ version: "v4", auth: authClient });
}

function formatDate(dateStr) {
  // Expects log.date as "YYYY-MM-DD" (from the LogEntry date input).
  if (!dateStr) return "";
  const [y, m, d] = dateStr.split("-");
  if (!y || !m || !d) return dateStr;
  return `${m}/${d}/${y}`;
}

function formatTime(timeStr) {
  // Expects log.time as "HH:MM" 24-hour (from the LogEntry time input).
  if (!timeStr) return "";
  const [hStr, mStr] = timeStr.split(":");
  let h = parseInt(hStr, 10);
  const suffix = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${mStr} ${suffix}`;
}

exports.syncLogToSheet = onDocumentCreated(
  { document: "logs/{logId}", serviceAccount: SYNC_SERVICE_ACCOUNT },
  async (event) => {
  if (!SHEET_ID) {
    console.warn(
      "SHEET_ID is not configured — skipping Google Sheets sync. " +
        "Set it via functions config or env var once Ryan provides the " +
        "warranty spreadsheet ID."
    );
    return;
  }

  const log = event.data && event.data.data();
  if (!log) {
    console.warn("No log data found on the triggering document; skipping.");
    return;
  }

  const row = [
    formatDate(log.date),
    formatTime(log.time),
    log.pH ?? "",
    log.fc ?? "",
    log.tc ?? "",
    log.ta ?? "",
    log.ch ?? "",
    log.cya ?? "",
    log.salt ?? "",
    log.waterTemp ?? "",
    log.testedBy ?? "",
    log.notes ?? "",
    log.weatherAirTempF ?? "",
    log.weatherHumidityPct ?? "",
    log.weatherUvIndex ?? "",
    log.weatherRainIn ?? "",
    log.weatherSolarRad ?? "",
    log.weatherWindMph ?? "",
  ];

  try {
    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB_NAME}!A:R`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [row] },
    });
    console.log(`Appended log ${event.params.logId} to Google Sheet.`);
  } catch (err) {
    console.error("Failed to append log to Google Sheet:", err);
    // Re-throw so the function shows as failed in Cloud Functions logs /
    // monitoring, rather than silently swallowing sync failures.
    throw err;
  }
  }
);
