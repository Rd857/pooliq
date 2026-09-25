// src/lib/dosing.js
//
// Dosing approximations for common pool-chemistry adjustments. These are
// standard, widely-published industry rules of thumb (not proprietary to
// any product), expressed per 10,000 gallons of pool water.
//
// EVERY number here is APPROXIMATE. Real product concentrations vary by
// brand/formulation, so Ryan should verify against the actual product
// label before dosing. That caveat must be visible wherever this module's
// output is shown in the UI (see Dosing.jsx).
//
// Dose scaling:
//   dose = referenceAmount * (volumeGallons / 10000) * (targetMidpoint - currentValue) / changePerUnit
//
// i.e. referenceAmount is "how much chemical it takes to move the
// parameter by `changePerUnit` in a 10,000 gallon pool," and we scale
// linearly by both pool size and by how far off target we are.

import { fromLocalDateTime, toDate } from "./time";

/**
 * @typedef {object} DosingRule
 * @property {string} parameter - key matching a log field (fc, cya, ta, ch, pH)
 * @property {string} label - human label
 * @property {string} chemical
 * @property {string} unit - unit of the dose amount (fl oz, oz, lb)
 * @property {number} changePerUnit - how much the reading changes per referenceAmount
 * @property {number} referenceAmount - amount of chemical (in `unit`) per 10,000 gal
 * @property {"increase"|"decrease"} direction
 * @property {boolean} [nonLinear] - flag rough/non-linear relationships (esp. pH)
 */

/** @type {DosingRule[]} */
export const DOSING_TABLE = [
  {
    parameter: "fc",
    label: "Free Chlorine",
    chemical: "Liquid chlorine (12.5%)",
    unit: "fl oz",
    changePerUnit: 1, // ppm FC raised
    referenceAmount: 10.4, // fl oz per 10,000 gal to raise FC by 1 ppm
    direction: "increase",
  },
  {
    parameter: "cya",
    label: "CYA / Stabilizer",
    chemical: "Granular stabilizer (cyanuric acid)",
    unit: "oz",
    changePerUnit: 10, // ppm CYA raised
    referenceAmount: 13, // oz per 10,000 gal to raise CYA by 10 ppm
    direction: "increase",
  },
  {
    parameter: "ta",
    label: "Total Alkalinity",
    chemical: "Sodium bicarbonate (baking soda)",
    unit: "lb",
    changePerUnit: 10, // ppm TA raised
    referenceAmount: 1.5, // lb per 10,000 gal to raise TA by 10 ppm
    direction: "increase",
  },
  {
    parameter: "ch",
    label: "Calcium Hardness",
    chemical: "Calcium chloride",
    unit: "lb",
    changePerUnit: 10, // ppm CH raised
    referenceAmount: 1.25, // lb per 10,000 gal to raise CH by 10 ppm
    direction: "increase",
  },
  {
    parameter: "pH",
    label: "pH (raise)",
    chemical: "Soda ash",
    unit: "oz",
    changePerUnit: 0.2, // pH units raised, approximate/non-linear
    referenceAmount: 6, // oz per 10,000 gal to raise pH by ~0.2
    direction: "increase",
    nonLinear: true,
  },
  {
    parameter: "pH",
    label: "pH (lower)",
    chemical: "Muriatic acid (31.45%)",
    unit: "fl oz",
    changePerUnit: 0.2, // pH units lowered, approximate/non-linear, also affects TA
    referenceAmount: 10, // oz per 10,000 gal to lower pH by ~0.2
    direction: "decrease",
    nonLinear: true,
  },
];

/**
 * Compute a dose recommendation for a single rule.
 *
 * @param {DosingRule} rule
 * @param {number} volumeGallons
 * @param {number} currentValue
 * @param {number} targetMidpoint
 * @returns {{amount: number, unit: string, chemical: string, label: string, direction: string, nonLinear: boolean}|null}
 *   null if the delta doesn't call for this rule's direction (e.g. asking to
 *   raise pH when current is already above target), or inputs are invalid.
 */
export function computeDose(rule, volumeGallons, currentValue, targetMidpoint) {
  if (
    !rule ||
    !volumeGallons ||
    volumeGallons <= 0 ||
    currentValue === undefined ||
    currentValue === null ||
    Number.isNaN(currentValue) ||
    targetMidpoint === undefined ||
    targetMidpoint === null
  ) {
    return null;
  }

  const delta = targetMidpoint - currentValue;

  // Only recommend a dose that matches this rule's direction.
  if (rule.direction === "increase" && delta <= 0) return null;
  if (rule.direction === "decrease" && delta >= 0) return null;

  const magnitude = Math.abs(delta);
  const scale = volumeGallons / 10000;
  const amount = rule.referenceAmount * scale * (magnitude / rule.changePerUnit);

  return {
    amount: Math.round(amount * 100) / 100,
    unit: rule.unit,
    chemical: rule.chemical,
    label: rule.label,
    direction: rule.direction,
    nonLinear: Boolean(rule.nonLinear),
  };
}

/**
 * Compute recommendations for all applicable rules given current readings
 * and target midpoints, e.g.:
 *   computeAllDoses(10000, { fc: 0.5, cya: 20, ta: 60, ch: 150, pH: 7.0 }, TARGETS)
 *
 * @param {number} volumeGallons
 * @param {object} currentValues - { fc, cya, ta, ch, pH }
 * @param {object} targetMidpoints - { fc, cya, ta, ch, pH }
 * @returns {Array} list of dose recommendations (only rules that apply)
 */
export function computeAllDoses(volumeGallons, currentValues, targetMidpoints) {
  return DOSING_TABLE.map((rule) =>
    computeDose(
      rule,
      volumeGallons,
      currentValues[rule.parameter],
      targetMidpoints[rule.parameter]
    )
  ).filter(Boolean);
}

/**
 * Inverse of computeDose: how much a given amount of a chemical moves its
 * parameter in a pool of `volumeGallons`. Signed — negative for "decrease"
 * rules (e.g. muriatic acid lowering pH).
 *
 * @param {{label?: string, parameter?: string, chemical?: string, amount: number}} dose
 * @param {number} volumeGallons
 * @returns {{parameter: string, change: number}|null}
 */
export function doseEffect(dose, volumeGallons) {
  if (!dose || !volumeGallons || volumeGallons <= 0) return null;
  const amount = Number(dose.amount);
  if (!(amount > 0)) return null;
  const rule =
    DOSING_TABLE.find((r) => r.label === dose.label) ||
    DOSING_TABLE.find(
      (r) => r.parameter === dose.parameter && r.chemical === dose.chemical
    );
  if (!rule) return null;
  const scale = volumeGallons / 10000;
  const change = (amount / (rule.referenceAmount * scale)) * rule.changePerUnit;
  return {
    parameter: rule.parameter,
    change: rule.direction === "decrease" ? -change : change,
  };
}

/**
 * Firestore dose doc → {atMs, parameter, label, chemical, amount, unit, ppm}.
 * Prefers the ppm change stored at log time; older docs are recomputed from
 * the current pool volume.
 */
export function normalizeDose(doc, volumeGallons) {
  const at =
    toDate(doc.at) || fromLocalDateTime(doc.date, doc.time) || toDate(doc.createdAt);
  if (!at) return null;
  const effect =
    typeof doc.ppmChange === "number"
      ? { parameter: doc.parameter, change: doc.ppmChange }
      : doseEffect(doc, volumeGallons);
  return {
    atMs: at.getTime(),
    parameter: (effect && effect.parameter) || doc.parameter || null,
    label: doc.label ?? null,
    chemical: doc.chemical ?? null,
    amount: doc.amount ?? null,
    unit: doc.unit ?? null,
    ppm: effect ? effect.change : null,
  };
}

/** Standard caveat to show anywhere a dose amount is displayed. */
export const DOSING_CAVEAT =
  "Approximate — verify against your product label before dosing.";
