// Local (device-timezone) date/time helpers. Date.toISOString() is UTC, which
// in Florida rolls the date forward from 8 PM onward — don't use it for
// user-facing dates.

const pad = (n) => String(n).padStart(2, "0");

/** "YYYY-MM-DD" in local time. */
export function localDateISO(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "HH:MM" (24h) in local time. */
export function localTimeHHMM(d = new Date()) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Firestore Timestamp | Date | string | number → Date (or null). */
export function toDate(value) {
  if (value === undefined || value === null) return null;
  if (typeof value.toDate === "function") return value.toDate();
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Local Date from a "YYYY-MM-DD" + "HH:MM" pair (the form's date/time inputs). */
export function fromLocalDateTime(date, time) {
  if (!date || !time) return null;
  const d = new Date(`${date}T${time}:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}
