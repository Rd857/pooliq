// src/lib/carbonate.js
//
// Carbonate chemistry for pH, total alkalinity, and calcite saturation.
//
// Equilibrium constants are temperature-dependent (Plummer & Busenberg 1982
// for K1, K2, KH and calcite Ksp; Harned & Owen for Kw). Activity
// coefficients use the Davies equation with ionic strength estimated from
// TDS (I ≈ 2.5e-5 × TDS mg/L). Cyanurate alkalinity is subtracted from the
// measured TA (cyanuric acid pKa 6.88). Ion pairing (CaHCO3+, CaCO3°) and
// borates are ignored, as in the usual pool CSI calculation.
//
// State variables: TA (ppm as CaCO3) and DIC (mol/L). Adding acid lowers TA
// with DIC unchanged; CO2 outgassing lowers DIC with TA unchanged. That
// pair is why pH climbs after an acid dose while TA doesn't recover.

const KELVIN = 273.15;
const MG_PER_EQ_CACO3 = 50043; // mg CaCO3 per equivalent
const MG_PER_MOL_CACO3 = 100087;
const MG_PER_MOL_CYA = 129070;
const K_CYA = 10 ** -6.88;
const LITERS_PER_GAL = 3.78541;

/** Atmospheric CO2, atm (~425 ppm, 2026). */
export const PCO2_ATM = 4.25e-4;

/** Moles of HCl per US fl oz of 31.45% (20° Baumé) muriatic acid. */
export const MURIATIC_MOL_PER_FLOZ = 0.2958;
/** Moles of Na2CO3 per oz (weight) of soda ash. */
export const SODA_ASH_MOL_PER_OZ = 28.3495 / 105.988;
/** Moles of NaHCO3 per lb of baking soda. */
export const BAKING_SODA_MOL_PER_LB = 453.592 / 84.007;

export const fToC = (f) => ((f - 32) * 5) / 9;

const constantsCache = new Map();

/** Thermodynamic constants at a temperature (°C). */
export function constants(tempC) {
  const key = Math.round(tempC * 10);
  const cached = constantsCache.get(key);
  if (cached) return cached;
  const T = key / 10 + KELVIN;
  const lT = Math.log10(T);
  const T2 = T * T;
  const k = {
    K1: 10 ** (-356.3094 - 0.06091964 * T + 21834.37 / T + 126.8339 * lT - 1684915 / T2),
    K2: 10 ** (-107.8871 - 0.03252849 * T + 5151.79 / T + 38.92561 * lT - 563713.9 / T2),
    KH: 10 ** (108.3865 + 0.01985076 * T - 6919.53 / T - 40.45154 * lT + 669365 / T2),
    Kw: 10 ** (-4470.99 / T + 6.0875 - 0.01706 * T),
    Ksp: 10 ** (-171.9065 - 0.077993 * T + 2839.319 / T + 71.595 * lT),
    A: 0.4883 + 0.000804 * (key / 10), // Debye–Hückel A (0.509 at 25 °C)
  };
  constantsCache.set(key, k);
  return k;
}

function davies(I, z, A) {
  const s = Math.sqrt(I);
  return 10 ** (-A * z * z * (s / (1 + s) - 0.3 * I));
}

/** Ionic strength from total dissolved solids (Langelier's approximation). */
export function ionicStrength(tdsPpm) {
  return 2.5e-5 * (tdsPpm > 0 ? tdsPpm : 1000);
}

const activityCache = new Map();

function activity(tempC, I) {
  const key = `${Math.round(tempC * 10)}|${I}`;
  let a = activityCache.get(key);
  if (!a) {
    const k = constants(tempC);
    a = { k, g1: davies(I, 1, k.A), g2: davies(I, 2, k.A) };
    activityCache.set(key, a);
  }
  return a;
}

function speciation(pH, tempC, I) {
  const { k, g1, g2 } = activity(tempC, I);
  const aH = 10 ** -pH;
  return {
    k,
    g1,
    g2,
    r1: k.K1 / (aH * g1), // [HCO3-]/[CO2]
    r2: (k.K2 * g1) / (aH * g2), // [CO3--]/[HCO3-]
    oh: k.Kw / (aH * g1),
    h: aH / g1,
    cyaFrac: 1 / (1 + (aH * g1) / K_CYA),
  };
}

// Non-carbonate alkalinity (eq/L): cyanurate + OH- − H+.
function otherAlk(s, cyaPpm) {
  return ((cyaPpm > 0 ? cyaPpm : 0) / MG_PER_MOL_CYA) * s.cyaFrac + s.oh - s.h;
}

// TA (eq/L) implied by a DIC at a given pH.
function taFromDic(pH, dic, cyaPpm, tempC, I) {
  const s = speciation(pH, tempC, I);
  const denom = 1 + s.r1 + s.r1 * s.r2;
  return (dic * (s.r1 + 2 * s.r1 * s.r2)) / denom + otherAlk(s, cyaPpm);
}

function bisect(f, lo, hi, iterations = 60) {
  let a = lo;
  let b = hi;
  for (let i = 0; i < iterations; i++) {
    const m = (a + b) / 2;
    if (f(m) > 0) b = m;
    else a = m;
  }
  return (a + b) / 2;
}

/**
 * Carbonate state from a measured pH and TA.
 * @returns {{dic: number, co2: number, carbAlkPpm: number}} mol/L, mol/L, ppm
 */
export function stateFromPhTa({ pH, ta, cya = 0, tempC, I }) {
  const s = speciation(pH, tempC, I);
  const carbAlk = ta / MG_PER_EQ_CACO3 - otherAlk(s, cya);
  const co2 = Math.max(0, carbAlk) / (s.r1 * (1 + 2 * s.r2));
  return {
    dic: co2 * (1 + s.r1 + s.r1 * s.r2),
    co2,
    carbAlkPpm: carbAlk * MG_PER_EQ_CACO3,
  };
}

/**
 * pH from DIC (mol/L) and TA (ppm). With a `guess` (e.g. the previous step's
 * pH) it uses Newton's method, falling back to bisection.
 */
export function phFromState({ dic, ta, cya = 0, tempC, I, guess }) {
  const target = ta / MG_PER_EQ_CACO3;
  const f = (pH) => taFromDic(pH, dic, cya, tempC, I) - target;
  if (typeof guess === "number") {
    let x = guess;
    for (let i = 0; i < 12; i++) {
      const fx = f(x);
      const d = (f(x + 1e-4) - fx) / 1e-4;
      if (!(d > 0)) break;
      const next = x - fx / d;
      if (!(next > 4 && next < 11)) break;
      if (Math.abs(next - x) < 1e-7) return next;
      x = next;
    }
  }
  return bisect(f, 4, 11, 50);
}

/** Dissolved CO2 (mol/L) for a DIC at a pH. */
export function co2FromState({ dic, pH, tempC, I }) {
  const s = speciation(pH, tempC, I);
  return dic / (1 + s.r1 + s.r1 * s.r2);
}

/** CO2(aq) in equilibrium with the atmosphere (mol/L). */
export function co2Equilibrium(tempC, pco2 = PCO2_ATM) {
  return constants(tempC).KH * pco2;
}

/** The pH the water drifts toward once CO2 fully equilibrates with air. */
export function equilibriumPH({ ta, cya = 0, tempC, I, pco2 = PCO2_ATM }) {
  const co2 = co2Equilibrium(tempC, pco2);
  const target = ta / MG_PER_EQ_CACO3;
  return bisect((pH) => {
    const s = speciation(pH, tempC, I);
    return co2 * s.r1 * (1 + 2 * s.r2) + otherAlk(s, cya) - target;
  }, 4, 11, 50);
}

/**
 * Calcite Saturation Index: log10(a_Ca · a_CO3 / Ksp). Below −0.3 the water
 * dissolves plaster/pebble finishes; above +0.3 it deposits scale.
 */
export function csi({ pH, ta, ch, cya = 0, tempC, I }) {
  if (!(ch > 0)) return null;
  const s = speciation(pH, tempC, I);
  const carbAlk = ta / MG_PER_EQ_CACO3 - otherAlk(s, cya);
  if (!(carbAlk > 0)) return null;
  const co2 = carbAlk / (s.r1 * (1 + 2 * s.r2));
  const co3 = co2 * s.r1 * s.r2;
  const ca = ch / MG_PER_MOL_CACO3;
  return Math.log10((s.g2 * ca * s.g2 * co3) / s.k.Ksp);
}

/**
 * Chemical needed to move pH to a target at the current TA/DIC — exact
 * carbonate chemistry, so it accounts for TA buffering.
 *
 * @returns {{chemical: "muriatic"|"sodaAsh", amount: number, unit: string,
 *   taAfter: number}|null}
 */
export function phAdjustment({ pH, ta, cya = 0, tempC, I, targetPH, volumeGal }) {
  if (!(volumeGal > 0) || !(ta > 0)) return null;
  const liters = volumeGal * LITERS_PER_GAL;
  const { dic } = stateFromPhTa({ pH, ta, cya, tempC, I });
  if (targetPH < pH) {
    // Acid: TA falls, DIC unchanged.
    const taTarget = taFromDic(targetPH, dic, cya, tempC, I) * MG_PER_EQ_CACO3;
    const eqPerL = (ta - taTarget) / MG_PER_EQ_CACO3;
    if (eqPerL <= 0) return null;
    return {
      chemical: "muriatic",
      amount: (eqPerL * liters) / MURIATIC_MOL_PER_FLOZ,
      unit: "fl oz",
      taAfter: taTarget,
    };
  }
  if (targetPH > pH) {
    // Soda ash: +2 eq alkalinity and +1 mol DIC per mole.
    const molPerL = bisect(
      (n) =>
        phFromState({
          dic: dic + n,
          ta: ta + 2 * n * MG_PER_EQ_CACO3,
          cya,
          tempC,
          I,
        }) - targetPH,
      0,
      0.01,
      50
    );
    return {
      chemical: "sodaAsh",
      amount: (molPerL * liters) / SODA_ASH_MOL_PER_OZ,
      unit: "oz",
      taAfter: ta + 2 * molPerL * MG_PER_EQ_CACO3,
    };
  }
  return null;
}

/**
 * Change in TA (ppm) and DIC (mol/L) from a logged dose.
 * @param {{label: string, amount: number}} dose
 */
export function doseCarbonateEffect(dose, volumeGal) {
  if (!dose || !(volumeGal > 0) || !(dose.amount > 0)) return null;
  const liters = volumeGal * LITERS_PER_GAL;
  const perL = (mol) => mol / liters;
  switch (dose.label) {
    case "pH (lower)": {
      const n = perL(dose.amount * MURIATIC_MOL_PER_FLOZ);
      return { dTa: -n * MG_PER_EQ_CACO3, dDic: 0 };
    }
    case "pH (raise)": {
      const n = perL(dose.amount * SODA_ASH_MOL_PER_OZ);
      return { dTa: 2 * n * MG_PER_EQ_CACO3, dDic: n };
    }
    case "Total Alkalinity": {
      const n = perL(dose.amount * BAKING_SODA_MOL_PER_LB);
      return { dTa: n * MG_PER_EQ_CACO3, dDic: n };
    }
    default:
      return null;
  }
}
