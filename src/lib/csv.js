import { toDate } from "./time";

// Cells starting with these are run as formulas by Excel/Sheets.
const FORMULA_START = /^[=+\-@\t\r]/;

function cell(value) {
  if (value === null || value === undefined) return "";
  let v = value;
  const asDate = typeof v === "object" ? toDate(v) : null;
  if (asDate) v = asDate.toISOString();
  else if (typeof v === "object") v = JSON.stringify(v);
  let s = String(v);
  if (typeof value === "string" && FORMULA_START.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * @param {Array<object>} rows
 * @param {Array<{header: string, key?: string, get?: (row) => any}>} columns
 * @returns {string} CSV with a UTF-8 BOM (so Excel reads "°F" correctly)
 */
export function toCsv(rows, columns) {
  const lines = [columns.map((c) => cell(c.header)).join(",")];
  for (const row of rows) {
    lines.push(
      columns.map((c) => cell(c.get ? c.get(row) : row[c.key])).join(",")
    );
  }
  return "﻿" + lines.join("\r\n") + "\r\n";
}

/**
 * Phones get the share sheet (Save to Files, AirDrop, Mail); desktops get a
 * download. Must be called directly from a tap handler — iOS rejects
 * navigator.share once the tap's user-activation has lapsed.
 *
 * @returns {Promise<"shared"|"cancelled"|"downloaded">}
 */
export async function shareOrDownloadCsv(filename, csv) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const isTouch =
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia("(pointer: coarse)").matches;

  if (isTouch && navigator.canShare && typeof File !== "undefined") {
    const file = new File([blob], filename, { type: "text/csv" });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: filename });
        return "shared";
      } catch (err) {
        if (err && err.name === "AbortError") return "cancelled";
      }
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return "downloaded";
}
