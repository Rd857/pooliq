import React, { useMemo, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useModel } from "../lib/modelData";
import { buildExport } from "../lib/exportData";
import { shareOrDownloadCsv } from "../lib/csv";
import { cyaShield } from "../lib/chlorineModel";
import { PH_HIGH } from "../lib/phModel";
import { PH_TARGET } from "../lib/forecast";
import { RANGES } from "../lib/ranges";
import { uvProfile } from "../lib/weatherHourly";

const TEAL = "#35E0C7";
const AMBER = "#F2B84B";
const MUTED = "#5C8481";
const INK = "#CFEFEA";
const PANEL = "#101C1F";
const DAY_MS = 24 * 3600 * 1000;

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

function fmtWhen(ms, nowMs) {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const dayDiff = Math.round(
    (new Date(d).setHours(0, 0, 0, 0) - new Date(nowMs).setHours(0, 0, 0, 0)) / DAY_MS
  );
  if (dayDiff === 0) return `today ${time}`;
  if (dayDiff === 1) return `tomorrow ${time}`;
  return `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

function fmtAge(tested, nowMs) {
  if (!tested) return "never tested";
  const days = Math.floor((nowMs - tested.t) / DAY_MS);
  return days <= 0 ? "tested today" : `tested ${days} d ago`;
}

const tickFmt = (t) =>
  new Date(t).toLocaleString([], { weekday: "short", hour: "numeric" }).replace(":00", "");

function timeTicks(start, end) {
  const ticks = [];
  const first = new Date(start);
  first.setMinutes(0, 0, 0);
  first.setHours(first.getHours() < 12 ? 12 : 24);
  for (let t = first.getTime(); t < end; t += 12 * 3600 * 1000) ticks.push(t);
  return ticks;
}

// Round-number axis ticks (steps of 1, 2, 2.5 or 5 × 10^n).
function niceTicks(lo, hi, count = 4) {
  const raw = Math.max(hi - lo, 1e-6) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const ticks = [];
  for (let v = Math.floor(lo / step) * step; v <= Math.ceil(hi / step) * step + step / 2; v += step) {
    ticks.push(Math.round(v * 1e6) / 1e6);
  }
  return ticks;
}

const signedChange = (v) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)}`;

function BandTooltip({ active, payload, unit, digits }) {
  if (!active || !payload || !payload.length) return null;
  const p = payload[0].payload;
  return (
    <div style={styles.tooltip}>
      <div style={{ color: MUTED }}>{tickFmt(p.t)}</div>
      {isNum(p.p50) && (
        <div>
          {p.p50.toFixed(digits)} {unit}{" "}
          <span style={{ color: MUTED }}>
            ({p.band[0].toFixed(digits)}–{p.band[1].toFixed(digits)})
          </span>
        </div>
      )}
      {isNum(p.actual) && (
        <div>
          measured {p.actual.toFixed(digits)} {unit}
        </div>
      )}
    </div>
  );
}

function BandChart({ points, nowMs, floorY, unit, digits, height = 200, minY = -Infinity }) {
  const data = points.map((p) => ({ t: p.t, band: [p.p10, p.p90], p50: p.p50 }));
  const start = data[0].t;
  const end = data[data.length - 1].t;
  const lows = points.map((p) => p.p10);
  const highs = points.map((p) => p.p90);
  if (isNum(floorY)) {
    lows.push(floorY);
    highs.push(floorY);
  }
  const yTicks = niceTicks(Math.max(minY, Math.min(...lows)), Math.max(...highs));
  return (
    <div style={{ width: "100%", height }}>
      <ResponsiveContainer>
        <ComposedChart data={data} margin={{ top: 14, right: 8, left: -18, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--piq-border)" />
          <XAxis
            dataKey="t"
            type="number"
            domain={[start, end]}
            ticks={timeTicks(start, end)}
            tickFormatter={tickFmt}
            tick={{ fontSize: 10, fill: MUTED }}
            stroke={MUTED}
          />
          <YAxis
            tick={{ fontSize: 10, fill: MUTED }}
            stroke={MUTED}
            domain={[yTicks[0], yTicks[yTicks.length - 1]]}
            ticks={yTicks}
          />
          <Tooltip content={<BandTooltip unit={unit} digits={digits} />} />
          <Area dataKey="band" stroke="none" fill={TEAL} fillOpacity={0.14} isAnimationActive={false} />
          <Line dataKey="p50" stroke={TEAL} strokeWidth={2} dot={false} isAnimationActive={false} />
          {isNum(floorY) && (
            <ReferenceLine
              y={floorY}
              stroke={AMBER}
              strokeDasharray="4 3"
              label={{ value: `${floorY.toFixed(1)}`, position: "insideTopLeft", fill: AMBER, fontSize: 10 }}
            />
          )}
          {nowMs > start && nowMs < end && (
            <ReferenceLine
              x={nowMs}
              stroke={MUTED}
              label={{ value: "now", position: "top", fill: MUTED, fontSize: 10 }}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---- Free chlorine ------------------------------------------------------------------

function ChlorineCard({ result }) {
  const f = result.fc.forecast;
  if (!f) {
    return (
      <div style={styles.card}>
        <div style={styles.sectionTitle}>Free chlorine · next 72 h</div>
        <div style={styles.muted}>Log a chlorine reading to start the forecast.</div>
      </div>
    );
  }
  const { nowMs } = result;
  const floor = result.fc.floor;
  const cya = result.chem.cya.value;
  const below = f.now.p50 < floor;
  const soon = below || (f.dueEarlyMs && f.dueEarlyMs - nowMs < 36 * 3600 * 1000);
  const add = result.fc.chlorineNow;
  const warrantyMax = RANGES.fc.max;

  return (
    <div style={{ ...styles.card, borderLeft: `3px solid ${below ? AMBER : TEAL}` }}>
      <div style={styles.sectionTitle}>Free chlorine · next 72 h</div>
      <div style={styles.headline}>
        {f.now.p50.toFixed(1)}
        <span style={styles.headlineUnit}> ppm now</span>
        <span style={styles.headlineRange}>
          {f.now.p10.toFixed(1)}–{f.now.p90.toFixed(1)}
        </span>
      </div>
      <div style={{ ...styles.line, color: below ? AMBER : INK }}>
        {below
          ? `Below the ${floor.toFixed(1)} ppm floor now`
          : f.dueMs
          ? `Reaches ${floor.toFixed(1)} ppm ${fmtWhen(f.dueMs, nowMs)}${
              f.dueEarlyMs && f.dueEarlyMs < f.dueMs
                ? ` · as early as ${fmtWhen(f.dueEarlyMs, nowMs)}`
                : ""
            }`
          : "Stays above the floor for the next 3 days"}
      </div>
      {soon && add && add.amount >= 1 && (
        <div style={styles.action}>
          Add about {Math.round(add.amount)} {add.unit} of liquid chlorine to reach{" "}
          {add.targetFC.toFixed(1)} ppm
        </div>
      )}
      <BandChart points={f.points} nowMs={nowMs} floorY={floor} unit="ppm" digits={2} minY={0} />
      <div style={styles.footnote}>
        Band covers 80% of outcomes. Floor{" "}
        {isNum(cya) && cya > 0
          ? `= 7.5% of CYA ${Math.round(cya)} ppm (the minimum that still sanitizes)`
          : "= 1.0 ppm warranty minimum (no CYA reading yet)"}
        .
        {floor > warrantyMax &&
          ` That's above the ${warrantyMax} ppm warranty max — at CYA over 40 both can't hold at once; bringing CYA toward 30 lets them.`}
      </div>
    </div>
  );
}

// ---- Other chemistry -------------------------------------------------------------

function csiLabel(v) {
  if (!isNum(v)) return "Needs pH, TA and CH";
  if (v < -0.3) return "Etching risk — water dissolves the finish";
  if (v > 0.3) return "Scaling risk — calcium deposits";
  return "Balanced";
}

function Tile({ label, value, sub, sub2, warn }) {
  return (
    <div style={styles.tile}>
      <div style={styles.tileLabel}>{label}</div>
      <div style={{ ...styles.tileValue, color: warn ? AMBER : INK }}>{value}</div>
      {sub && <div style={styles.tileSub}>{sub}</div>}
      {sub2 && <div style={styles.tileSub}>{sub2}</div>}
    </div>
  );
}

function ChemistryCard({ result }) {
  const { nowMs, chem } = result;
  const ph = result.ph.forecast;
  const acid = result.ph.acidNow;
  const pHNow = ph ? ph.now.p50 : null;
  const fmtPpm = (v) => (isNum(v) ? `${Math.round(v)} ppm` : "—");
  const signed = (v) => (v > 0 ? `+${v.toFixed(2)}` : v.toFixed(2));

  return (
    <div style={styles.card}>
      <div style={styles.sectionTitle}>Water balance</div>
      <div style={styles.tileGrid}>
        <Tile
          label="pH"
          value={isNum(pHNow) ? pHNow.toFixed(2) : "—"}
          warn={isNum(pHNow) && (pHNow > PH_HIGH || pHNow < 7.2)}
          sub={
            ph
              ? ph.highAtMs
                ? `Reaches ${PH_HIGH} ${fmtWhen(ph.highAtMs, nowMs)}`
                : `Under ${PH_HIGH} for 3 days`
              : "Needs a pH and a TA reading"
          }
          sub2={
            acid && acid.amount >= 1
              ? `${Math.round(acid.amount)} ${acid.unit} ${
                  acid.chemical === "muriatic" ? "muriatic acid" : "soda ash"
                } → ${PH_TARGET}`
              : isNum(result.ph.equilibrium)
              ? `Drifting toward ${result.ph.equilibrium.toFixed(1)}`
              : null
          }
        />
        <Tile
          label="Saturation (CSI)"
          value={isNum(chem.csiNow) ? signed(chem.csiNow) : "—"}
          warn={isNum(chem.csiNow) && Math.abs(chem.csiNow) > 0.3}
          sub={csiLabel(chem.csiNow)}
          sub2={isNum(chem.csi72) ? `${signed(chem.csi72)} in 3 days` : null}
        />
        <Tile
          label="Total alkalinity"
          value={fmtPpm(chem.ta.value)}
          sub={fmtAge(chem.ta.tested, nowMs)}
          sub2="Adjusted for logged acid/base"
        />
        <Tile label="CYA" value={fmtPpm(chem.cya.value)} sub={fmtAge(chem.cya.tested, nowMs)} />
        <Tile label="Calcium hardness" value={fmtPpm(chem.ch.value)} sub={fmtAge(chem.ch.tested, nowMs)} />
        <Tile
          label="Water temp"
          value={isNum(chem.waterTemp.value) ? `${Math.round(chem.waterTemp.value)}°F` : "—"}
          sub={fmtAge(chem.waterTemp.tested, nowMs)}
        />
      </div>
      {ph && (
        <>
          <div style={{ ...styles.subTitle, marginTop: 16 }}>pH · next 72 h</div>
          <BandChart points={ph.points} nowMs={nowMs} floorY={PH_HIGH} unit="" digits={2} height={160} />
        </>
      )}
    </div>
  );
}

// ---- Calibration -----------------------------------------------------------------

const STATUS = {
  prior: { label: "Priors only", color: MUTED },
  learning: { label: "Learning", color: AMBER },
  calibrated: { label: "Calibrated", color: TEAL },
};

function StatusPill({ status }) {
  const s = STATUS[status] || STATUS.prior;
  return <span style={{ ...styles.pill, color: s.color, borderColor: s.color }}>{s.label}</span>;
}

const FLAG_LABELS = {
  fc_rose_without_logged_dose: "FC rose with no dose logged",
  missing_weather: "missing weather",
  fc_zero: "reading of 0",
};

function CalibrationCard({ result, inputs }) {
  const [exportMsg, setExportMsg] = useState(null);
  const fc = result.fc.fit.summary;
  const ph = result.ph.fit.summary;
  const cya = result.chem.cya.value;
  const typicalUvHours = useMemo(
    () => uvProfile(inputs.hourly, result.nowMs).reduce((a, b) => a + b, 0),
    [inputs.hourly, result.nowMs]
  );
  const sunnyLoss = 1 - Math.exp(-fc.kUv.median * cyaShield(cya) * typicalUvHours);

  const excluded = {};
  result.fc.intervals
    .filter((iv) => !iv.usable)
    .forEach((iv) =>
      iv.flags.forEach((f) => FLAG_LABELS[f] && (excluded[f] = (excluded[f] || 0) + 1))
    );
  const excludedText = Object.entries(excluded)
    .map(([f, n]) => `${n} ${FLAG_LABELS[f]}`)
    .join(", ");

  const predictions = result.fc.fit.predictions;
  const predData = predictions.map((p) => ({
    t: p.endMs,
    band: [p.lo, p.hi],
    p50: p.median,
    actual: p.actual,
  }));
  const oclts = result.fc.oclts.slice(-3).reverse();

  async function exportModel() {
    const byStart = new Map(predictions.map((p) => [p.startMs, p]));
    const rows = result.fc.intervals.map((iv) => ({ ...iv, prediction: byStart.get(iv.startMs) }));
    const { filename, csv } = buildExport("model", rows);
    try {
      const out = await shareOrDownloadCsv(filename, csv);
      setExportMsg(out === "cancelled" ? null : `${out === "shared" ? "Shared" : "Downloaded"} ${filename}`);
    } catch (err) {
      setExportMsg(`Export failed: ${err.message}`);
    }
  }

  const ci = (x, d) => `${x.lo.toFixed(d)}–${x.hi.toFixed(d)}`;

  return (
    <div style={styles.card}>
      <div style={styles.headerRow}>
        <div style={styles.sectionTitle}>Calibration</div>
        <StatusPill status={fc.status} />
      </div>

      <div style={styles.paramRow}>
        <div>
          <div style={styles.paramName}>Organic demand</div>
          <div style={styles.paramMeaning}>
            ≈ {(fc.kOrg.median * 11).toFixed(2)} ppm lost over an 11 h night at 80°F
          </div>
        </div>
        <div style={styles.paramValue}>
          {fc.kOrg.median.toFixed(3)} <span style={styles.paramUnit}>ppm/h</span>
          <div style={styles.paramCi}>90%: {ci(fc.kOrg, 3)}</div>
        </div>
      </div>
      <div style={styles.paramRow}>
        <div>
          <div style={styles.paramName}>Sun decay</div>
          <div style={styles.paramMeaning}>
            ≈ {Math.round(sunnyLoss * 100)}% of FC on a typical recent day
            {isNum(cya) ? ` at CYA ${Math.round(cya)}` : ""}
          </div>
        </div>
        <div style={styles.paramValue}>
          {fc.kUv.median.toFixed(4)} <span style={styles.paramUnit}>/UV·h</span>
          <div style={styles.paramCi}>90%: {ci(fc.kUv, 4)}</div>
        </div>
      </div>
      <div style={styles.paramRow}>
        <div>
          <div style={styles.paramName}>
            pH drift (CO₂ loss) <StatusPill status={ph.status} />
          </div>
          <div style={styles.paramMeaning}>How fast pH climbs after acid</div>
        </div>
        <div style={styles.paramValue}>
          {ph.kAer.median.toFixed(3)} <span style={styles.paramUnit}>/h</span>
          <div style={styles.paramCi}>90%: {ci(ph.kAer, 3)}</div>
        </div>
      </div>

      <div style={styles.accuracy}>
        {fc.n > 0 ? (
          <>
            Forecast accuracy: each reading predicted from earlier data only, off by{" "}
            <strong>±{fc.mae.toFixed(2)} ppm</strong> on average across {fc.n} interval
            {fc.n === 1 ? "" : "s"}; {Math.round(fc.coverage90 * 100)}% landed inside the 90% band
            {isNum(ph.mae) ? `. pH off by ±${ph.mae.toFixed(2)}.` : "."}
          </>
        ) : (
          "No calibration data yet — running on literature priors. Every pair of readings from now on refines the constants."
        )}
        {excludedText && <div style={{ marginTop: 6 }}>Not used: {excludedText}.</div>}
      </div>

      {predData.length >= 2 && (
        <div style={{ width: "100%", height: 170, marginTop: 10 }}>
          <ResponsiveContainer>
            <ComposedChart data={predData} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--piq-border)" />
              <XAxis
                dataKey="t"
                type="number"
                domain={["dataMin", "dataMax"]}
                tickFormatter={(t) => new Date(t).toLocaleDateString([], { month: "numeric", day: "numeric" })}
                tick={{ fontSize: 10, fill: MUTED }}
                stroke={MUTED}
              />
              <YAxis tick={{ fontSize: 10, fill: MUTED }} stroke={MUTED} />
              <Tooltip content={<BandTooltip unit="ppm" digits={2} />} />
              <Area dataKey="band" stroke="none" fill={TEAL} fillOpacity={0.12} isAnimationActive={false} />
              <Line dataKey="p50" stroke={MUTED} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
              <Scatter dataKey="actual" fill={TEAL} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      <div style={styles.subTitle}>Overnight loss tests</div>
      {oclts.length ? (
        oclts.map((iv) => (
          <div key={iv.startMs} style={styles.ocltRow}>
            <span>{new Date(iv.startMs).toLocaleDateString([], { month: "short", day: "numeric" })}</span>
            <span style={styles.mono}>{signedChange(-iv.oclt.loss)} ppm</span>
            <span style={{ ...styles.mono, color: iv.oclt.pass ? TEAL : AMBER }}>
              {iv.oclt.ideal ? "IDEAL" : iv.oclt.pass ? "PASS" : "FAIL"}
            </span>
          </div>
        ))
      ) : (
        <div style={styles.muted}>None yet.</div>
      )}
      <div style={styles.footnote}>
        Test after sunset and again before sunrise, with no chlorine added in between. Losing 1 ppm or less
        passes (0.5 or less is ideal); more means algae or organics are eating chlorine. It's also the
        single best calibration input — it isolates organic demand from sun.
      </div>

      <button type="button" onClick={exportModel} style={styles.exportButton}>
        Export model data (CSV)
      </button>
      {exportMsg && <div style={styles.footnote}>{exportMsg}</div>}
    </div>
  );
}

function ModelNotes({ inputs }) {
  return (
    <details style={styles.card}>
      <summary style={styles.summary}>How the model works</summary>
      <div style={styles.notes}>
        <p style={styles.eq}>dC/dt = −k_uv · S(CYA) · UV(t) · C − k_org · 2^((T − 80°F)/18°F)</p>
        <p>
          <strong>Sun</strong> (first-order): UV from your station every 5 minutes, integrated hour by hour
          between readings — not a single snapshot. S(CYA) = (1 + 40/2) / (1 + CYA/2) scales for stabilizer
          shielding (unstabilized chlorine burns off ~20× faster than at CYA 40).{" "}
          {inputs.config && inputs.config.screenEnclosure === false
            ? "No screen enclosure assumed."
            : "The screen enclosure (~60% UV transmission) is built into k_uv's starting value; data refines it."}
        </p>
        <p>
          <strong>Organic demand</strong> (zero-order): a steady ppm/h drain day and night, doubling for
          every 18°F of water temperature. This is what an overnight loss test measures.
        </p>
        <p>
          <strong>Doses</strong> add instantly (liquid chlorine strength ±15%). Each hour is solved
          exactly: C(t+Δt) = (C + b/a)·e^(−aΔt) − b/a.
        </p>
        <p>
          <strong>Calibration</strong>: Bayesian — both constants start from literature ranges and update
          with every pair of FC readings (last 60 days), weighting test-kit error (±0.25 ppm at each end),
          day-to-day noise, and dose uncertainty. Bad readings are down-weighted automatically. Accuracy is
          scored on predictions made before each reading was known.
        </p>
        <p style={styles.eq}>dDIC/dt = −k_aer · (CO₂ − CO₂,air)</p>
        <p>
          <strong>pH and TA</strong>: full carbonate equilibrium (temperature-dependent constants, CYA's
          alkalinity removed, ionic strength from TDS). Pool water holds excess CO₂; losing it raises pH
          without changing TA. Acid lowers TA and pH; the only fitted constant is k_aer. CSI (the exact form
          of the Langelier index) comes from the same chemistry.
        </p>
        <p>
          <strong>Not modeled yet</strong>: swimmer load (it shows up as extra organic demand), rain
          dilution, evaporation and top-offs, and CYA loss over time — CYA, CH and TA are carried from your
          last test plus logged doses, so retest them every week or two.
        </p>
      </div>
    </details>
  );
}

export default function Forecast() {
  const model = useModel({ fit: true });

  if (model.status === "loading") {
    return <div style={styles.loading}>Calibrating model…</div>;
  }
  if (model.status === "error") {
    return (
      <div style={styles.errorBanner}>
        Couldn't run the model: {model.error.message}
        <button type="button" onClick={model.refresh} style={styles.retry}>
          Retry
        </button>
      </div>
    );
  }
  return <ForecastView result={model.result} inputs={model.inputs} />;
}

export function ForecastView({ result, inputs }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <ChlorineCard result={result} />
      <ChemistryCard result={result} />
      <CalibrationCard result={result} inputs={inputs} />
      <ModelNotes inputs={inputs} />
    </div>
  );
}

const styles = {
  loading: { padding: 24, textAlign: "center", color: "var(--piq-text-muted)" },
  card: {
    background: "var(--piq-card-bg)",
    border: "1px solid var(--piq-border)",
    borderRadius: "var(--piq-radius)",
    padding: 18,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: 600,
    color: "var(--piq-text-muted)",
    marginBottom: 10,
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  subTitle: {
    fontSize: 11,
    fontWeight: 600,
    color: "var(--piq-text-muted)",
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginTop: 14,
    marginBottom: 6,
  },
  headerRow: { display: "flex", justifyContent: "space-between", alignItems: "baseline" },
  headline: {
    fontFamily: "var(--piq-font-mono)",
    fontVariantNumeric: "tabular-nums",
    fontSize: 32,
    fontWeight: 600,
    color: "var(--piq-primary)",
    display: "flex",
    alignItems: "baseline",
    gap: 6,
  },
  headlineUnit: { fontSize: 14, fontWeight: 500, color: "var(--piq-text-muted)" },
  headlineRange: {
    marginLeft: "auto",
    fontSize: 12,
    fontWeight: 500,
    color: "var(--piq-text-muted)",
  },
  line: { fontSize: 13, marginTop: 4 },
  action: {
    marginTop: 10,
    fontSize: 13,
    background: "var(--piq-yellow-bg)",
    color: "var(--piq-yellow)",
    borderRadius: "var(--piq-radius)",
    padding: "8px 12px",
  },
  footnote: { fontSize: 11, color: "var(--piq-text-muted)", lineHeight: 1.5, marginTop: 8 },
  muted: { fontSize: 13, color: "var(--piq-text-muted)" },
  tooltip: {
    background: PANEL,
    border: "1px solid var(--piq-border)",
    borderRadius: 4,
    padding: "6px 8px",
    fontSize: 11,
    fontFamily: "var(--piq-font-mono)",
    color: INK,
  },
  tileGrid: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 },
  tile: {
    background: "var(--piq-bg)",
    border: "1px solid var(--piq-border)",
    borderRadius: "var(--piq-radius)",
    padding: "10px 12px",
  },
  tileLabel: {
    fontSize: 10,
    fontWeight: 600,
    color: "var(--piq-text-muted)",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  tileValue: {
    fontFamily: "var(--piq-font-mono)",
    fontVariantNumeric: "tabular-nums",
    fontSize: 20,
    fontWeight: 600,
    marginTop: 2,
  },
  tileSub: { fontSize: 11, color: "var(--piq-text-muted)", marginTop: 2, lineHeight: 1.35 },
  pill: {
    display: "inline-block",
    padding: "1px 7px",
    border: "1px solid",
    borderRadius: 2,
    fontSize: 10,
    fontWeight: 600,
    fontFamily: "var(--piq-font-mono)",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginLeft: 6,
  },
  paramRow: {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    padding: "10px 0",
    borderBottom: "1px solid var(--piq-border)",
  },
  paramName: { fontSize: 13, fontWeight: 600 },
  paramMeaning: { fontSize: 11, color: "var(--piq-text-muted)", marginTop: 2 },
  paramValue: {
    textAlign: "right",
    fontFamily: "var(--piq-font-mono)",
    fontVariantNumeric: "tabular-nums",
    fontSize: 14,
    color: "var(--piq-primary)",
    whiteSpace: "nowrap",
  },
  paramUnit: { fontSize: 10, color: "var(--piq-text-muted)" },
  paramCi: { fontSize: 10, color: "var(--piq-text-muted)", marginTop: 2 },
  accuracy: { fontSize: 12, color: "var(--piq-text)", lineHeight: 1.5, marginTop: 12 },
  ocltRow: {
    display: "flex",
    justifyContent: "space-between",
    fontSize: 12,
    padding: "4px 0",
    borderBottom: "1px solid var(--piq-border)",
  },
  mono: { fontFamily: "var(--piq-font-mono)" },
  exportButton: {
    marginTop: 14,
    width: "100%",
    border: "1px solid var(--piq-primary)",
    background: "transparent",
    color: "var(--piq-primary)",
    borderRadius: "var(--piq-radius)",
    padding: "10px 0",
    fontSize: 12,
    fontWeight: 600,
    fontFamily: "var(--piq-font-mono)",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    cursor: "pointer",
  },
  summary: {
    fontSize: 12,
    fontWeight: 600,
    color: "var(--piq-text-muted)",
    textTransform: "uppercase",
    letterSpacing: 0.8,
    cursor: "pointer",
  },
  notes: { fontSize: 12, lineHeight: 1.6, color: "var(--piq-text)", marginTop: 8 },
  eq: {
    fontFamily: "var(--piq-font-mono)",
    fontSize: 12,
    color: "var(--piq-primary)",
    background: "var(--piq-bg)",
    padding: "8px 10px",
    borderRadius: "var(--piq-radius)",
    overflowX: "auto",
    whiteSpace: "nowrap",
  },
  errorBanner: {
    background: "var(--piq-red-bg)",
    color: "var(--piq-red)",
    borderRadius: "var(--piq-radius)",
    padding: "10px 14px",
    fontSize: 14,
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  },
  retry: {
    background: "none",
    border: "1px solid var(--piq-red)",
    color: "var(--piq-red)",
    borderRadius: "var(--piq-radius)",
    padding: "4px 10px",
    cursor: "pointer",
  },
};
