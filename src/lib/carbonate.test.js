import {
  constants,
  csi,
  doseCarbonateEffect,
  equilibriumPH,
  fToC,
  ionicStrength,
  phAdjustment,
  phFromState,
  stateFromPhTa,
} from "./carbonate";

const I = ionicStrength(1000);

test("constants match textbook values at 25 °C", () => {
  const k = constants(25);
  expect(-Math.log10(k.K1)).toBeCloseTo(6.35, 1);
  expect(-Math.log10(k.K2)).toBeCloseTo(10.33, 1);
  expect(k.KH).toBeCloseTo(0.034, 3);
  expect(-Math.log10(k.Kw)).toBeCloseTo(14.0, 1);
  expect(Math.log10(k.Ksp)).toBeCloseTo(-8.48, 1);
});

test("pH ↔ DIC round trip", () => {
  const w = { pH: 7.55, ta: 90, cya: 40, tempC: 29, I };
  const { dic } = stateFromPhTa(w);
  expect(phFromState({ dic, ta: w.ta, cya: w.cya, tempC: w.tempC, I })).toBeCloseTo(7.55, 4);
});

test("water with TA 100 drifts toward pH ~8.4 in air", () => {
  const eq = equilibriumPH({ ta: 100, cya: 0, tempC: 25, I });
  expect(eq).toBeGreaterThan(8.2);
  expect(eq).toBeLessThan(8.6);
  // Lower TA → lower equilibrium pH.
  expect(equilibriumPH({ ta: 60, cya: 0, tempC: 25, I })).toBeLessThan(eq);
});

test("CSI agrees with the Langelier index within 0.15", () => {
  const tempF = 80;
  const tK = fToC(tempF) + 273.15;
  const pHs =
    9.3 + (Math.log10(1000) - 1) / 10 + (-13.12 * Math.log10(tK) + 34.55) -
    (Math.log10(300) - 0.4 + Math.log10(100));
  const lsi = 7.5 - pHs;
  const value = csi({ pH: 7.5, ta: 100, ch: 300, cya: 0, tempC: fToC(tempF), I });
  expect(Math.abs(value - lsi)).toBeLessThan(0.15);
});

test("CYA lowers CSI (its alkalinity isn't carbonate)", () => {
  const base = { pH: 7.5, ta: 90, ch: 350, tempC: 28, I };
  expect(csi({ ...base, cya: 45 })).toBeLessThan(csi({ ...base, cya: 0 }));
});

test("acid and soda-ash amounts are the right size and round-trip", () => {
  const w = { pH: 7.8, ta: 100, cya: 40, tempC: 28, I, volumeGal: 10000 };
  const acid = phAdjustment({ ...w, targetPH: 7.5 });
  expect(acid.chemical).toBe("muriatic");
  expect(acid.amount).toBeGreaterThan(8);
  expect(acid.amount).toBeLessThan(30);

  const { dic } = stateFromPhTa(w);
  const eff = doseCarbonateEffect({ label: "pH (lower)", amount: acid.amount }, 10000);
  const after = phFromState({ dic: dic + eff.dDic, ta: w.ta + eff.dTa, cya: 40, tempC: 28, I });
  expect(after).toBeCloseTo(7.5, 3);

  const base = phAdjustment({ ...w, pH: 7.2, targetPH: 7.5 });
  expect(base.chemical).toBe("sodaAsh");
  expect(base.amount).toBeGreaterThan(3);
  expect(base.amount).toBeLessThan(25);
});
