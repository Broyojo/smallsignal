import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CircuitProject } from "@icm/model";
import {
  ANALOG_CANVAS_MATH_PROFILE_ID,
  CANONICAL_FORMULA_FONT_SIZE,
  cachedFormulaResult,
  prepareFormula,
  type FormulaRequest,
  type FormulaTypesetResult,
} from "@icm/math-typesetting/cache";
import { FORMULA_MAX_LATEX_LENGTH } from "@icm/math-typesetting/profile";
import {
  createSmallSignalClient,
  DEFAULT_MODEL_PARAMETERS,
  DEFAULT_SUPPLY_VOLTAGE,
  isSmallSignalError,
  smallSignalNetlist,
  type ComplexPoint,
  type Root,
  type BjtOperatingPoint,
  type MosOperatingPoint,
  type SmallSignalClient,
  type DeviceOperatingPoint,
  type ModelKind,
  type ModelOverrides,
  type SmallSignalSource,
  type SmallSignalQuantity,
  type SmallSignalRequest,
  type SmallSignalResult,
  type SmallSignalResponse,
  type NoiseContribution,
  type SmallSignalNoise,
} from "@icm/small-signal";
import {
  browserStaleBuildRecovery,
  diagnoseModuleLoadFailure,
  recoverFromStaleBuild,
} from "../../components/stale-build-recovery";
import "./small-signal-panel.css";

const SOLVE_DEBOUNCE_MS = 120;
/** SPICE scale suffixes as decimal exponents (`meg` and `mil` aside). */
const SPICE_EXPONENT: Record<string, number> = {
  t: 12,
  g: 9,
  k: 3,
  m: -3,
  u: -6,
  // The micro sign (U+00B5) and the Greek mu (U+03BC) look the same.
  "\u00b5": -6,
  "\u03bc": -6,
  n: -9,
  p: -12,
  f: -15,
  a: -18,
};

const SPACE =
  "[\\t-\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]*";
const SPICE_NUMBER = new RegExp(
  `^${SPACE}([+-]?(?:\\d+\\.?\\d*|\\.\\d+))(?:[eE]([+-]?\\d+))?([A-Za-z\\u00b5\\u03bc\\u03a9]*)${SPACE}$`,
  "u",
);

/**
 * One SPICE number, read as the solver's `parse_value` reads it: `-0.45`,
 * `200u`, `1.2meg`, `10kohm`, `1a`, `5mil`. It refuses more (spaces, stray
 * characters, overflow) but never reads a different value.
 */
export function parseSpiceNumber(text: string): number | null {
  // Rust's trim() set (Unicode White_Space), and ASCII-only case folding as
  // in to_ascii_lowercase(): `/i` would also fold K (Kelvin) to k.
  const match = SPICE_NUMBER.exec(text);
  if (!match) return null;
  const [, mantissa = "", exponent = "0", unit = ""] = match;
  const letters = unit.replace(/[A-Z]/gu, (letter) => letter.toLowerCase());
  const scale = letters.startsWith("meg")
    ? 6
    : (SPICE_EXPONENT[letters[0] ?? ""] ?? 0);
  // The suffix moves the decimal exponent, so `2.5u` reads like `2.5e-6`.
  const value = letters.startsWith("mil")
    ? Number(`${mantissa}e${exponent}`) * 25.4e-6
    : Number(`${mantissa}e${Number(exponent) + scale}`);
  return Number.isFinite(value) ? value : null;
}

/** `1k, 10meg` → [1000, 1e7]; anything unreadable or negative is dropped. */
export function parseFrequencies(text: string): number[] {
  return text
    .split(/[\s,;]+/u)
    .map(parseSpiceNumber)
    .filter((value): value is number => value !== null && value >= 0);
}

/** A SPICE number as an engineer writes it: 0.5, 50, 200u, 1f. */
export function formatSpiceNumber(value: number): string {
  const magnitude = Math.abs(value);
  if (value === 0 || (magnitude >= 1e-3 && magnitude < 1e4))
    return String(Number(value.toPrecision(4)));
  const scales: [number, string][] = [
    [1e6, "meg"],
    [1e3, "k"],
    [1e-3, "m"],
    [1e-6, "u"],
    [1e-9, "n"],
    [1e-12, "p"],
    [1e-15, "f"],
  ];
  const [scale, suffix] = scales.find(([scale]) => magnitude >= scale) ?? [
    1e-15,
    "f",
  ];
  return `${Number((value / scale).toPrecision(4))}${suffix}`;
}

const MODEL_TITLE: Record<ModelKind, string> = {
  nmos: "NMOS",
  pmos: "PMOS",
  npn: "NPN",
  pnp: "PNP",
  diode: "Diode",
};

/**
 * The range each parameter accepts. Wider than any real device, narrow
 * enough that the solver's exponentials and N·V_T stay finite. VTO takes
 * either sign; VAF = 0 means no Early effect, LAMBDA = 0 no channel-length
 * modulation, GAMMA = 0 no body effect.
 */
const MODEL_RANGE: Record<
  string,
  { min: number; max: number; zero?: boolean }
> = {
  KP: { min: 1e-12, max: 10 },
  VTO: { min: -100, max: 100 },
  LAMBDA: { min: 0, max: 10 },
  GAMMA: { min: 0, max: 100 },
  PHI: { min: 1e-3, max: 100 },
  IS: { min: 1e-30, max: 1 },
  BF: { min: 1e-3, max: 1e6 },
  VAF: { min: 0.01, max: 1e6, zero: true },
  N: { min: 0.01, max: 100 },
  // Flicker noise: KF·I^AF/f (ngspice's level-1 MOS form uses gm²).
  KF: { min: 0, max: 1 },
  AF: { min: 0, max: 10 },
};

export function modelValue(name: string, text: string): number | null {
  const value = parseSpiceNumber(text);
  const range = MODEL_RANGE[name];
  if (value === null || !range) return null;
  if (value === 0 && range.zero) return 0;
  return value >= range.min && value <= range.max ? value : null;
}

/** The accepted range, as a tooltip for a value outside it. */
function rangeText(name: string): string | undefined {
  const range = MODEL_RANGE[name];
  return range
    ? `${range.zero ? "0, or " : ""}${formatSpiceNumber(range.min)} to ${formatSpiceNumber(range.max)}`
    : undefined;
}

/** Typed model parameters, by kind then name, kept as the user wrote them. */
type ModelText = Partial<Record<ModelKind, Record<string, string>>>;
const MODEL_STORAGE_KEY = "smallsignal.models";

/** Stored model text, keeping only known kinds and string parameters. */
export function readModelText(stored: string | null): ModelText {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored ?? "{}");
  } catch {
    return {};
  }
  const text: ModelText = {};
  if (!parsed || typeof parsed !== "object") return text;
  for (const kind of Object.keys(DEFAULT_MODEL_PARAMETERS) as ModelKind[]) {
    const params: unknown = (parsed as Record<string, unknown>)[kind];
    if (!params || typeof params !== "object") continue;
    for (const name of Object.keys(DEFAULT_MODEL_PARAMETERS[kind])) {
      const typed = (params as Record<string, unknown>)[name];
      if (typeof typed === "string" && typed.trim())
        (text[kind] ??= {})[name] = typed;
    }
  }
  return text;
}

/** Whether any model parameter is typed in, valid or not. */
export function modelTextEdited(text: ModelText): boolean {
  return Object.values(text).some((params) =>
    Object.values(params ?? {}).some((typed) => typed.trim()),
  );
}

function loadModelText(): ModelText {
  try {
    return readModelText(window.localStorage.getItem(MODEL_STORAGE_KEY));
  } catch {
    return {};
  }
}

function saveModelText(text: ModelText) {
  try {
    window.localStorage.setItem(MODEL_STORAGE_KEY, JSON.stringify(text));
  } catch {
    // Private windows: the values still apply until the page closes.
  }
}

export function modelOverrides(text: ModelText): ModelOverrides {
  // Keys are checked against DEFAULT_MODEL_PARAMETERS below.
  const overrides: Partial<Record<ModelKind, Record<string, number>>> = {};
  for (const kind of Object.keys(DEFAULT_MODEL_PARAMETERS) as ModelKind[]) {
    for (const [name, typed] of Object.entries(text[kind] ?? {})) {
      if (!(name in DEFAULT_MODEL_PARAMETERS[kind])) continue;
      const value = modelValue(name, typed);
      if (value !== null) (overrides[kind] ??= {})[name] = value;
    }
  }
  return overrides as ModelOverrides;
}

function ModelFields({
  kinds,
  text,
  onChange,
}: {
  kinds: readonly ModelKind[];
  text: ModelText;
  onChange: (text: ModelText) => void;
}) {
  // Every edited kind shows, used here or not: nothing applies unseen.
  const shown = (Object.keys(MODEL_TITLE) as ModelKind[]).filter(
    (kind) =>
      kinds.includes(kind) ||
      Object.values(text[kind] ?? {}).some((typed) => typed.trim()),
  );
  return (
    <>
      {shown.map((kind) => (
        <fieldset key={kind} className="small-signal-model">
          <legend>{MODEL_TITLE[kind]}</legend>
          {Object.entries(DEFAULT_MODEL_PARAMETERS[kind]).map(
            ([name, fallback]) => {
              const typed = text[kind]?.[name] ?? "";
              const invalid =
                typed.trim() !== "" && modelValue(name, typed) === null;
              return (
                <label key={name}>
                  {name}
                  <input
                    aria-label={`${MODEL_TITLE[kind]} ${name}`}
                    aria-invalid={invalid || undefined}
                    title={invalid ? rangeText(name) : undefined}
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder={formatSpiceNumber(fallback)}
                    value={typed}
                    onChange={(event) =>
                      onChange({
                        ...text,
                        [kind]: {
                          ...text[kind],
                          [name]: event.currentTarget.value,
                        },
                      })
                    }
                  />
                </label>
              );
            },
          )}
        </fieldset>
      ))}
      {modelTextEdited(text) ? (
        <button
          type="button"
          className="small-signal-reset"
          onClick={() => onChange({})}
        >
          Reset to defaults
        </button>
      ) : null}
    </>
  );
}

export function formatEngineering(value: number, unit = ""): string {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return `0${unit ? ` ${unit}` : ""}`;
  const prefixes = ["f", "p", "n", "µ", "m", "", "k", "M", "G", "T"];
  const exponent = Math.min(
    12,
    Math.max(-15, Math.floor(Math.log10(Math.abs(value)) / 3) * 3),
  );
  const scaled = value / 10 ** exponent;
  const prefix = prefixes[exponent / 3 + 5] ?? "";
  return `${Number(scaled.toPrecision(4))}${unit || prefix ? " " : ""}${prefix}${unit}`;
}

/**
 * Set when the typesetter chunk 404s: this page is from a build a newer
 * deploy replaced, so the panel offers the editor's stale-build recovery.
 */
const StaleBuildContext = createContext<() => void>(() => {});

/**
 * An expression too long (or impossible) to typeset: said plainly, with its
 * TeX one click from the clipboard, never shown as raw source.
 */
function UntypesetFormula({
  latex,
  reason,
}: {
  latex: string;
  reason: "too-long" | "unavailable";
}) {
  const [copied, setCopied] = useState(false);
  return (
    <p className="small-signal-untypeset">
      <span>
        {reason === "too-long"
          ? "Too long to display as an equation."
          : "The equation could not be displayed."}
      </span>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(latex).then(
            () => setCopied(true),
            () => setCopied(false),
          );
        }}
      >
        {copied ? "Copied" : "Copy TeX"}
      </button>
    </p>
  );
}

function Formula({ latex }: { latex: string }) {
  const onStale = useContext(StaleBuildContext);
  const request: FormulaRequest = {
    latex,
    display: "block",
    profileId: ANALOG_CANVAS_MATH_PROFILE_ID,
    bold: false,
  };
  const [prepared, setPrepared] = useState<{
    latex: string;
    result: FormulaTypesetResult;
  }>();
  const tooLong = latex.length > FORMULA_MAX_LATEX_LENGTH;
  const [failed, setFailed] = useState<string | null>(null);
  const result =
    prepared?.latex === latex ? prepared.result : cachedFormulaResult(request);
  useEffect(() => {
    if (tooLong) return;
    let active = true;
    void prepareFormula({
      latex,
      display: "block",
      profileId: ANALOG_CANVAS_MATH_PROFILE_ID,
      bold: false,
    }).then(
      (next) => {
        if (active) setPrepared({ latex, result: next });
      },
      (error: unknown) => {
        if (active) setFailed(latex);
        // The LaTeX source stays readable; a retired chunk also offers a reload.
        void diagnoseModuleLoadFailure(error, {
          currentUrl: window.location.href,
          fetch: (input, init) => fetch(input, init),
        }).then((diagnosis) => {
          if (active && diagnosis.kind === "stale-build") onStale();
        });
      },
    );
    return () => {
      active = false;
    };
  }, [latex, tooLong, onStale]);
  // While the typesetter loads, hold the space quietly; raw TeX reads as
  // broken. Only a formula that cannot be typeset shows its source.
  if (!tooLong && !result && failed !== latex)
    return <span className="small-signal-formula-pending" aria-busy="true" />;
  if (tooLong || !result?.ok)
    return (
      <UntypesetFormula
        latex={latex}
        reason={tooLong ? "too-long" : "unavailable"}
      />
    );
  const artifact = result.artifact;
  // Long expressions keep their size and scroll sideways rather than
  // shrinking past legibility.
  return (
    <div className="small-signal-formula-scroll">
      <img
        className="small-signal-formula"
        alt={latex}
        src={`data:image/svg+xml,${encodeURIComponent(artifact.svg)}`}
        style={{
          width: `${artifact.width / CANONICAL_FORMULA_FONT_SIZE}em`,
          height: `${artifact.height / CANONICAL_FORMULA_FONT_SIZE}em`,
        }}
      />
    </div>
  );
}

/** A unitless value (a voltage gain) as a plain number: -3.85, 1.2e-5. */
export function formatPlain(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const magnitude = Math.abs(value);
  return magnitude !== 0 && (magnitude < 1e-3 || magnitude >= 1e6)
    ? value.toExponential(3)
    : String(Number(value.toPrecision(4)));
}

function formatValue(value: number, unit: string): string {
  return unit ? formatEngineering(value, unit) : formatPlain(value);
}

export { pointText as pointTextForTest };

function pointText(point: ComplexPoint, unit: string): string {
  if (point.inf || point.re === null || point.im === null) return "∞";
  // Rounding residue in a real quantity is not a phase.
  if (Math.abs(point.im) <= 1e-12 * Math.abs(point.re))
    return formatValue(point.re, unit);
  const magnitude = Math.hypot(point.re, point.im);
  const phase = (Math.atan2(point.im, point.re) * 180) / Math.PI;
  return `${formatValue(magnitude, unit)} ∠ ${phase.toFixed(1)}°`;
}

/** Poles/zeros in Hz, e.g. "−16.3 MHz" or "−1 ± j2 kHz". */
function rootText(root: Root): string {
  if (root.im === 0) return formatEngineering(root.re, "Hz");
  if (root.im < 0) return "";
  return `${formatEngineering(root.re)} ± j${formatEngineering(root.im, "Hz")}`;
}

/** Below this the leakage-free form is indistinguishable at 4 digits. */
const INVISIBLE_ERROR = 1e-6;

/**
 * The main equation: the exact form without gmin-level junction leakage when
 * that leakage is negligible (said so when it is not invisible), else the
 * full exact form.
 */
function MainFormula({
  symbol,
  quantity,
}: {
  symbol: string;
  quantity: SmallSignalQuantity;
}) {
  const display = quantity.display;
  if (!display || display.same || display.latex === null) {
    return <ExactFormula symbol={symbol} quantity={quantity} />;
  }
  const error = display.maxRelError ?? 0;
  const invisible = error < INVISIBLE_ERROR;
  return (
    <>
      <Formula
        latex={`${symbol} ${invisible ? "=" : "\\approx"} ${display.latex}`}
      />
      {invisible ? null : (
        <small className="small-signal-muted">
          neglecting junction leakage ({formatPercent(error)})
        </small>
      )}
      <details className="small-signal-exact">
        <summary>Exact</summary>
        <ExactFormula symbol={symbol} quantity={quantity} />
      </details>
    </>
  );
}

function ExactFormula({
  symbol,
  quantity,
}: {
  symbol: string;
  quantity: SmallSignalQuantity;
}) {
  if (quantity.exact.latex === null) {
    return (
      <p className="small-signal-muted">
        The exact expression is too large to typeset.
      </p>
    );
  }
  return <Formula latex={`${symbol} = ${quantity.exact.latex}`} />;
}

function formatPercent(fraction: number): string {
  const percent = fraction * 100;
  return percent < 0.1 ? "<0.1%" : `${percent.toPrecision(2)}%`;
}

/** One result: its equation, its value, and its poles. */
function QuantityCard({
  title,
  symbol,
  quantity,
  unit,
}: {
  title: string;
  symbol: string;
  quantity: SmallSignalQuantity;
  unit: string;
}) {
  // The simpler form appears only when it actually dropped terms.
  const simpler =
    quantity.simplified && !quantity.simplified.same
      ? quantity.simplified
      : null;
  const value = quantity.values?.[0];
  const terms = quantity.exact.terms;
  const exactIsLong =
    quantity.exact.latex === null ||
    (terms ? terms.num + terms.den > 6 : quantity.exact.latex.length > 160);
  const simplerNote = simpler?.assumption
    ? `assuming ${simpler.assumption}`
    : `within ${formatPercent(simpler?.maxRelError ?? 0)} of exact`;
  const poleCount = quantity.poles?.length ?? 0;
  const poles = (quantity.poles ?? []).map(rootText).filter(Boolean);
  return (
    <section className="small-signal-card" aria-label={title}>
      <header>
        <span>{title}</span>
        {value ? (
          <strong>
            {pointText(value, unit)}
            {quantity.values?.length === 1 &&
            value.f > 0 &&
            (quantity.poles?.length || quantity.zeros?.length) ? (
              <small> at {formatEngineering(value.f, "Hz")}</small>
            ) : null}
          </strong>
        ) : null}
      </header>
      {simpler && exactIsLong ? (
        <>
          {/* A long exact form would bury the result: lead with the
              readable one and keep the exact form a click away. */}
          <Formula latex={`${symbol} \\approx ${simpler.latex}`} />
          <small className="small-signal-muted">{simplerNote}</small>
          <details className="small-signal-exact">
            <summary>Exact</summary>
            <ExactFormula symbol={symbol} quantity={quantity} />
          </details>
        </>
      ) : (
        <>
          <MainFormula symbol={symbol} quantity={quantity} />
          {simpler ? (
            <div className="small-signal-simpler">
              <Formula latex={`\\approx ${simpler.latex}`} />
              <small>{simplerNote}</small>
            </div>
          ) : null}
        </>
      )}
      {quantity.values && quantity.values.length > 1 ? (
        <table className="small-signal-values">
          <tbody>
            {quantity.values.map((point) => (
              <tr key={point.f}>
                <th scope="row">{formatEngineering(point.f, "Hz")}</th>
                <td>{pointText(point, unit)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {poles.length ? (
        <small className="small-signal-muted">
          {poleCount === 1 ? "Pole" : "Poles"} {poles.join(", ")}
        </small>
      ) : null}
    </section>
  );
}

const NOISE_KIND: Record<string, string> = {
  thermal: "thermal",
  flicker: "flicker",
  shot: "shot",
  shot_c: "shot (c)",
  shot_b: "shot (b)",
};

/** √PSD as a spectral density, e.g. 3.88 nV/√Hz; "—" where not finite. */
export function formatDensity(v2: number | null, unit: string): string {
  if (v2 === null || !Number.isFinite(v2)) return "—";
  const base = unit.startsWith("A") ? "A" : "V";
  return `${formatEngineering(Math.sqrt(v2), base)}/√Hz`;
}

/** The solver integrates bands of up to 40 decades. */
const MAX_BAND_DECADES = 40;

/** "1, 10meg" → [1, 1e7]; null unless 0 < fLow < fHigh within 40 decades. */
export function noiseBandRange(text: string): [number, number] | null {
  // Exactly two readable frequencies: never quietly drop a bad token.
  const tokens = text.split(/[\s,;]+/u).filter(Boolean);
  if (tokens.length !== 2) return null;
  const [low, high] = tokens.map(parseSpiceNumber);
  if (low == null || high == null) return null;
  return low > 0 && high > low && Math.log10(high / low) <= MAX_BAND_DECADES
    ? [low, high]
    : null;
}

/** A solver note as a sentence: capitalized, with a full stop. */
function sentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  const capital = trimmed[0]!.toUpperCase() + trimmed.slice(1);
  return /[.!?]$/u.test(capital) ? capital : `${capital}.`;
}

/**
 * The largest sources, then one row for the rest (including any the solver
 * already summed). Sources without a finite share are left out.
 */
export function topContributions(
  sources: readonly NoiseContribution[],
  omittedFraction = 0,
  limit = 4,
): { label: string; fraction: number }[] {
  const sorted = sources
    .filter((source): source is NoiseContribution & { fraction: number } =>
      Number.isFinite(source.fraction),
    )
    .sort((a, b) => b.fraction - a.fraction);
  const rows = sorted.slice(0, limit).map((source) => ({
    label: `${source.element} ${NOISE_KIND[source.kind] ?? source.kind}`,
    fraction: source.fraction,
  }));
  const rest =
    sorted.slice(limit).reduce((sum, s) => sum + s.fraction, 0) +
    omittedFraction;
  return rest > 0 ? [...rows, { label: "others", fraction: rest }] : rows;
}

/** Warnings from a section's own solve that the main results don't show. */
function ExtraWarnings({
  warnings,
  shown,
}: {
  warnings: readonly string[] | undefined;
  shown: readonly string[] | undefined;
}) {
  const extra = (warnings ?? []).filter((text) => !shown?.includes(text));
  if (!extra.length) return null;
  return (
    <div className="small-signal-alert is-warning" role="alert">
      {extra.map((text) => (
        <p key={text}>{sentence(text)}</p>
      ))}
    </div>
  );
}

/**
 * Noise: the input-referred white PSD as an equation, input and output
 * densities per frequency, the largest sources, and the band rms.
 */
function NoiseDetails({
  noise,
  current,
  band,
  onBand,
}: {
  noise: SmallSignalNoise;
  current: boolean;
  band: string;
  onBand: (text: string) => void;
}) {
  const low = "unavailable" in noise.inputLowFreq ? null : noise.inputLowFreq;
  const symbol = `\\frac{\\overline{${current ? "i" : "v"}_{n,in}^{2}}}{\\Delta f}`;
  const display = low?.display.latex ? low.display : null;
  const simpler =
    low?.simplified.latex && low.simplified.latex !== display?.latex
      ? low.simplified
      : null;
  // The exact form, when it differs from the display one (junction leakage
  // dropped); null when it is too large to typeset.
  const exactLatex = low?.exact.latex ?? null;
  const displayIsExact = Boolean(
    display && (display.same || exactLatex === display.latex),
  );
  const exactContent =
    exactLatex && exactLatex !== display?.latex
      ? exactLatex
      : displayIsExact
        ? display!.latex
        : null;
  const displayError = display?.relError ?? 0;
  const displayEquals = displayIsExact || displayError < INVISIBLE_ERROR;
  // As on the result cards: a long form would bury the readable one.
  const long =
    !display?.latex ||
    (display.terms ?? 0) > 6 ||
    display.latex.length > FORMULA_MAX_LATEX_LENGTH;
  const leadSimpler = simpler && long;
  const simplerNote = simpler?.assumption
    ? `assuming ${simpler.assumption}`
    : `within ${formatPercent(simpler?.relError ?? 0)} of exact`;
  // From every source: the contributor lists stop at the 32 largest.
  const flicker = noise.sources.some((source) => source.kind === "flicker");
  const sources = noise.contributors[0];
  const integrated = noise.integrated;
  const exactDisclosure = (
    <details className="small-signal-exact">
      <summary>Exact</summary>
      {exactContent ? (
        <Formula latex={`${symbol} = ${exactContent}`} />
      ) : (
        <p className="small-signal-muted">
          The exact expression is too large to typeset.
        </p>
      )}
    </details>
  );
  return (
    <>
      {leadSimpler ? (
        <>
          <Formula latex={`${symbol} \\approx ${simpler.latex}`} />
          <small className="small-signal-muted">{simplerNote}</small>
          {exactDisclosure}
        </>
      ) : display ? (
        <>
          <Formula
            latex={`${symbol} ${displayEquals ? "=" : "\\approx"} ${display.latex}`}
          />
          {displayEquals ? null : (
            <small className="small-signal-muted">
              neglecting junction leakage ({formatPercent(displayError)})
            </small>
          )}
          {simpler ? (
            <div className="small-signal-simpler">
              <Formula latex={`\\approx ${simpler.latex}`} />
              <small>{simplerNote}</small>
            </div>
          ) : null}
          {displayIsExact ? null : exactDisclosure}
        </>
      ) : null}
      {(leadSimpler || display) && flicker ? (
        <small className="small-signal-muted">
          Thermal and shot noise. Flicker is in the numbers below.
        </small>
      ) : null}
      {"unavailable" in noise.inputLowFreq ? (
        <p className="small-signal-muted">
          {sentence(noise.inputLowFreq.unavailable)}
        </p>
      ) : null}
      {noise.input.length ? (
        <table className="small-signal-values" aria-label="Noise density">
          <thead>
            <tr>
              <th />
              <th scope="col">Input</th>
              <th scope="col">Output</th>
            </tr>
          </thead>
          <tbody>
            {noise.input.map((point, index) => (
              <tr key={point.f} data-frequency={point.f}>
                <th scope="row">{formatEngineering(point.f, "Hz")}</th>
                <td data-quantity="input">
                  {formatDensity(point.v2, noise.inputUnit)}
                </td>
                <td data-quantity="output">
                  {noise.output[index]
                    ? formatDensity(noise.output[index].v2, noise.outputUnit)
                    : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {sources?.sources.length ? (
        <table className="small-signal-values" aria-label="Noise sources">
          <caption>Sources at {formatEngineering(sources.f, "Hz")}</caption>
          <tbody>
            {topContributions(
              sources.sources,
              sources.omitted?.fraction ?? 0,
            ).map((row) => (
              <tr key={row.label}>
                <th scope="row">{row.label}</th>
                <td>{formatPercent(row.fraction)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {noise.input.length ? (
        <label>
          Band
          <input
            aria-label="Noise band"
            aria-invalid={
              band.trim() !== "" && noiseBandRange(band) === null
                ? true
                : undefined
            }
            placeholder="1, 10meg"
            value={band}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) => onBand(event.currentTarget.value)}
          />
        </label>
      ) : null}
      {integrated ? (
        <>
          <table className="small-signal-values" aria-label="Integrated noise">
            <tbody>
              {integrated.inputRms !== null ? (
                <tr>
                  <th scope="row">Input</th>
                  <td data-quantity="input-rms">
                    {formatEngineering(
                      integrated.inputRms,
                      current ? "A" : "V",
                    )}{" "}
                    rms
                  </td>
                </tr>
              ) : null}
              {integrated.outputRms !== null ? (
                <tr>
                  <th scope="row">Output</th>
                  <td data-quantity="output-rms">
                    {formatEngineering(integrated.outputRms, "V")} rms
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
          {integrated.unavailable ? (
            <small className="small-signal-muted">
              {sentence(integrated.unavailable)}
            </small>
          ) : null}
        </>
      ) : null}
    </>
  );
}

/**
 * The bias point as a table: per transistor its region and the three numbers
 * the equations use (current, g_m, r_o; r_π too when there are BJTs).
 */
function BiasTable({
  devices,
}: {
  devices: Array<[string, DeviceOperatingPoint]>;
}) {
  interface Row {
    name: string;
    region: string;
    current: number;
    gm: number;
    ro: number;
    rpi: number | null;
  }
  const rows = devices.flatMap(([name, device]): Row[] => {
    if (device.type === "nmos" || device.type === "pmos") {
      const m = device as MosOperatingPoint;
      return [
        {
          name,
          region: m.region,
          current: Math.abs(m.id),
          gm: m.gm,
          ro: m.gds > 0 ? 1 / m.gds : Infinity,
          rpi: null,
        },
      ];
    }
    if (device.type === "npn" || device.type === "pnp") {
      const q = device as BjtOperatingPoint;
      return [
        {
          name,
          region: q.region === "forward-active" ? "active" : q.region,
          current: Math.abs(q.ic),
          gm: q.gm,
          ro: q.go > 0 ? 1 / q.go : Infinity,
          rpi: 1 / q.gpi,
        },
      ];
    }
    return [];
  });
  const hasBjt = rows.some((row) => row.rpi !== null);
  // The status line already says when every transistor is saturated
  // (BJTs active); the column only appears when one is not.
  const showRegion = rows.some(
    (row) => row.region !== "saturation" && row.region !== "active",
  );
  const ohms = (value: number) =>
    Number.isFinite(value) ? formatEngineering(value, "Ω") : "∞";
  return (
    <table className="small-signal-bias-table">
      <thead>
        <tr>
          <th scope="col" />
          {showRegion ? <th scope="col" /> : null}
          <th scope="col">I</th>
          <th scope="col">
            g<sub>m</sub>
          </th>
          <th scope="col">
            r<sub>o</sub>
          </th>
          {hasBjt ? (
            <th scope="col">
              r<sub>π</sub>
            </th>
          ) : null}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.name} data-device={row.name}>
            <th scope="row">{row.name}</th>
            {showRegion ? (
              <td>
                <span className={`small-signal-region is-${row.region}`}>
                  {row.region}
                </span>
              </td>
            ) : null}
            <td data-quantity="id">{formatEngineering(row.current, "A")}</td>
            <td data-quantity="gm">{formatEngineering(row.gm, "S")}</td>
            <td data-quantity="ro">{ohms(row.ro)}</td>
            {hasBjt ? <td>{row.rpi === null ? "" : ohms(row.rpi)}</td> : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Pairs the solver treats as identical, so the equations write one symbol
 * for both (g_m1,2): "Matched M1 = M2", each chip a toggle. Hidden when
 * there is nothing to match.
 */
function MatchedPairs({
  result,
  onToggle,
}: {
  result: SmallSignalResult;
  onToggle(key: string, on: boolean): void;
}) {
  const candidates = [...(result.matchCandidates ?? [])]
    .filter((candidate) => candidate.kind === "device")
    .sort((a, b) =>
      (a.elements[0] ?? "").localeCompare(b.elements[0] ?? "", undefined, {
        numeric: true,
      }),
    );
  if (!candidates.length) return null;
  return (
    <div className="small-signal-match" aria-label="Matched pairs">
      <span>Matched</span>
      {candidates.map((candidate) => {
        const key = candidate.elements.join("=");
        const on = candidate.applied ?? false;
        return (
          <button
            key={key}
            type="button"
            aria-pressed={on}
            title={
              on
                ? "Treated as identical. Click to treat separately."
                : "Click to treat as identical."
            }
            onClick={() => onToggle(key, on)}
          >
            {candidate.elements.join(" = ")}
          </button>
        );
      })}
    </div>
  );
}

/** `v_{out}` for a net named Vout or out, `i_{1}` for a source named I1. */
export function signalLabel(letter: "v" | "i", name: string): string {
  const body = new RegExp(`^${letter}(?=.)`, "iu").test(name)
    ? name.slice(1)
    : name;
  return `${letter}_{${body.replace(/_/gu, "\\_")}}`;
}

/**
 * A net named like an output, else the first that is neither driven by a
 * source nor a supply rail (a rail is AC ground, never a useful output).
 */
export function preferredOutput(
  nets: string[],
  sourceNodes: Set<string>,
  supplies: string[] = [],
) {
  const candidates = nets.filter(
    (net) => net !== "0" && !supplies.includes(net),
  );
  return (
    candidates.find((net) => /out/iu.test(net)) ??
    candidates.find((net) => !sourceNodes.has(net)) ??
    candidates[0] ??
    "0"
  );
}

function sourceLabel(source: SmallSignalSource): string {
  return source.pin ?? source.name;
}

/**
 * Inputs drawn as a pair (Vin1/Vin2, Vin+/Vin−, Vinp/Vinn, INP/INN): offered
 * first, as a differential drive.
 */
export function differentialPairs(
  sources: SmallSignalSource[],
): Array<[SmallSignalSource, SmallSignalSource]> {
  const voltage = sources.filter((source) => source.kind === "voltage");
  const pairs: Array<[SmallSignalSource, SmallSignalSource]> = [];
  const split = (label: string) => {
    const match = /^(.*?)(\+|-|−|p|n|P|N|1|2)$/u.exec(label);
    if (!match) return null;
    const sign = match[2] ?? "";
    const positive = ["+", "p", "P", "1"].includes(sign);
    return { stem: match[1] ?? "", positive };
  };
  for (const plus of voltage) {
    const a = split(sourceLabel(plus));
    if (!a?.positive || !a.stem) continue;
    const minus = voltage.find((other) => {
      const b = split(sourceLabel(other));
      return other !== plus && b && !b.positive && b.stem === a.stem;
    });
    if (minus) pairs.push([plus, minus]);
  }
  return pairs;
}

const DIFF_PREFIX = "diff:";

/** Symbolic small-signal analysis of the open Cell, solved in a worker. */
export function SmallSignalPanel({
  project,
  rootDocumentId,
}: {
  project: CircuitProject;
  rootDocumentId?: string;
}) {
  const [supply, setSupply] = useState(String(DEFAULT_SUPPLY_VOLTAGE));
  const supplyVoltage = parseFrequencies(supply)[0] ?? DEFAULT_SUPPLY_VOLTAGE;
  // DC values typed for undriven Pins (inputs and bias nodes).
  const [pinBiasText, setPinBiasText] = useState<Record<string, string>>({});
  const pinBias = useMemo(() => {
    const values: Record<string, number> = {};
    for (const [pin, text] of Object.entries(pinBiasText)) {
      const value = parseSpiceNumber(text);
      if (value !== null) values[pin] = value;
    }
    return values;
  }, [pinBiasText]);
  // Model parameters typed in the Models section, kept across sessions.
  const [modelText, setModelText] = useState<ModelText>(loadModelText);
  const updateModelText = useCallback((text: ModelText) => {
    setModelText(text);
    saveModelText(text);
  }, []);
  const models = useMemo(() => modelOverrides(modelText), [modelText]);
  const netlist = useMemo(
    () =>
      smallSignalNetlist(project, {
        ...(rootDocumentId ? { rootDocumentId } : {}),
        supplyVoltage,
        pinBias,
        models,
      }),
    [project, rootDocumentId, supplyVoltage, pinBias, models],
  );
  const [input, setInput] = useState<string | null>(null);
  const [output, setOutput] = useState<string | null>(null);
  const [reference, setReference] = useState("0");
  const [frequencies, setFrequencies] = useState("1k");
  // Hand-analysis mode: no bias, every transistor taken as saturated.
  const [assumeSaturation, setAssumeSaturation] = useState(false);
  // Matched pairs the user turned off (keys like "M1=M2"); the solver
  // matches every other candidate pair in the same solve.
  const [unmatched, setUnmatched] = useState<ReadonlySet<string>>(new Set());
  const [response, setResponse] = useState<SmallSignalResponse | null>(null);
  const [staleBuild, setStaleBuild] = useState(false);
  const markStale = useCallback(() => setStaleBuild(true), []);
  const [solving, setSolving] = useState(false);
  const clientRef = useRef<SmallSignalClient | null>(null);
  const generation = useRef(0);
  // Noise runs on its own worker, only while its section is open, so the
  // main results never wait for it.
  const [noiseOpen, setNoiseOpen] = useState(false);
  const [noiseBand, setNoiseBand] = useState("");
  const [noiseResponse, setNoiseResponse] =
    useState<SmallSignalResponse | null>(null);
  const noiseClientRef = useRef<SmallSignalClient | null>(null);
  // A noise solve was sent and its job is still the current one.
  const noiseBusy = useRef(false);
  const noiseGeneration = useRef(0);

  useEffect(() => {
    // Start loading the typesetter now, before the first result arrives.
    void prepareFormula({
      latex: "g_m",
      display: "block",
      profileId: ANALOG_CANVAS_MATH_PROFILE_ID,
      bold: false,
    }).catch(() => {});
    const client = createSmallSignalClient();
    clientRef.current = client;
    return () => {
      client.dispose();
      clientRef.current = null;
      noiseClientRef.current?.dispose();
      noiseClientRef.current = null;
    };
  }, []);

  // `nc…` nets stand in for unconnected pins: never something to pick.
  const nets = (netlist?.nets ?? []).filter((net) => !/^nc\d+$/u.test(net));
  const sources = netlist?.sources ?? [];
  const sourceNodes = new Set(sources.flatMap((source) => source.nodes));
  const pairs = differentialPairs(sources);
  const pairValue = ([plus, minus]: [SmallSignalSource, SmallSignalSource]) =>
    `${DIFF_PREFIX}${plus.name}|${minus.name}`;
  const validInput =
    input &&
    (sources.some((source) => source.name === input) ||
      pairs.some((pair) => pairValue(pair) === input));
  // A drawn input pair is the natural default for a differential stage.
  const chosenInput = validInput
    ? input
    : pairs[0]
      ? pairValue(pairs[0])
      : (sources.find((source) => /in/iu.test(sourceLabel(source)))?.name ??
        sources[0]?.name ??
        null);
  const differential = chosenInput?.startsWith(DIFF_PREFIX)
    ? (chosenInput.slice(DIFF_PREFIX.length).split("|") as [string, string])
    : null;
  const unmatch = [...unmatched].map((key) => key.split("="));
  const chosenOutput =
    output && nets.includes(output)
      ? output
      : preferredOutput(nets, sourceNodes, netlist?.supplies ?? []);
  const chosenReference = nets.includes(reference) ? reference : "0";
  // Ground and supply rails are AC ground: if nothing else exists, there is
  // nothing to measure (e.g. the output is drawn on ground).
  const noOutput = Boolean(netlist) && chosenOutput === "0";

  // An open pin makes every number meaningless: refuse rather than guess.
  const unconnected = netlist?.unconnected ?? [];
  const noDcPath = netlist?.noDcPath ?? [];
  const unknownBias = netlist?.unknownBias ?? [];
  // Without every bias value there is no operating point: hand analysis.
  const handAnalysis = assumeSaturation || unknownBias.length > 0;
  const request: SmallSignalRequest | null =
    netlist &&
    chosenInput &&
    !unconnected.length &&
    !noDcPath.length &&
    !noOutput
      ? {
          input: differential ? differential[0] : chosenInput,
          ...(differential
            ? { inputNeg: differential[1], mode: "differential" as const }
            : {}),
          matchAuto: true,
          ...(unmatch.length ? { unmatch } : {}),
          output: chosenOutput,
          ref: chosenReference === "0" ? null : chosenReference,
          freqs: parseFrequencies(frequencies),
          rin: true,
          rout: true,
          ...(handAnalysis ? { symbolic: true } : {}),
        }
      : null;
  const requestKey =
    netlist && request ? JSON.stringify([netlist.text, request]) : null;

  useEffect(() => {
    if (!requestKey) {
      setResponse(null);
      return;
    }
    // The key is the whole job: the netlist text and every request field.
    const [text, job] = JSON.parse(requestKey) as [string, SmallSignalRequest];
    const current = ++generation.current;
    const timer = setTimeout(() => {
      const client = clientRef.current;
      if (!client) return;
      setSolving(true);
      void client.analyze(text, job).then((next) => {
        if (current !== generation.current) return;
        setResponse(next);
        setSolving(false);
      });
    }, SOLVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // requestKey covers the netlist text and every request field.
  }, [requestKey]);

  const band = noiseBandRange(noiseBand);
  const noiseKey =
    noiseOpen && requestKey ? JSON.stringify([requestKey, band]) : null;
  useEffect(() => {
    // A new job, or none: drop the old result and any solve in flight, so
    // the section never shows numbers for a different circuit or band.
    const current = ++noiseGeneration.current;
    setNoiseResponse(null);
    if (!noiseKey) return;
    const [key, range] = JSON.parse(noiseKey) as [
      string,
      [number, number] | null,
    ];
    const [text, job] = JSON.parse(key) as [string, SmallSignalRequest];
    const timer = setTimeout(() => {
      noiseClientRef.current ??= createSmallSignalClient();
      noiseBusy.current = true;
      void noiseClientRef.current
        .analyze(text, {
          ...job,
          noise: true,
          ...(range ? { noiseBand: range } : {}),
        })
        .then((next) => {
          if (current !== noiseGeneration.current) return;
          noiseBusy.current = false;
          setNoiseResponse(next);
        });
    }, SOLVE_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      // The WASM solve runs to completion once started: a solve for a job no
      // longer wanted is stopped with its worker, and the next starts fresh.
      if (noiseBusy.current) {
        noiseClientRef.current?.dispose();
        noiseClientRef.current = null;
        noiseBusy.current = false;
      }
    };
  }, [noiseKey]);

  const blocked = unconnected.length > 0 || noDcPath.length > 0 || noOutput;
  const result =
    response && !isSmallSignalError(response) && !blocked ? response : null;
  const error =
    response && isSmallSignalError(response) && !blocked
      ? response.error
      : null;
  const inputSource = sources.find(
    (source) => source.name === (differential ? differential[0] : chosenInput),
  );
  const minusSource = differential
    ? sources.find((source) => source.name === differential[1])
    : undefined;
  const outputLabel =
    chosenReference === "0"
      ? signalLabel("v", chosenOutput)
      : `${signalLabel("v", chosenOutput)} - ${signalLabel("v", chosenReference)}`;
  const inputLabel = minusSource
    ? `${signalLabel("v", inputSource ? sourceLabel(inputSource) : "")} - ${signalLabel("v", sourceLabel(minusSource))}`
    : signalLabel(
        inputSource?.kind === "current" ? "i" : "v",
        inputSource ? sourceLabel(inputSource) : "",
      );
  const devices = Object.entries(result?.op?.devices ?? {});
  const allGood =
    result &&
    !result.warnings?.length &&
    devices.every(([, device]) =>
      ["saturation", "forward-active"].includes(String(device.region)),
    );
  const pinsNeedingBias = sources.filter(
    (source) => source.pin && unknownBias.includes(source.pin),
  );
  const otherUnknown = unknownBias.filter(
    (name) => !sources.some((source) => source.pin === name),
  );

  return (
    <StaleBuildContext.Provider value={markStale}>
      <section
        className="small-signal-panel"
        aria-label="Small-signal analysis"
        data-testid="small-signal-panel"
      >
        <header className="small-signal-header">
          <h2>Small-Signal</h2>
          {solving ? (
            <span className="small-signal-muted" role="status">
              Solving…
            </span>
          ) : null}
        </header>
        {staleBuild ? (
          <div className="small-signal-alert is-error" role="alert">
            <p>This page is an older version of the site.</p>
            <button
              type="button"
              onClick={() =>
                void recoverFromStaleBuild(browserStaleBuildRecovery())
              }
            >
              Reload to update
            </button>
          </div>
        ) : null}
        {!netlist ? (
          <p className="small-signal-muted">Draw a circuit to analyze it.</p>
        ) : (
          <>
            <div className="small-signal-io">
              <label>
                Input
                <select
                  aria-label="Input"
                  value={chosenInput ?? ""}
                  disabled={!sources.length}
                  onChange={(event) => setInput(event.currentTarget.value)}
                >
                  {sources.length ? null : (
                    <option value="">Add a source or Pin</option>
                  )}
                  {pairs.map((pair) => (
                    <option key={pairValue(pair)} value={pairValue(pair)}>
                      {sourceLabel(pair[0])} − {sourceLabel(pair[1])}
                    </option>
                  ))}
                  {sources.map((source) => (
                    <option key={source.name} value={source.name}>
                      {sourceLabel(source)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Output
                <select
                  aria-label="Output"
                  value={chosenOutput}
                  onChange={(event) => setOutput(event.currentTarget.value)}
                >
                  {nets
                    .filter((net) => net !== "0")
                    .map((net) => (
                      <option key={net} value={net}>
                        {net}
                      </option>
                    ))}
                </select>
              </label>
            </div>

            {unconnected.length ? (
              <div className="small-signal-alert is-error" role="alert">
                <p>
                  <b>{unconnected.join(", ")}</b>{" "}
                  {unconnected.length === 1 ? "is" : "are"} not connected.
                </p>
                <small>
                  Touching parts aren&apos;t connected. Draw a wire to it (W).
                </small>
              </div>
            ) : noOutput ? (
              <div className="small-signal-alert is-error" role="alert">
                <p>No output to measure.</p>
                <small>Check that the output isn&apos;t wired to ground.</small>
              </div>
            ) : noDcPath.length ? (
              <div className="small-signal-alert is-error" role="alert">
                <p>
                  Nothing drives <b>{noDcPath.join(", ")}</b>.
                </p>
                <small>Wire it, or add a Pin to use it as an input.</small>
              </div>
            ) : error ? (
              <div className="small-signal-alert is-error" role="alert">
                <p>{error}</p>
              </div>
            ) : result?.warnings?.length === 1 ? (
              <div className="small-signal-alert is-warning" role="alert">
                <p>{result.warnings[0]}</p>
              </div>
            ) : result?.warnings?.length ? (
              <div className="small-signal-alert is-warning" role="alert">
                <ul>
                  {result.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            ) : handAnalysis && result ? (
              <div className="small-signal-alert is-info" role="status">
                <p>Hand analysis: all transistors saturated.</p>
                {pinsNeedingBias.length || otherUnknown.length ? (
                  <small>Add bias voltages for numbers.</small>
                ) : null}
              </div>
            ) : allGood && devices.length ? (
              <div className="small-signal-alert is-ok" role="status">
                <p>
                  {devices.length === 1
                    ? `${devices[0]?.[0] ?? "The transistor"} is`
                    : "All transistors are"}{" "}
                  in saturation.
                </p>
              </div>
            ) : null}

            {result ? (
              <MatchedPairs
                result={result}
                onToggle={(key, on) =>
                  setUnmatched((prev) => {
                    const next = new Set(prev);
                    if (on) next.add(key);
                    else next.delete(key);
                    return next;
                  })
                }
              />
            ) : null}

            {pinsNeedingBias.length || otherUnknown.length ? (
              <div className="small-signal-bias-inputs">
                {pinsNeedingBias.map((source) => {
                  const pin = source.pin ?? source.name;
                  return (
                    <label key={pin}>
                      {pin} DC
                      <input
                        aria-label={`${pin} DC voltage`}
                        aria-invalid={
                          (pinBiasText[pin] ?? "").trim() !== "" &&
                          parseSpiceNumber(pinBiasText[pin] ?? "") === null
                            ? true
                            : undefined
                        }
                        placeholder="V"
                        value={pinBiasText[pin] ?? ""}
                        onChange={(event) => {
                          const text = event.currentTarget.value;
                          setPinBiasText((prev) => ({ ...prev, [pin]: text }));
                        }}
                      />
                    </label>
                  );
                })}
                {otherUnknown.length ? (
                  <small className="small-signal-muted">
                    Set the DC value of {otherUnknown.join(", ")} in Properties.
                  </small>
                ) : null}
              </div>
            ) : null}

            {result?.gain ? (
              <QuantityCard
                title="Gain"
                symbol={`\\frac{${outputLabel}}{${inputLabel}}`}
                quantity={result.gain}
                unit={inputSource?.kind === "current" ? "Ω" : ""}
              />
            ) : null}
            {result?.rin ? (
              <QuantityCard
                title="Input impedance"
                symbol="Z_{in}"
                quantity={result.rin}
                unit="Ω"
              />
            ) : null}
            {result?.rout ? (
              <QuantityCard
                title="Output impedance"
                symbol="Z_{out}"
                quantity={result.rout}
                unit="Ω"
              />
            ) : null}

            {result && devices.length ? (
              <section className="small-signal-card" aria-label="Bias point">
                <header>
                  <span>Bias point</span>
                </header>
                <BiasTable devices={devices} />
              </section>
            ) : null}

            {result ? (
              <details
                className="small-signal-options small-signal-noise"
                open={noiseOpen}
                onToggle={(event) => setNoiseOpen(event.currentTarget.open)}
              >
                <summary>Noise</summary>
                <div>
                  {!noiseResponse ? (
                    <span className="small-signal-formula-pending" />
                  ) : isSmallSignalError(noiseResponse) ? (
                    <p className="small-signal-muted">{noiseResponse.error}</p>
                  ) : noiseResponse.noise ? (
                    <>
                      <ExtraWarnings
                        warnings={noiseResponse.warnings}
                        shown={result.warnings}
                      />
                      <NoiseDetails
                        noise={noiseResponse.noise}
                        current={inputSource?.kind === "current"}
                        band={noiseBand}
                        onBand={setNoiseBand}
                      />
                    </>
                  ) : null}
                </div>
              </details>
            ) : null}

            <details className="small-signal-options">
              <summary>Options</summary>
              <div>
                <label>
                  Frequencies
                  <input
                    aria-label="Frequencies"
                    value={frequencies}
                    placeholder="1k, 1meg"
                    onChange={(event) =>
                      setFrequencies(event.currentTarget.value)
                    }
                  />
                </label>
                <label>
                  Measured against
                  <select
                    aria-label="Output reference"
                    value={chosenReference}
                    onChange={(event) =>
                      setReference(event.currentTarget.value)
                    }
                  >
                    {nets.map((net) => (
                      <option key={net} value={net}>
                        {net === "0" ? "ground" : net}
                      </option>
                    ))}
                  </select>
                </label>
                {netlist.supplies.length ? (
                  <label>
                    {netlist.supplies.join(", ")} (V)
                    <input
                      aria-label="Supply voltage"
                      value={supply}
                      onChange={(event) => setSupply(event.currentTarget.value)}
                    />
                  </label>
                ) : null}
                <label className="small-signal-check">
                  <input
                    type="checkbox"
                    checked={assumeSaturation}
                    onChange={(event) =>
                      setAssumeSaturation(event.currentTarget.checked)
                    }
                  />
                  Hand analysis (assume saturation)
                </label>
                <details>
                  <summary>Solver netlist</summary>
                  <pre>{netlist.text}</pre>
                </details>
              </div>
            </details>
            {netlist.models.length || modelTextEdited(modelText) ? (
              <details className="small-signal-options">
                <summary>
                  {modelTextEdited(modelText) ? "Models (edited)" : "Models"}
                </summary>
                <div>
                  {netlist.models.some((kind) => kind.endsWith("mos")) ? (
                    <small className="small-signal-muted">
                      Level 1. W/L as drawn.
                    </small>
                  ) : null}
                  <ModelFields
                    kinds={netlist.models}
                    text={modelText}
                    onChange={updateModelText}
                  />
                </div>
              </details>
            ) : null}
          </>
        )}
      </section>
    </StaleBuildContext.Provider>
  );
}
