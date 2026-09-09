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
 * Google Sheet, in the exact column order of the existing
 * pool_chemistry_tracker.xlsx warranty sheet:
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
 */

const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { initializeApp } = require("firebase-admin/app");
const { google } = require("googleapis");

initializeApp();

// Ryan still needs to:
//   1. Create/locate the target Google Sheet and copy its ID out of the
//      URL: https://docs.google.com/spreadsheets/d/<SHEET_ID>/edit
//   2. Share that sheet with the service account's client_email
//      (Editor access) so appends succeed.
//   3. Set the ID via Firebase Functions config (v1 style, still supported
//      alongside v2 triggers) or as a deployed environment variable:
//        firebase functions:config:set sheets.spreadsheet_id="<SHEET_ID>"
//      or, for newer `functions.config()`-free setups, an environment
//      variable SHEET_ID on the function itself.
const SHEET_ID = process.env.SHEET_ID || "";
const SHEET_TAB_NAME = process.env.SHEET_TAB_NAME || "Sheet1";

// The service account key JSON should be provided via Application Default
// Credentials in the Cloud Functions runtime (the default runtime service
// account already has project-level credentials) OR, if a dedicated service
// account key is used, loaded via GOOGLE_APPLICATION_CREDENTIALS. We do NOT
// commit a service-account JSON to this repo — see .gitignore.
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

exports.syncLogToSheet = onDocumentCreated("logs/{logId}", async (event) => {
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
  ];

  try {
    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB_NAME}!A:L`,
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
});
