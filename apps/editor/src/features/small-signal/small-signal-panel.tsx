import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { CircuitProject } from "@icm/model";
import {
  ANALOG_CANVAS_MATH_PROFILE_ID,
  CANONICAL_FORMULA_FONT_SIZE,
  cachedFormulaResult,
  prepareFormula,
  type FormulaArtifact,
  type FormulaRequest,
  type FormulaTypesetResult,
} from "@icm/math-typesetting/cache";
import { FORMULA_MAX_LATEX_LENGTH } from "@icm/math-typesetting/profile";
import {
  ASSUMPTION_TERMS,
  CAPACITANCE_PARAMETERS,
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
  type DistortionQuantity,
  type SmallSignalDistortion,
  type AssumableElement,
  type AssumedQuantity,
  type AssumptionTerm,
  type MillerReport,
  type RootPair,
  type RegionReport,
  type SmallSignalAssumptionReport,
  type SmallSignalElement,
  type SmallSignalNetlist,
  type SmallSignalApprox,
  type SmallSignalExpression,
  type SmallSignalSuggestion,
  type SmallSignalSuggestions,
  type SuggestQuantity,
} from "@icm/small-signal";
import {
  assumptionRequest,
  circuitStorageKey,
  isIgnored,
  isMiller,
  isTransistor,
  loadCircuits,
  loadDefaults,
  MILLER_TERMS,
  partKey,
  saveCircuits,
  saveDefaults,
  sameChoices,
  storeCircuit,
  takesRegion,
  touchCircuit,
  TRANSISTOR_TYPES,
  withDefault,
  withMiller,
  withRegion,
  withTerms,
  type AssumableType,
  type AssumptionDefaults,
  type CircuitAssumptions,
  type MillerTerm,
  type RegionChoice,
} from "./small-signal-assumption-store";
import { BodePlot, hasBode } from "./small-signal-bode";
import {
  CanvasOverlay,
  type OpDeviceLabel,
  type OpNetLabel,
} from "./small-signal-canvas";
import {
  createLinkStore,
  elementSymbols,
  symbolAt,
  symbolAtPoint,
  symbolElements,
  symbolHighlightCss,
  withSymbolKeys,
  type LinkStore,
} from "./small-signal-link";
import {
  DeviceMenu,
  ValueField,
  instanceHit,
  termText,
  type CanvasBadge,
  type DeviceMenuActions,
  type DeviceMenuModel,
  type DeviceMenuStatus,
  type MenuToggle,
  type PassiveChoice,
} from "./small-signal-device-menu";
import {
  fieldEdit,
  partFields,
  type PartField,
} from "./small-signal-part-fields";
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
  // Capacitances, all 0 (none) by default. TOX in m (0: no Meyer gate
  // capacitances); overlap and sidewall per m, CJ per m²; potentials in V;
  // grading coefficients and FC below the 1 where the formulas diverge.
  TOX: { min: 1e-10, max: 1e-5, zero: true },
  CGSO: { min: 0, max: 1e-6 },
  CGDO: { min: 0, max: 1e-6 },
  CGBO: { min: 0, max: 1e-6 },
  CJ: { min: 0, max: 10 },
  MJ: { min: 0, max: 0.99 },
  CJSW: { min: 0, max: 1e-6 },
  MJSW: { min: 0, max: 0.99 },
  PB: { min: 0.01, max: 10 },
  FC: { min: 0, max: 0.95 },
  CBD: { min: 0, max: 1e-6 },
  CBS: { min: 0, max: 1e-6 },
  CJE: { min: 0, max: 1e-6 },
  VJE: { min: 0.01, max: 10 },
  MJE: { min: 0, max: 0.99 },
  CJC: { min: 0, max: 1e-6 },
  VJC: { min: 0.01, max: 10 },
  MJC: { min: 0, max: 0.99 },
  XCJC: { min: 0, max: 1 },
  CJS: { min: 0, max: 1e-6 },
  TF: { min: 0, max: 1e-3 },
  CJO: { min: 0, max: 1e-6 },
  VJ: { min: 0.01, max: 10 },
  M: { min: 0, max: 0.99 },
  TT: { min: 0, max: 1e-3 },
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

export const APPROX_STORAGE_KEY = "smallsignal.approx";

/** How the ≈ forms are made, as the Options section offers it. */
export const APPROX_LABEL: Record<SmallSignalApprox, string> = {
  named: "Named assumptions",
  terms: "Smallest terms",
};

/** The stored ≈ method: named assumptions unless "terms" is stored. */
export function readApprox(stored: string | null): SmallSignalApprox {
  return stored === "terms" ? "terms" : "named";
}

function loadApprox(): SmallSignalApprox {
  try {
    return readApprox(window.localStorage.getItem(APPROX_STORAGE_KEY));
  } catch {
    return "named";
  }
}

function saveApprox(approx: SmallSignalApprox) {
  try {
    window.localStorage.setItem(APPROX_STORAGE_KEY, approx);
  } catch {
    // As for the models.
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
  const field = (kind: ModelKind, name: string, fallback: number) => {
    const typed = text[kind]?.[name] ?? "";
    const invalid = typed.trim() !== "" && modelValue(name, typed) === null;
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
  };
  return (
    <>
      {shown.map((kind) => {
        const entries = Object.entries(DEFAULT_MODEL_PARAMETERS[kind]);
        const charge = CAPACITANCE_PARAMETERS[kind];
        const typedCharge = charge.filter((name) => text[kind]?.[name]?.trim());
        return (
          <fieldset key={kind} className="small-signal-model">
            <legend>{MODEL_TITLE[kind]}</legend>
            {entries
              .filter(([name]) => !charge.includes(name))
              .map(([name, fallback]) => field(kind, name, fallback))}
            <details
              className="small-signal-model-caps"
              open={typedCharge.length > 0 || undefined}
            >
              <summary>
                Capacitances
                {typedCharge.length ? ` (${typedCharge.length} set)` : ""}
              </summary>
              <div className="small-signal-model">
                {entries
                  .filter(([name]) => charge.includes(name))
                  .map(([name, fallback]) => field(kind, name, fallback))}
              </div>
            </details>
          </fieldset>
        );
      })}
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
  // Past the prefixes (a leakage current of 1e-20 A): an exponent, never
  // "0.00002586 fA".
  if (Math.abs(value) < 1e-15)
    return `${value.toExponential(3)}${unit ? ` ${unit}` : ""}`;
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
  return <TypesetFormula latex={latex} artifact={result.artifact} />;
}

/**
 * A typeset formula, inline so each symbol can be pointed at (its device
 * lights up on the drawing); copying a selection writes the TeX
 * (`copyWithTex`). Long expressions keep their size and scroll sideways
 * rather than shrinking past legibility.
 */
function TypesetFormula({
  latex,
  artifact,
}: {
  latex: string;
  artifact: FormulaArtifact;
}) {
  const svg = useMemo(() => withSymbolKeys(artifact.svg), [artifact.svg]);
  return (
    <div className="small-signal-formula-scroll">
      <span
        className="small-signal-formula"
        role="img"
        aria-label={latex}
        data-tex={latex}
        style={{
          width: `${artifact.width / CANONICAL_FORMULA_FONT_SIZE}em`,
          height: `${artifact.height / CANONICAL_FORMULA_FONT_SIZE}em`,
        }}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </div>
  );
}

/**
 * Copying a selection of the panel: each typeset formula as its TeX,
 * `$…$` (an SVG has no text to copy), and no plot's axis labels; lines as
 * the panel lays them out. Null when the selection holds neither.
 */
export function copyWithTex(fragment: DocumentFragment): string | null {
  const formulas = fragment.querySelectorAll<HTMLElement>(
    ".small-signal-formula[data-tex]",
  );
  const plots = fragment.querySelectorAll(".small-signal-bode");
  if (!formulas.length && !plots.length) return null;
  const document = fragment.ownerDocument;
  for (const formula of formulas)
    formula.replaceWith(
      document.createTextNode(` $${formula.dataset.tex ?? ""}$ `),
    );
  for (const plot of plots) plot.remove();
  // innerText needs a rendered element: off screen, in the panel's styles.
  const host = document.createElement("div");
  host.className = "small-signal-panel";
  host.style.cssText = "position: fixed; left: -10000px; top: 0; width: 600px";
  host.append(fragment);
  document.body.append(host);
  const text = host.innerText;
  host.remove();
  return text
    .replace(/[ \t]+/gu, " ")
    .replace(/ *\n+ */gu, "\n")
    .trim();
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

/** "2 poles, 1 zero"; "" when there are none. */
export function countText(poles = 0, zeros = 0): string {
  const part = (n: number, one: string) =>
    n ? `${n} ${one}${n === 1 ? "" : "s"}` : "";
  return [part(poles, "pole"), part(zeros, "zero")].filter(Boolean).join(", ");
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
  assumed,
}: {
  symbol: string;
  quantity: SmallSignalQuantity;
  /** Set under assumptions: the forms are the assumed model's. */
  assumed?: AssumedQuantity | undefined;
}) {
  const display = quantity.display;
  const shown =
    display && !display.same && display.latex !== null ? display : null;
  if (assumed) {
    // Every form is the assumed model's: exact for it ("="), said with its
    // distance from the full model rather than from its own exact form.
    // "≈" belongs to a simplified form only.
    const lead = shown ?? quantity.exact;
    if (!lead?.latex)
      return <ExactFormula symbol={symbol} quantity={quantity} />;
    const error = lead.fullModelError ?? assumed.maxRelError;
    // Unbounded in both models has no metric (null), and is no difference.
    const equals =
      (error !== null && error < INVISIBLE_ERROR) ||
      Boolean(assumed.infinite && quantity.infinite);
    // The display form drops junction leakage the assumed model has.
    const leaky = shown !== null && (shown.maxRelError ?? 0) >= INVISIBLE_ERROR;
    return (
      <>
        <Formula
          latex={`${symbol} ${leaky ? "\\approx" : "="} ${lead.latex}`}
        />
        {equals ? null : (
          <FullModelNote error={error} assumed leakage={leaky} />
        )}
        {shown ? (
          <details className="small-signal-exact">
            <summary>{EXACT_ASSUMED}</summary>
            <ExactFormula symbol={symbol} quantity={quantity} />
          </details>
        ) : null}
      </>
    );
  }
  if (!shown) {
    return <ExactFormula symbol={symbol} quantity={quantity} />;
  }
  const error = shown.maxRelError ?? 0;
  const invisible = error < INVISIBLE_ERROR;
  return (
    <>
      <Formula
        latex={`${symbol} ${invisible ? "=" : "\\approx"} ${shown.latex}`}
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
  if (!quantity.exact?.latex) {
    return (
      <p className="small-signal-muted">
        The exact expression is too large to typeset.
      </p>
    );
  }
  return <Formula latex={`${symbol} = ${quantity.exact.latex}`} />;
}

/**
 * A relative error: "2.0%", "150%"; from twice the value on, as a
 * multiple of it, "3.4×", "181×", "18,000×", never thousands of percent.
 */
export function formatPercent(fraction: number): string {
  if (!Number.isFinite(fraction)) return "∞";
  const percent = fraction * 100;
  if (percent === 0) return "0%";
  if (percent < 0.1) return "<0.1%";
  if (fraction >= 2) {
    const times =
      fraction < 10
        ? fraction.toFixed(1)
        : fraction < 1000
          ? String(Math.round(fraction))
          : Number(fraction.toPrecision(2)).toLocaleString("en-US");
    return `${times}×`;
  }
  // Two digits, without an exponent past 100%.
  return percent >= 99.5
    ? `${Math.round(percent)}%`
    : `${percent.toPrecision(2)}%`;
}

/** The exact form's disclosure under assumptions. */
const EXACT_ASSUMED = "Exact for these assumptions";

/** "2.1% from full model"; nothing without a number (symbolic, unbounded). */
function fullModelText(error: number | null | undefined): string | null {
  return error == null ? null : `${formatPercent(error)} from full model`;
}

/**
 * A leading simpler form's note under assumptions: what it assumes, if
 * anything, and its distance from the full model. Its error against the
 * assumed exact form would be a second, smaller percentage, so it goes.
 */
function leadNote(
  simplerNote: string,
  error: number | null | undefined,
): string {
  return [
    simplerNote.startsWith("within ") ? null : simplerNote,
    fullModelText(error),
  ]
    .filter(Boolean)
    .join(", ");
}

/** "Assumed model, 2.1% from full model": an exact form of the assumed
 * model, and what the assumptions cost. */
export function assumedModelText(
  error: number | null | undefined,
  leakage = false,
): string | null {
  const text = fullModelText(error);
  if (!text) return null;
  return leakage
    ? `Assumed model, junction leakage neglected, ${text}`
    : `Assumed model, ${text}`;
}

function FullModelNote({
  error,
  assumed = false,
  leakage = false,
}: {
  error: number | null | undefined;
  /** The form is exact for the assumed model: say so. */
  assumed?: boolean;
  /** ...less its junction leakage. */
  leakage?: boolean;
}) {
  const text = assumed
    ? assumedModelText(error, leakage)
    : fullModelText(error);
  return text ? (
    <small className="small-signal-muted" data-full-model-note>
      {text}
    </small>
  ) : null;
}

/**
 * A solver label split at its subscripts, "_" to the next space (a
 * trailing comma excepted): "r_o2 → ∞" is r, o2, " → ∞".
 */
export function subscriptParts(
  text: string,
): (string | { base: string; sub: string })[] {
  const parts: (string | { base: string; sub: string })[] = [];
  for (const token of text.split(/(\s+)/u)) {
    const [, base, sub, comma] = /^([^_\s]+)_(\S+?)(,?)$/u.exec(token) ?? [];
    if (base === undefined || sub === undefined) {
      if (token) parts.push(token);
      continue;
    }
    parts.push({ base, sub });
    if (comma) parts.push(comma);
  }
  return parts;
}

function SubscriptText({ text }: { text: string }) {
  return (
    <>
      {subscriptParts(text).map((part, index) =>
        typeof part === "string" ? (
          part
        ) : (
          <span key={index}>
            {part.base}
            <sub>{part.sub}</sub>
          </span>
        ),
      )}
    </>
  );
}

/**
 * A named form's note: what it assumes and its error, "r_o2 → ∞, within
 * 0.25%"; under assumptions its distance from the full model instead, as
 * every assumed form says it.
 */
function NamedNote({
  form,
  assumed,
}: {
  form: SmallSignalExpression;
  assumed: boolean;
}) {
  const error = assumed
    ? fullModelText(form.fullModelError)
    : `within ${formatPercent(form.maxRelError ?? 0)}`;
  return (
    <span data-approx="named">
      {form.assumption ? <SubscriptText text={form.assumption} /> : null}
      {form.assumption && error ? ", " : null}
      {error}
    </span>
  );
}

/** "No simple form within 5.0%." */
export function noneText(form: SmallSignalExpression): string {
  return `No simple form within ${formatPercent(form.tolerance ?? 0.05)}.`;
}

/**
 * The assumed model's poles and zeros beside the full model's, one row per
 * conjugate pair.
 */
function rootPairRows(assumed: AssumedQuantity): [string, RootPair][] {
  return (
    [
      ...assumed.poles.map((pair) => ["Pole", pair]),
      ...assumed.zeros.map((pair) => ["Zero", pair]),
    ] as [string, RootPair][]
  ).filter(([, pair]) =>
    [pair.assumed, pair.full].every((root) => !root || root.im >= 0),
  );
}

/** Whether an assumption moved or removed any pole or zero. */
function rootsMoved(assumed: AssumedQuantity): boolean {
  return rootPairRows(assumed).some(
    ([, pair]) => !pair.assumed || !pair.full || pair.relError !== 0,
  );
}

/**
 * Full model against assumed: the values per frequency when they differ
 * anywhere, then the poles and zeros when any moved ("removed" where an
 * assumption took one away). Nothing when the two agree.
 */
function AssumedTable({
  values,
  assumed,
  unit,
}: {
  values: readonly ComplexPoint[];
  assumed: AssumedQuantity;
  unit: string;
}) {
  const infinite = (point: ComplexPoint | undefined) =>
    Boolean(point && (point.inf || point.re === null));
  // Equal (0), or unbounded in both models (no metric, null).
  const same = (index: number) => {
    const error = assumed.relError[index];
    return (
      error === 0 ||
      (error == null &&
        infinite(values[index]) &&
        infinite(assumed.values[index]))
    );
  };
  const valuesDiffer = !values.every((_, index) => same(index));
  const roots = rootPairRows(assumed);
  const moved = rootsMoved(assumed);
  if (!valuesDiffer && !moved) return null;
  return (
    <table className="small-signal-values" aria-label="Full model and assumed">
      <thead>
        <tr>
          <th />
          <th scope="col">Full model</th>
          <th scope="col">Assumed</th>
          <th scope="col">Δ</th>
        </tr>
      </thead>
      <tbody>
        {valuesDiffer
          ? values.map((point, index) => {
              const value = assumed.values[index];
              const error = assumed.relError[index];
              return (
                <tr key={point.f} data-frequency={point.f}>
                  <th scope="row">{formatEngineering(point.f, "Hz")}</th>
                  <td data-quantity="full">{pointText(point, unit)}</td>
                  <td data-quantity="assumed">
                    {value ? pointText(value, unit) : ""}
                  </td>
                  <td data-quantity="delta">
                    {error == null ? "—" : formatPercent(error)}
                  </td>
                </tr>
              );
            })
          : null}
        {moved
          ? roots.map(([kind, pair], index) => (
              <tr key={`${kind}${index}`} data-root={kind.toLowerCase()}>
                <th scope="row">{kind}</th>
                <td data-quantity="full">
                  {pair.full ? rootText(pair.full) : "—"}
                </td>
                <td data-quantity="assumed">
                  {pair.assumed ? rootText(pair.assumed) : "removed"}
                </td>
                <td data-quantity="delta">
                  {pair.relError == null ? "" : formatPercent(pair.relError)}
                </td>
              </tr>
            ))
          : null}
      </tbody>
    </table>
  );
}

/**
 * Whether the forms are the assumed model's: anything neglected, split or
 * linearized in a region imposed on the bias. Without a bias a declared
 * region already shapes the full model's forms.
 */
export function anyAssumed(
  report: SmallSignalAssumptionReport | undefined,
): boolean {
  return Boolean(
    report?.applied.length ||
    report?.miller?.length ||
    report?.regions?.some(
      (region) => region.effect === "imposed" && region.actual !== null,
    ),
  );
}

/** C_C for capacitor CC, C_gd2 for C_gd of M2: as the equations write it. */
function SplitCapacitance({ split }: { split: MillerReport }) {
  const rest = split.element.slice(1);
  const sub =
    split.term === null
      ? rest
      : `${CAP_SUB[split.term] ?? split.term.slice(1)}${/^[\d,]*$/u.test(rest) ? rest : `,${rest}`}`;
  return (
    <>
      C<sub>{sub}</sub>
    </>
  );
}

/** "−84.1": K to three digits, with a minus sign. */
export function kText(k: number): string {
  return Number(k.toPrecision(3)).toString().replace(/^-/u, "−");
}

/**
 * The Miller splits the forms are exact for: "Miller C_C, K = −84.1". In
 * symbolic mode K is a symbol, shown with its definition.
 */
function MillerNote({ splits }: { splits: readonly MillerReport[] }) {
  return (
    <>
      {splits.map((split) => (
        <div
          key={`${split.element}:${split.term ?? ""}`}
          className="small-signal-muted small-signal-miller"
          data-miller={split.element}
        >
          Miller <SplitCapacitance split={split} />,{" "}
          {split.k !== null ? (
            `K = ${kText(split.k)}`
          ) : split.definition ? (
            <Formula latex={`${split.symbol} = ${split.definition.latex}`} />
          ) : (
            "K unavailable"
          )}
        </div>
      ))}
    </>
  );
}

/**
 * Whether a card shows the ≈ form: as its own row, or as the lead itself
 * when that is the leakage-free display form written "≈" and the
 * simplified form is the same one. Its curve is plotted whenever it is.
 */
export function approxShown(quantity: SmallSignalQuantity): boolean {
  const { display, simplified, exact } = quantity;
  if (!simplified || simplified.same || simplified.latex === null) return false;
  const shown =
    display && !display.same && display.latex !== null ? display : null;
  const lead = shown?.latex ?? exact?.latex;
  if (simplified.latex !== lead) return true;
  return shown !== null && (shown.maxRelError ?? 0) >= INVISIBLE_ERROR;
}

/** Shown once, on the first result whose formula is over the budget. */
const NO_FORMULA_NOTE = "Formula too large to derive. Try a smaller block.";

/** One result: its equation, its value, and its poles. */
function QuantityCard({
  title,
  symbol,
  quantity,
  unit,
  noFormulaNote = false,
  assumed,
  miller,
  regions,
  sweep,
}: {
  title: string;
  symbol: string;
  quantity: SmallSignalQuantity;
  unit: string;
  /** Say why there is no formula (when the exact form is over budget). */
  noFormulaNote?: boolean;
  /** Set under assumptions; the header value stays the full model's. */
  assumed?: AssumedQuantity | undefined;
  /** The Miller splits the assumed forms are exact for. */
  miller?: readonly MillerReport[] | undefined;
  /** The regions the forms impose ("M1 assumed saturated"). */
  regions?: readonly RegionReport[] | undefined;
  /** The swept frequencies of `quantity.sweep`, for its Bode plot. */
  sweep?: readonly number[] | undefined;
}) {
  const imposed = assumed ? regionNote(regions) : null;
  // The simpler form appears only when it actually dropped terms, and never
  // repeats the form above it (an assumption can leave nothing to drop).
  const display = quantity.display;
  const leadLatex =
    display && !display.same && display.latex !== null
      ? display.latex
      : quantity.exact?.latex;
  const simpler =
    quantity.simplified &&
    !quantity.simplified.same &&
    quantity.simplified.latex !== leadLatex
      ? quantity.simplified
      : null;
  const value = quantity.values?.[0];
  const exact = quantity.exact;
  const terms = exact?.terms;
  const exactIsLong =
    !exact?.latex ||
    (terms ? terms.num + terms.den > 6 : exact.latex.length > 160);
  const simplerNote = simpler?.assumption
    ? `assuming ${simpler.assumption}`
    : `within ${formatPercent(simpler?.maxRelError ?? 0)} of exact`;
  // A named form says what it assumes and its distance from the full model.
  const note =
    simpler?.method === "named" ? (
      <NamedNote form={simpler} assumed={Boolean(assumed)} />
    ) : null;
  const none = quantity.simplified?.none ? (
    <small className="small-signal-muted" data-approx="none">
      {noneText(quantity.simplified)}
    </small>
  ) : null;
  const poleCount = quantity.poles?.length ?? 0;
  const poles = (quantity.poles ?? []).map(rootText).filter(Boolean);
  // Symbolic mode has no root values, only their number.
  const rootCount = quantity.values?.length
    ? ""
    : countText(quantity.poleCount, quantity.zeroCount);
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
      {!exact ? (
        // Over the term budget: numbers only, no formula to show.
        noFormulaNote ? (
          <small className="small-signal-muted">{NO_FORMULA_NOTE}</small>
        ) : null
      ) : simpler && exactIsLong ? (
        <>
          {/* A long exact form would bury the result: lead with the
              readable one and keep the exact form a click away. */}
          <Formula latex={`${symbol} \\approx ${simpler.latex}`} />
          <small className="small-signal-muted">
            {note ??
              (assumed
                ? leadNote(simplerNote, simpler.fullModelError)
                : simplerNote)}
          </small>
          <details className="small-signal-exact">
            <summary>{assumed ? EXACT_ASSUMED : "Exact"}</summary>
            <ExactFormula symbol={symbol} quantity={quantity} />
          </details>
        </>
      ) : (
        <>
          <MainFormula symbol={symbol} quantity={quantity} assumed={assumed} />
          {simpler ? (
            <div className="small-signal-simpler">
              <Formula latex={`\\approx ${simpler.latex}`} />
              <small>{note ?? simplerNote}</small>
            </div>
          ) : null}
          {none}
        </>
      )}
      {imposed ? (
        <small className="small-signal-region-note" data-region-note>
          {imposed}
        </small>
      ) : null}
      {assumed && miller?.length ? <MillerNote splits={miller} /> : null}
      {sweep && hasBode(sweep, quantity.sweep?.full) ? (
        <BodePlot
          title={title}
          freqs={sweep}
          curves={{
            full: quantity.sweep?.full,
            assumed: assumed ? quantity.sweep?.assumed : null,
            approx: approxShown(quantity) ? quantity.sweep?.approx : null,
          }}
          ohms={unit === "Ω"}
          poles={quantity.poles}
          zeros={quantity.zeros}
          format={formatEngineering}
        />
      ) : null}
      {assumed && quantity.values?.length ? (
        <AssumedTable values={quantity.values} assumed={assumed} unit={unit} />
      ) : quantity.values && quantity.values.length > 1 ? (
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
      {assumed &&
      quantity.values?.length &&
      rootsMoved(assumed) ? null : poles.length ? (
        <small className="small-signal-muted">
          {poleCount === 1 ? "Pole" : "Poles"} {poles.join(", ")}
        </small>
      ) : rootCount ? (
        <small className="small-signal-muted">{rootCount}</small>
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

/** A noise source as the tables name it: "M1 thermal". */
function noiseLabel(source: { element: string; kind: string }): string {
  return `${source.element} ${NOISE_KIND[source.kind] ?? source.kind}`;
}

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

/**
 * The Noise solve's job as a key, or null while there is none to run: the
 * section closed, no circuit, or the main solve for this very request not
 * answered yet. That answer says whether the exact forms are over the term
 * budget (then Noise skips them), so an exact noise solve never runs
 * alongside the main one.
 */
export function noiseJobKey(
  open: boolean,
  requestKey: string | null,
  responseKey: string | null,
  band: [number, number] | null,
  overBudget: boolean,
): string | null {
  return open && requestKey && responseKey === requestKey
    ? JSON.stringify([requestKey, band, overBudget])
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
 * already summed). A source with no finite share is an unbounded one (e.g.
 * flicker at 0 Hz): it is listed first, with a null share, never dropped.
 */
export function topContributions(
  sources: readonly NoiseContribution[],
  /** The solver's omitted bucket: null when it is unbounded. */
  omittedFraction: number | null = 0,
  limit = 4,
): { label: string; fraction: number | null }[] {
  const unbounded = sources
    .filter((source) => !Number.isFinite(source.fraction))
    .map((source) => ({ label: noiseLabel(source), fraction: null }));
  const sorted = sources
    .filter((source): source is NoiseContribution & { fraction: number } =>
      Number.isFinite(source.fraction),
    )
    .sort((a, b) => b.fraction - a.fraction);
  const room = Math.max(0, limit - unbounded.length);
  const rows = [
    ...unbounded,
    ...sorted.slice(0, room).map((source) => ({
      label: noiseLabel(source),
      fraction: source.fraction,
    })),
  ];
  // An unbounded omitted bucket is shown like an unbounded source.
  if (omittedFraction === null)
    return [...rows, { label: "others", fraction: null }];
  const rest =
    sorted.slice(room).reduce((sum, s) => sum + s.fraction, 0) +
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

/** One form of an equation, as the caller knows it. */
interface ShownForm {
  latex: string | null;
  terms?: number | null;
  /** Relative error against the exact form (junction leakage dropped). */
  relError?: number | null;
  /** Under assumptions: relative distance from the full model. */
  fullModelError?: number | null;
}

/**
 * An equation in its most readable faithful form, labelled honestly:
 * - the shown form with "=" when it is exact (or its error is invisible),
 *   else "≈" and the leakage it neglects, with the simpler form under it;
 * - the simpler form first when the shown one is long or missing (as on
 *   the result cards);
 * - "Exact" a click away when the lead is not exact: the exact form, or a
 *   note that it is too large to typeset. Nothing inexact is labelled exact.
 * Under assumptions every form is the assumed model's: "≈", with its
 * distance from the full model in place of the leakage note.
 */
function LeadFormula({
  symbol,
  shown,
  shownIsExact,
  simpler,
  simplerNote,
  exact,
  assumed = false,
}: {
  symbol: string;
  shown: ShownForm | null;
  shownIsExact: boolean;
  simpler: ShownForm | null;
  simplerNote: string;
  /** The exact form's LaTeX; null when it is too large to typeset. */
  exact: string | null;
  assumed?: boolean;
}) {
  const exactDisclosure = (
    <details className="small-signal-exact">
      <summary>{assumed ? EXACT_ASSUMED : "Exact"}</summary>
      {exact ? (
        <Formula latex={`${symbol} = ${exact}`} />
      ) : (
        <p className="small-signal-muted">
          The exact expression is too large to typeset.
        </p>
      )}
    </details>
  );
  const long =
    !shown?.latex ||
    (shown.terms ?? 0) > 6 ||
    shown.latex.length > FORMULA_MAX_LATEX_LENGTH;
  if (simpler?.latex && long) {
    return (
      <>
        <Formula latex={`${symbol} \\approx ${simpler.latex}`} />
        <small className="small-signal-muted">
          {assumed
            ? leadNote(simplerNote, simpler.fullModelError)
            : simplerNote}
        </small>
        {exactDisclosure}
      </>
    );
  }
  if (!shown?.latex) {
    // No form small enough to typeset: say so rather than show nothing.
    return (
      <>
        <Formula latex={`${symbol} = \\ldots`} />
        <small className="small-signal-muted">too large to typeset</small>
      </>
    );
  }
  const error = shown.relError ?? 0;
  const fullModelError = shown.fullModelError ?? null;
  // "=" when the form is exact for its model (the assumed one under
  // assumptions, whose cost the note gives); "≈" only for a form that
  // drops something.
  const equals = shownIsExact || error < INVISIBLE_ERROR;
  const costless = fullModelError !== null && fullModelError < INVISIBLE_ERROR;
  return (
    <>
      <Formula
        latex={`${symbol} ${equals ? "=" : "\\approx"} ${shown.latex}`}
      />
      {assumed ? (
        costless ? null : (
          <FullModelNote error={fullModelError} assumed leakage={!equals} />
        )
      ) : equals ? null : (
        <small className="small-signal-muted">
          neglecting junction leakage ({formatPercent(error)})
        </small>
      )}
      {simpler?.latex ? (
        <div className="small-signal-simpler">
          <Formula latex={`\\approx ${simpler.latex}`} />
          <small>{simplerNote}</small>
        </div>
      ) : null}
      {shownIsExact ? null : exactDisclosure}
    </>
  );
}

/** A distortion quantity: its display form, simpler form and exact form. */
function DistortionFormula({
  symbol,
  quantity,
  assumed,
}: {
  symbol: string;
  quantity: DistortionQuantity;
  assumed: boolean;
}) {
  // The display form (leakage dropped), else the exact form itself.
  const display = quantity.display?.latex ? quantity.display : null;
  const shown: ShownForm | null = display ?? (quantity.latex ? quantity : null);
  const shownIsExact = Boolean(
    shown &&
    (shown === quantity ||
      display?.same ||
      (quantity.latex !== null && quantity.latex === display?.latex)),
  );
  const simpler =
    quantity.simplified?.latex && quantity.simplified.latex !== shown?.latex
      ? quantity.simplified
      : null;
  return (
    <LeadFormula
      symbol={symbol}
      shown={shown}
      shownIsExact={shownIsExact}
      simpler={simpler}
      simplerNote={
        simpler?.method?.startsWith("leading order")
          ? "assuming ro ≫ R, 1/gm"
          : `within ${formatPercent(simpler?.relError ?? 0)} of exact`
      }
      exact={shownIsExact ? (shown?.latex ?? null) : quantity.latex}
      assumed={assumed}
    />
  );
}

/**
 * A device Taylor coefficient as the solver writes it: K_{2g,M1},
 * K_{g\\,d,M1}, K^{C}_{2be\\,ce,Q1} (the current is omitted for a drain).
 */
export function taylorLatex(term: {
  element: string;
  current: string;
  monomial: string;
}): string {
  const factors =
    term.monomial.match(/\d?(?:be|ce|bc|bs|bd|g|d|b)/gu)?.join("\\,") ??
    term.monomial;
  const current = term.current === "D" ? "" : `^{${term.current}}`;
  return `K${current}_{${factors},${texEscape(term.element)}}`;
}

/**
 * TeX specials in a name, escaped as the solver's `ss::esc` does, so a name
 * like `M_load` renders as text and can never inject a macro.
 */
export function texEscape(text: string): string {
  return text.replace(/[_{}$&#%\\^~]/gu, (c) =>
    c === "\\"
      ? "\\backslash "
      : c === "^"
        ? "\\hat{}"
        : c === "~"
          ? "\\sim "
          : `\\${c}`,
  );
}

/** The solver writes an infinite quantity as `\\infty` with no value. */
function isInfinite(quantity: DistortionQuantity | null | undefined): boolean {
  return quantity?.value == null && quantity?.latex === "\\infty";
}

/** HD as shown: a percentage, ∞ when infinite, "—" when unavailable. */
export function hdText(value: number | null, infinite?: boolean): string {
  if (value != null) return formatDistortion(value)[0];
  return infinite ? "∞" : "—";
}

/** A distortion ratio as a percentage and in dBc. */
export function formatDistortion(ratio: number): [string, string] {
  const percent = ratio * 100;
  const text =
    percent === 0
      ? "0%"
      : percent >= 0.01
        ? `${Number(percent.toPrecision(3))}%`
        : `${percent.toExponential(2)}%`;
  return [text, ratio > 0 ? `${(20 * Math.log10(ratio)).toFixed(1)} dBc` : ""];
}

/** Above this, a 3rd-order expansion no longer describes the output. */
const LARGE_DISTORTION = 0.1;

/**
 * Distortion: the output's Taylor coefficients a₁…a₃ as equations, HD2,
 * HD3 and IIP3 at the input amplitude, and each device's coefficients.
 */
function DistortionDetails({
  distortion,
  current,
  assumed,
}: {
  distortion: SmallSignalDistortion;
  current: boolean;
  /** Under assumptions the closed forms and their values are the assumed
   * model's; HD by frequency stays the full model's. */
  assumed: boolean;
}) {
  const v = current ? "i" : "v";
  const rows: [string, DistortionQuantity | null][] = [
    ["HD2", distortion.hd2],
    ["HD3", distortion.hd3],
  ];
  // The summary is the low-frequency (s → 0) value. Show HD at the asked
  // frequencies too wherever it differs from that, even at one frequency
  // (near a pole): never let the low-frequency value pass for it.
  const differs = (at: number | null, low: number | null | undefined) =>
    at === null || low == null
      ? // Available at one and not the other, either way round.
        (at === null) !== (low == null)
      : Math.abs(at - low) > 1e-6 * Math.max(Math.abs(low), Math.abs(at));
  const varies = distortion.vsFreq.some(
    (point) =>
      differs(point.hd2, distortion.hd2?.value) ||
      differs(point.hd3, distortion.hd3?.value) ||
      Boolean(point.hd2Infinite) !== isInfinite(distortion.hd2) ||
      Boolean(point.hd3Infinite) !== isInfinite(distortion.hd3),
  );
  const a1 = distortion.coefficients.find(
    (coefficient) => coefficient.order === 1,
  )?.value;
  // a₁ = 0 (the input's fundamental never reaches this output): HD is
  // infinite whatever the amplitude.
  // a₁ = 0 at low frequency: no fundamental at all. Otherwise only at the
  // frequencies (transfer notches) marked infinite.
  const noFundamental =
    isInfinite(distortion.hd2) || isInfinite(distortion.hd3);
  const notchFrequencies = distortion.vsFreq
    .filter((point) => point.hd2Infinite || point.hd3Infinite)
    .map((point) => formatEngineering(point.f, "Hz"));
  const large = [
    distortion.hd2?.value,
    distortion.hd3?.value,
    ...distortion.vsFreq.flatMap((point) => [point.hd2, point.hd3]),
  ].some((value) => (value ?? 0) > LARGE_DISTORTION);
  return (
    <>
      <table className="small-signal-values" aria-label="Distortion">
        {assumed ? (
          <caption>Assumed{varies ? ", at low frequency" : ""}</caption>
        ) : varies ? (
          <caption>At low frequency</caption>
        ) : null}
        <tbody>
          {a1 != null ? (
            // The swing these numbers assume: an unrealistic one is obvious.
            <tr data-quantity="output">
              <th scope="row">Output</th>
              <td>
                {formatEngineering(Math.abs(a1) * distortion.amplitude, "V")}
              </td>
              <td />
            </tr>
          ) : null}
          {rows.map(([name, quantity]) =>
            quantity ? (
              <tr key={name} data-quantity={name.toLowerCase()}>
                <th scope="row">{name}</th>
                <td>{hdText(quantity.value, isInfinite(quantity))}</td>
                <td className="small-signal-muted">
                  {quantity.value != null
                    ? formatDistortion(quantity.value)[1]
                    : ""}
                </td>
              </tr>
            ) : null,
          )}
          {distortion.iip3 ? (
            // a₃ = 0 makes the intercept infinite, which is a result too.
            <tr data-quantity="iip3">
              <th scope="row">IIP3</th>
              <td>
                {distortion.iip3.value != null
                  ? formatEngineering(
                      distortion.iip3.value,
                      distortion.inputUnit,
                    )
                  : distortion.iip3.latex === "\\infty"
                    ? "∞"
                    : "—"}
              </td>
              <td />
            </tr>
          ) : null}
        </tbody>
      </table>
      {noFundamental ? (
        <p className="small-signal-muted" role="note">
          The input's fundamental does not reach this output.
        </p>
      ) : notchFrequencies.length ? (
        <p className="small-signal-muted" role="note">
          The input's fundamental does not reach this output at{" "}
          {notchFrequencies.join(", ")}.
        </p>
      ) : null}
      {!noFundamental && large ? (
        <p className="small-signal-muted" role="note">
          The amplitude is too large for a 3rd-order expansion.
        </p>
      ) : null}
      <Formula
        latex={`v_{out} = a_{1} ${v}_{in} + a_{2} ${v}_{in}^{2}${distortion.order >= 3 ? ` + a_{3} ${v}_{in}^{3}` : ""}`}
      />
      {distortion.coefficients.map((coefficient) => (
        <DistortionFormula
          key={coefficient.order}
          symbol={`a_{${coefficient.order}}`}
          quantity={coefficient}
          assumed={assumed}
        />
      ))}
      <details className="small-signal-exact">
        <summary>HD2, HD3, IIP3</summary>
        {distortion.hd2 ? (
          <DistortionFormula
            symbol="HD_{2}"
            quantity={distortion.hd2}
            assumed={assumed}
          />
        ) : null}
        {distortion.hd3 ? (
          <DistortionFormula
            symbol="HD_{3}"
            quantity={distortion.hd3}
            assumed={assumed}
          />
        ) : null}
        {distortion.iip3 ? (
          <DistortionFormula
            symbol="IIP_{3}"
            quantity={distortion.iip3}
            assumed={assumed}
          />
        ) : null}
      </details>
      {varies || assumed ? (
        <table
          className="small-signal-values"
          aria-label="Distortion by frequency"
        >
          {assumed ? <caption>Full model</caption> : null}
          <thead>
            <tr>
              <th />
              <th scope="col">HD2</th>
              <th scope="col">HD3</th>
            </tr>
          </thead>
          <tbody>
            {distortion.vsFreq.map((point) => (
              <tr key={point.f}>
                <th scope="row">{formatEngineering(point.f, "Hz")}</th>
                <td>{hdText(point.hd2, point.hd2Infinite)}</td>
                <td>{hdText(point.hd3, point.hd3Infinite)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {distortion.taylor.length ? (
        <details className="small-signal-exact">
          <summary>Device coefficients</summary>
          <table
            className="small-signal-values"
            aria-label="Device coefficients"
          >
            <tbody>
              {distortion.taylor.map((term) => {
                const label = taylorLatex(term);
                return (
                  <tr
                    key={`${term.element} ${term.current} ${term.monomial}`}
                    className={term.kept ? undefined : "small-signal-muted"}
                  >
                    <th scope="row">
                      <Formula latex={label} />
                    </th>
                    <td>
                      {formatEngineering(
                        term.value,
                        `A/V${term.order === 2 ? "²" : term.order === 3 ? "³" : `^${term.order}`}`,
                      )}
                    </td>
                    <td>
                      {term.ignored
                        ? "neglected"
                        : term.kept
                          ? ""
                          : "not in the equations"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </details>
      ) : null}
    </>
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
  assumed,
}: {
  noise: SmallSignalNoise;
  current: boolean;
  band: string;
  onBand: (text: string) => void;
  /** Under assumptions the closed form is the assumed model's; the numbers
   * stay the full model's. */
  assumed: boolean;
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
  // From every source: the contributor lists stop at the 32 largest.
  const flicker = noise.sources.some((source) => source.kind === "flicker");
  const sources = noise.contributors[0];
  const integrated = noise.integrated;
  // Sources an assumption leaves out of the closed form, by row label.
  const neglected = new Set(
    noise.sources
      .filter((source) => source.ignored)
      .map((source) => noiseLabel(source)),
  );

  return (
    <>
      {low ? (
        // LeadFormula says "too large to typeset" when no form fits.
        <LeadFormula
          symbol={symbol}
          shown={display}
          shownIsExact={displayIsExact}
          simpler={simpler}
          simplerNote={
            simpler?.assumption
              ? `assuming ${simpler.assumption}`
              : `within ${formatPercent(simpler?.relError ?? 0)} of exact`
          }
          exact={displayIsExact ? (display?.latex ?? null) : exactLatex}
          assumed={assumed}
        />
      ) : null}
      {low && flicker ? (
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
              sources.omitted ? sources.omitted.fraction : 0,
            ).map((row) => (
              <tr key={row.label}>
                <th scope="row">{row.label}</th>
                <td>
                  {row.fraction === null ? "∞" : formatPercent(row.fraction)}
                </td>
                {neglected.size ? (
                  <td className="small-signal-muted">
                    {neglected.has(row.label) ? "neglected" : ""}
                  </td>
                ) : null}
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
 * the equations use (current, g_m, r_o, a triode channel's R_on in its
 * place; r_π too when there are BJTs). A MOSFET with a region imposed shows
 * that region's g_m and r_o, marked assumed, with the bias's region.
 */
function BiasTable({
  devices,
  regions,
}: {
  devices: Array<[string, DeviceOperatingPoint]>;
  regions?: readonly RegionReport[] | undefined;
}) {
  interface Row {
    name: string;
    region: string;
    /** Imposed: the bias's own region, which `region` replaces. */
    bias?: string;
    current: number;
    gm: number;
    ro: number;
    /** A MOSFET in triode: its r_o is the channel's R_on, which the column
     * header names and the region says. */
    ron?: boolean;
    rpi: number | null;
  }
  const rows = devices.flatMap(([name, device]): Row[] => {
    if (device.type === "nmos" || device.type === "pmos") {
      const m = device as MosOperatingPoint;
      const imposed = regions?.find(
        (r) => r.element === name && r.effect === "imposed",
      )?.linearized;
      const assumed = regions?.find((r) => r.element === name)?.assumed;
      if (imposed && assumed)
        return [
          {
            name,
            region: assumed,
            bias: m.region,
            current: Math.abs(m.id),
            gm: imposed.gm,
            ro: imposed.gds > 0 ? 1 / imposed.gds : Infinity,
            ron: assumed === "triode",
            rpi: null,
          },
        ];
      return [
        {
          name,
          region: m.region,
          current: Math.abs(m.id),
          gm: m.gm,
          ro: m.gds > 0 ? 1 / m.gds : Infinity,
          ron: m.region === "triode",
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
    (row) =>
      row.bias !== undefined ||
      (row.region !== "saturation" && row.region !== "active"),
  );
  const ohms = (value: number) =>
    Number.isFinite(value) ? formatEngineering(value, "Ω") : "∞";
  const regionPill = (row: Row) => (
    <span
      className={`small-signal-region is-${row.region}${row.bias === undefined ? "" : " is-assumed"}`}
      title={row.bias === undefined ? undefined : `assumed, bias ${row.bias}`}
    >
      {row.region}
    </span>
  );
  return (
    <table className="small-signal-bias-table">
      <thead>
        <tr>
          <th scope="col" />
          {showRegion ? <th scope="col" data-col="region" /> : null}
          <th scope="col">I</th>
          <th scope="col">
            g<sub>m</sub>
          </th>
          <th scope="col">
            r<sub>o</sub>
            {rows.some((row) => row.ron) ? (
              <>
                , R<sub>on</sub>
              </>
            ) : null}
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
            <th scope="row">
              {row.name}
              {showRegion ? (
                // At phone width the region sits under the name instead.
                // Only one of the two copies is displayed at a time, and the
                // other is display: none, so each width has one for
                // assistive technology.
                <span className="small-signal-bias-inline">
                  {regionPill(row)}
                </span>
              ) : null}
            </th>
            {showRegion ? (
              <td data-quantity="region" data-col="region">
                {regionPill(row)}
                {row.bias === undefined ? null : (
                  <small className="small-signal-bias-region">
                    assumed, bias {row.bias}
                  </small>
                )}
              </td>
            ) : null}
            <td data-quantity="id">{formatEngineering(row.current, "A")}</td>
            <td data-quantity="gm">{formatEngineering(row.gm, "S")}</td>
            <td data-quantity={row.ron ? "ron" : "ro"}>{ohms(row.ro)}</td>
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

/** Junction leakage (r_bs, r_bd, r_μ) shares one column. */
const LEAKAGE_TERMS: ReadonlySet<string> = new Set(["rbs", "rbd", "rmu"]);
/** Device capacitances share one column, each its own choice in it. */
const CAP_TERMS: readonly AssumptionTerm[] = [
  "cgs",
  "cgd",
  "cgb",
  "cbd",
  "cbs",
  "cpi",
  "cmu",
  "ccs",
];
/** Known columns first, in hand-analysis order; any others follow. */
const COLUMN_ORDER = ["ro", "gmb", "rpi", "leakage", "caps"];

function termColumn(term: string): string {
  if (LEAKAGE_TERMS.has(term)) return "leakage";
  return (CAP_TERMS as readonly string[]).includes(term) ? "caps" : term;
}

/** C_gs, C_db, C_π: a capacitance term as the equations write it. */
const CAP_SUB: Record<string, string> = {
  cgs: "gs",
  cgd: "gd",
  cgb: "gb",
  cbd: "db",
  cbs: "sb",
  cpi: "π",
  cmu: "μ",
  ccs: "cs",
};

function CapSymbol({ term }: { term: string }) {
  return (
    <span>
      C<sub>{CAP_SUB[term] ?? term.slice(1)}</sub>
    </span>
  );
}

/** A column's symbol as the bias table writes it: r_o, g_mb, r_π, C_gs. */
function ColumnSymbol({ column }: { column: string }) {
  if (column === "leakage") return <>Leakage</>;
  if (column === "caps") return <>Caps</>;
  const [head = "", ...rest] = column;
  return (
    <>
      {head === "c" ? "C" : head}
      <sub>{rest.join("").replace("pi", "π").replace("mu", "μ")}</sub>
    </>
  );
}

interface AssumptionMember {
  name: string;
  type: AssumableType;
  /** `partKey` of its instance path, the key its choices are stored under. */
  path: string;
  /** Set for a part drawn in the open Cell itself (selectable there). */
  instanceId: string | null;
  terms: readonly AssumptionTerm[];
  /** Capacitances a Miller split can take (null: a capacitor's own). */
  miller: readonly MillerTerm[];
}

export interface AssumptionRow {
  key: string;
  label: string;
  type: AssumableType;
  /** A whole type (its defaults), a matched group, or one part. */
  scope: "type" | "group" | "part";
  members: AssumptionMember[];
}

const byName = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true });

interface AssumptionChoices {
  defaults: AssumptionDefaults;
  parts: CircuitAssumptions;
}

/**
 * The table's rows: each transistor type present ("All NMOS"), then its
 * matched groups and other parts, then passives and diodes. A matched
 * group is one row only while its members make the same choices, as the
 * solver matches them; otherwise each member is its own row.
 */
export function assumptionRows(
  assumable: readonly AssumableElement[],
  elements: readonly SmallSignalElement[],
  groups: readonly (readonly string[])[],
  { defaults, parts }: AssumptionChoices,
): AssumptionRow[] {
  const drawn = new Map(elements.map((element) => [element.name, element]));
  const members = new Map<string, AssumptionMember>();
  for (const { element, type, terms, miller } of assumable) {
    const part = drawn.get(element);
    // Metadata from a solve of another drawing never describes this part.
    if (!part || part.kind !== type) continue;
    const instancePath = part.instancePath;
    members.set(element, {
      name: element,
      type,
      path: partKey(instancePath),
      instanceId: instancePath.length === 1 ? (instancePath[0] ?? null) : null,
      terms,
      miller: miller ?? [],
    });
  }
  const all = [...members.values()];
  const rows: AssumptionRow[] = [];
  for (const type of TRANSISTOR_TYPES) {
    const ofType = all.filter((member) => member.type === type);
    if (!ofType.length) continue;
    rows.push({
      key: type,
      label: `All ${MODEL_TITLE[type]}`,
      type,
      scope: "type",
      members: ofType,
    });
    const grouped = new Set<string>();
    const units: AssumptionMember[][] = [];
    for (const group of groups) {
      const found = group
        .map((name) => members.get(name))
        .filter((member) => member?.type === type) as AssumptionMember[];
      if (
        found.length < 2 ||
        found.length !== group.length ||
        found.some((member) => grouped.has(member.name)) ||
        !sameChoices(
          type,
          found.map((member) => member.path),
          defaults,
          parts,
        )
      )
        continue;
      found.sort((a, b) => byName(a.name, b.name));
      units.push(found);
      for (const member of found) grouped.add(member.name);
    }
    for (const member of ofType)
      if (!grouped.has(member.name)) units.push([member]);
    units.sort((a, b) => byName(a[0]?.name ?? "", b[0]?.name ?? ""));
    for (const unit of units)
      rows.push({
        key: unit.map((member) => member.name).join("="),
        label: unit.map((member) => member.name).join(" = "),
        type,
        scope: unit.length > 1 ? "group" : "part",
        members: unit,
      });
  }
  for (const member of all
    .filter((member) => !isTransistor(member.type))
    .sort((a, b) => byName(a.name, b.name)))
    rows.push({
      key: member.name,
      label: member.name,
      type: member.type,
      scope: "part",
      members: [member],
    });
  return rows;
}

/** One column per transistor term the circuit has, leakage combined. */
export function assumptionColumns(rows: readonly AssumptionRow[]): string[] {
  const columns: string[] = [];
  for (const row of rows)
    if (isTransistor(row.type))
      for (const member of row.members)
        for (const term of member.terms) {
          const column = termColumn(term);
          if (!columns.includes(column)) columns.push(column);
        }
  const rank = (column: string) => {
    const known = COLUMN_ORDER.indexOf(column);
    return known < 0 ? COLUMN_ORDER.length : known;
  };
  // Stable: unknown columns keep the order the solver lists them in.
  return columns.sort((a, b) => rank(a) - rank(b));
}

interface AssumptionChange {
  defaults?: AssumptionDefaults;
  parts?: CircuitAssumptions;
}

/**
 * A row's column checked or cleared. A type row sets the default for every
 * term of the column the type accepts, not only the ones this circuit's
 * parts have: the default holds in every circuit.
 */
export function assumptionColumnChange(
  row: AssumptionRow,
  column: string,
  on: boolean,
  { defaults, parts }: AssumptionChoices,
  /** One term of the column alone (a capacitance in the Caps cell). */
  only?: AssumptionTerm,
): AssumptionChange {
  const inColumn = (terms: readonly AssumptionTerm[]) =>
    terms.filter(
      (term) => termColumn(term) === column && (!only || term === only),
    );
  if (row.scope === "type" && isTransistor(row.type))
    return withDefault(
      defaults,
      parts,
      row.type,
      inColumn(ASSUMPTION_TERMS[row.type]),
      on,
      row.members.map((member) => member.path),
    );
  let next = parts;
  for (const member of row.members)
    next = withTerms(
      next,
      member.path,
      row.type,
      inColumn(member.terms),
      on,
      defaults,
    );
  return { parts: next };
}

/**
 * A passive's open, short or Miller choice (none: ""), replacing the
 * others; as the table's select and the device menu set it.
 */
export function passiveChange(
  parts: CircuitAssumptions,
  path: string,
  type: AssumableType,
  choice: PassiveChoice,
  defaults: AssumptionDefaults,
): CircuitAssumptions {
  const cleared = withMiller(
    withTerms(parts, path, type, ["open", "short"], false, defaults),
    path,
    null,
    false,
  );
  if (choice === "miller") return withMiller(cleared, path, null, true);
  return choice
    ? withTerms(cleared, path, type, [choice], true, defaults)
    : cleared;
}

/** A passive's current choice: Miller, open, short or none. */
function passiveValue(
  member: AssumptionMember,
  { defaults, parts }: AssumptionChoices,
): PassiveChoice {
  const part = parts[member.path];
  if (member.miller.includes(null) && isMiller(null, part)) return "miller";
  if (isIgnored(member.type, "open", part, defaults)) return "open";
  if (isIgnored(member.type, "short", part, defaults)) return "short";
  return "";
}

/** Device menus: transistors, capacitors and diodes. */
export function hasDeviceMenu(type: string): boolean {
  return isTransistor(type) || type === "capacitor" || type === "diode";
}

/**
 * The device menu of a table row (a part, or a matched group with its
 * shared choices): every term the solver lists for it, leakage as one, a
 * Miller split where offered, a passive's open or short, a MOSFET's region.
 */
export function deviceMenuModel(
  row: AssumptionRow,
  clicked: string,
  choices: AssumptionChoices,
): DeviceMenuModel {
  const { defaults, parts } = choices;
  const members = row.members;
  const tally = (flags: boolean[]) => {
    const on = flags.filter(Boolean).length;
    return {
      on: on > 0 && on === flags.length,
      mixed: on > 0 && on < flags.length,
    };
  };
  const defaulted = (term: AssumptionTerm) =>
    isTransistor(row.type) &&
    (defaults[row.type]?.includes(term) ?? false) &&
    members.every((member) => parts[member.path]?.ignore?.[term] === undefined);
  const neglect: MenuToggle[] = [];
  const passive = !isTransistor(row.type);
  for (const term of ASSUMPTION_TERMS[row.type]) {
    if (term === "open" || term === "short") continue;
    const having = members.filter((member) => member.terms.includes(term));
    if (!having.length) continue;
    const id = LEAKAGE_TERMS.has(term) ? "leakage" : term;
    if (neglect.some((item) => item.id === id)) continue;
    const terms =
      id === "leakage"
        ? ASSUMPTION_TERMS[row.type].filter((t) => LEAKAGE_TERMS.has(t))
        : [term];
    const flags = members.flatMap((member) =>
      member.terms
        .filter((t) => terms.includes(t))
        .map((t) => isIgnored(row.type, t, parts[member.path], defaults)),
    );
    neglect.push({
      id,
      ...tally(flags),
      inherited: terms.every(defaulted) && flags.every(Boolean),
    });
  }
  const order = (id: string) => {
    const at = MENU_ORDER.indexOf(id);
    return at < 0 ? MENU_ORDER.length : at;
  };
  neglect.sort((a, b) => order(a.id) - order(b.id));
  const miller = isTransistor(row.type)
    ? MILLER_TERMS.filter((term) =>
        members.every((member) => member.miller.includes(term)),
      ).map((term) => ({
        term,
        ...tally(members.map((member) => isMiller(term, parts[member.path]))),
      }))
    : [];
  const first = members[0];
  const regions = members.map((member) => parts[member.path]?.region ?? "");
  return {
    label: row.label,
    typeLabel: TYPE_LABEL[row.type] ?? row.type,
    matchedWith: members
      .map((member) => member.name)
      .filter((name) => name !== clicked && members.length > 1),
    defaultsLabel: isTransistor(row.type)
      ? `All ${MODEL_TITLE[row.type]}`
      : null,
    neglect,
    miller,
    passive:
      passive && first
        ? {
            value: passiveValue(first, choices),
            options: [
              "",
              "open",
              "short",
              ...(first.miller.includes(null) ? (["miller"] as const) : []),
            ],
          }
        : null,
    region: takesRegion(row.type)
      ? regions.every((region) => region === regions[0])
        ? (regions[0] ?? "")
        : ""
      : null,
  };
}

/** Terms in hand-analysis order in the device menu. */
const MENU_ORDER = [
  "ro",
  "gmb",
  "rpi",
  "leakage",
  "cgs",
  "cgd",
  "cgb",
  "cbd",
  "cbs",
  "cpi",
  "cmu",
  "ccs",
  "cj",
];

const TYPE_LABEL: Record<string, string> = {
  ...MODEL_TITLE,
  capacitor: "Capacitor",
  resistor: "Resistor",
  inductor: "Inductor",
  "voltage-source": "Voltage source",
  "current-source": "Current source",
  vcvs: "VCVS",
  vccs: "VCCS",
  cccs: "CCCS",
  ccvs: "CCVS",
};

/** A part with values and no assumptions: a resistor, a source. */
export function valuesOnlyModel(
  element: string,
  kind: string | undefined,
): DeviceMenuModel {
  return {
    label: element,
    typeLabel: kind ? (TYPE_LABEL[kind] ?? kind) : "",
    matchedWith: [],
    defaultsLabel: null,
    neglect: [],
    miller: [],
    passive: null,
    region: null,
  };
}

const NO_STATUS: DeviceMenuStatus = { bias: null, notes: [], cost: null };

const NO_ASSUMPTION_ACTIONS: Omit<DeviceMenuActions, "field" | "more"> = {
  toggle: () => undefined,
  miller: () => undefined,
  passive: () => undefined,
  region: () => undefined,
};

/** "assumed saturated" / "assumed in triode": a card's region note. */
export function regionNote(
  regions: readonly RegionReport[] | undefined,
): string | null {
  const imposed = (regions ?? []).filter(
    (r) => r.effect === "imposed" && r.actual !== null,
  );
  const group = (region: string, text: string) => {
    const names = imposed
      .filter((r) => r.assumed === region)
      .map((r) => r.element);
    return names.length ? `${names.join(", ")} assumed ${text}` : null;
  };
  const notes = [
    group("saturation", "saturated"),
    group("triode", "in triode"),
  ].filter(Boolean);
  return notes.length ? notes.join(". ") : null;
}

/**
 * A part's canvas badge, when anything is assumed for it: its region,
 * else its passive choice, else "≈"; null with nothing in effect.
 */
export function deviceBadge(
  member: AssumptionMember,
  choices: AssumptionChoices,
  report: RegionReport | undefined,
): CanvasBadge | null {
  if (member.instanceId === null || !hasDeviceMenu(member.type)) return null;
  const { defaults, parts } = choices;
  const part = parts[member.path];
  const neglected = member.terms.filter(
    (term) =>
      term !== "open" &&
      term !== "short" &&
      isIgnored(member.type, term, part, defaults),
  );
  const splits = member.miller.filter(
    (term) => term !== null && isMiller(term, part),
  );
  const passive = isTransistor(member.type)
    ? ""
    : passiveValue(member, choices);
  const region = takesRegion(member.type) ? (part?.region ?? "") : "";
  if (!neglected.length && !splits.length && !passive && !region) return null;
  const said: string[] = [];
  if (region) said.push(`${region} assumed`);
  if (passive === "miller") said.push("Miller split");
  else if (passive) said.push(passive);
  if (neglected.length)
    said.push(`${neglected.map(termText).join(", ")} neglected`);
  for (const term of splits) said.push(`Miller ${termText(term ?? "")}`);
  return {
    instanceId: member.instanceId,
    element: member.name,
    text: region
      ? region === "saturation"
        ? "sat"
        : "triode"
      : passive === "miller"
        ? "Miller"
        : passive || "≈",
    description: `${member.name}: ${said.join(", ")}`,
    warn:
      report?.effect === "refused" ||
      (report?.effect === "imposed" && report.actual !== null),
  };
}

/** The last answer, only for the circuit (Cell) it answered. */
export function resultForCircuit<T>(
  last: { circuit: string; result: T } | null,
  circuit: string,
): T | null {
  return last?.circuit === circuit ? last.result : null;
}

/**
 * Per-device assumptions: checked terms are neglected, a passive is taken
 * open or shorted, and a MOSFET's region is imposed on its bias. A type row
 * sets the default for every circuit; a matched group's members share one
 * setting. The overview of what each part's device menu sets.
 */
function AssumptionTable({
  rows,
  defaults,
  parts,
  selected,
  onChange,
  onSelect,
  onOpenMenu,
}: {
  /** A row's name pressed: its part's device menu (keyboard: focused). */
  onOpenMenu?:
    ((row: AssumptionRow, fromKeyboard: boolean) => void) | undefined;
  rows: readonly AssumptionRow[];
  defaults: AssumptionDefaults;
  parts: CircuitAssumptions;
  /** Instance ids selected on the canvas. */
  selected: ReadonlySet<string>;
  onChange(change: AssumptionChange): void;
  onSelect?: ((instanceIds: string[]) => void) | undefined;
}) {
  const tableRef = useRef<HTMLTableElement>(null);
  const columns = assumptionColumns(rows);
  const transistors = rows.some((row) => isTransistor(row.type));
  const regionColumn = rows.some((row) => takesRegion(row.type));
  const isSelected = (row: AssumptionRow) =>
    row.scope !== "type" &&
    row.members.some(
      (member) => member.instanceId !== null && selected.has(member.instanceId),
    );
  const selectedRows = rows
    .filter(isSelected)
    .map((row) => row.key)
    .join(" ");
  useEffect(() => {
    if (selectedRows)
      tableRef.current
        ?.querySelector("tr.is-selected")
        ?.scrollIntoView({ block: "nearest" });
  }, [selectedRows]);

  const setTerms = (
    row: AssumptionRow,
    column: string,
    on: boolean,
    only?: AssumptionTerm,
  ) =>
    onChange(
      assumptionColumnChange(row, column, on, { defaults, parts }, only),
    );

  /** Each capacitance the row's devices have, neglected or not, and C_gd
   * or C_μ split by Miller where it bridges two signal nodes: a popover of
   * checkboxes, the summary naming the choices. */
  const capsCell = (row: AssumptionRow) => {
    const tally = (flags: boolean[]) => {
      const on = flags.filter(Boolean).length;
      return {
        checked: flags.length > 0 && on === flags.length,
        mixed: on > 0 && on < flags.length,
      };
    };
    const state = CAP_TERMS.flatMap((term) => {
      const having = row.members.filter((member) =>
        member.terms.includes(term),
      );
      if (!having.length) return [];
      // A type row sets defaults: a split is a part's own choice.
      const splittable =
        row.scope !== "type" &&
        MILLER_TERMS.includes(term) &&
        having.every((member) => member.miller.includes(term));
      return [
        {
          term,
          ...tally(
            having.map((member) =>
              isIgnored(row.type, term, parts[member.path], defaults),
            ),
          ),
          miller: splittable
            ? tally(having.map((member) => isMiller(term, parts[member.path])))
            : null,
        },
      ];
    });
    if (!state.length)
      return (
        <td key="caps" className="small-signal-muted">
          —
        </td>
      );
    const chosen = state.filter(
      (cap) => cap.checked || cap.mixed || cap.miller?.checked,
    );
    const setMiller = (term: AssumptionTerm, on: boolean) =>
      onChange({
        parts: row.members.reduce(
          (next, member) => withMiller(next, member.path, term, on),
          parts,
        ),
      });
    return (
      <td key="caps">
        <details className="small-signal-caps">
          <summary aria-label={`${row.label} caps`}>
            {chosen.length
              ? chosen.map((cap, i) => (
                  <span key={cap.term}>
                    {i ? " " : ""}
                    {cap.miller?.checked ? "Miller " : ""}
                    <CapSymbol term={cap.term} />
                  </span>
                ))
              : "none"}
          </summary>
          <div>
            {state.map((cap) => (
              <div key={cap.term} className="small-signal-cap-choice">
                <label>
                  <input
                    type="checkbox"
                    aria-label={`${row.label} ${cap.term}`}
                    checked={cap.checked}
                    ref={(input) => {
                      if (input) input.indeterminate = cap.mixed;
                    }}
                    onChange={() =>
                      setTerms(row, "caps", !cap.checked, cap.term)
                    }
                  />
                  <CapSymbol term={cap.term} />
                </label>
                {cap.miller ? (
                  <label>
                    <input
                      type="checkbox"
                      aria-label={`${row.label} ${cap.term} Miller`}
                      checked={cap.miller.checked}
                      ref={(input) => {
                        if (input)
                          input.indeterminate = cap.miller?.mixed ?? false;
                      }}
                      onChange={() => setMiller(cap.term, !cap.miller?.checked)}
                    />
                    Miller
                  </label>
                ) : null}
              </div>
            ))}
          </div>
        </details>
      </td>
    );
  };

  const termCell = (row: AssumptionRow, column: string) => {
    if (column === "caps") return capsCell(row);
    const pairs = row.members.flatMap((member) =>
      member.terms
        .filter((term) => termColumn(term) === column)
        .map((term) => isIgnored(row.type, term, parts[member.path], defaults)),
    );
    if (!pairs.length)
      return (
        <td key={column} className="small-signal-muted">
          —
        </td>
      );
    const on = pairs.filter(Boolean).length;
    const checked = on === pairs.length;
    return (
      <td key={column}>
        <input
          type="checkbox"
          aria-label={`${row.label} ${column}`}
          checked={checked}
          ref={(input) => {
            if (input) input.indeterminate = on > 0 && !checked;
          }}
          onChange={() => setTerms(row, column, !checked)}
        />
      </td>
    );
  };

  const regionCell = (row: AssumptionRow) => {
    if (row.scope === "type" || !takesRegion(row.type)) return <td />;
    const regions = row.members.map(
      (member) => parts[member.path]?.region ?? "",
    );
    const value = regions.every((region) => region === regions[0])
      ? (regions[0] ?? "")
      : "";
    return (
      <td>
        <select
          aria-label={`${row.label} region`}
          value={value}
          onChange={(event) =>
            onChange({
              parts: withRegion(
                parts,
                row.members.map((member) => member.path),
                (event.currentTarget.value || null) as RegionChoice | null,
              ),
            })
          }
        >
          <option value="">auto</option>
          <option value="saturation">saturation</option>
          <option value="triode">triode</option>
        </select>
      </td>
    );
  };

  const passiveCell = (row: AssumptionRow) => {
    const member = row.members[0];
    if (!member) return null;
    // A capacitor between two signal nodes can be split by Miller instead.
    const splittable = row.type === "capacitor" && member.miller.includes(null);
    const value = passiveValue(member, { defaults, parts });
    return (
      <td colSpan={Math.max(columns.length, 1)}>
        <select
          aria-label={`${row.label} open or short`}
          value={value}
          onChange={(event) =>
            onChange({
              parts: passiveChange(
                parts,
                member.path,
                row.type,
                event.currentTarget.value as PassiveChoice,
                defaults,
              ),
            })
          }
        >
          <option value="" />
          {member.terms
            .filter((term) => term === "open" || term === "short")
            .map((term) => (
              <option key={term} value={term}>
                {term}
              </option>
            ))}
          {splittable ? <option value="miller">Miller</option> : null}
        </select>
      </td>
    );
  };

  return (
    <table className="small-signal-assumptions" ref={tableRef}>
      {columns.length ? (
        <thead>
          <tr>
            <td className="small-signal-muted">Neglect</td>
            {columns.map((column) => (
              <th key={column} scope="col">
                <ColumnSymbol column={column} />
              </th>
            ))}
            {regionColumn ? <th scope="col">Region</th> : null}
          </tr>
        </thead>
      ) : null}
      <tbody>
        {rows.map((row) => {
          const ids = row.members.map((member) => member.instanceId);
          const selectable =
            onSelect && row.scope !== "type" && ids.every(Boolean);
          return (
            <tr
              key={row.key}
              data-row={row.key}
              className={
                [
                  row.scope === "type" ? "is-type" : "",
                  isSelected(row) ? "is-selected" : "",
                ]
                  .filter(Boolean)
                  .join(" ") || undefined
              }
            >
              <th scope="row">
                {selectable ? (
                  <button
                    type="button"
                    title="Select in the drawing"
                    aria-haspopup={
                      onOpenMenu && hasDeviceMenu(row.type)
                        ? "dialog"
                        : undefined
                    }
                    onClick={(event) => {
                      onSelect(ids as string[]);
                      if (hasDeviceMenu(row.type))
                        onOpenMenu?.(row, event.detail === 0);
                    }}
                  >
                    {row.label}
                  </button>
                ) : (
                  row.label
                )}
              </th>
              {isTransistor(row.type) ? (
                <>
                  {columns.map((column) => termCell(row, column))}
                  {regionColumn ? regionCell(row) : null}
                </>
              ) : (
                <>
                  {passiveCell(row)}
                  {transistors && regionColumn ? <td /> : null}
                </>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** A deviation as a percentage, with a digit for small ones: "0.004%". */
export function formatDeviation(fraction: number): string {
  const percent = fraction * 100;
  if (percent === 0) return "0%";
  if (percent < 0.001) return "<0.001%";
  if (percent < 0.1) return `${percent.toPrecision(1)}%`;
  return formatPercent(fraction);
}

/** Who a suggestion covers: "M5", "M1 = M2", "all PMOS". */
export function suggestionTarget(item: SmallSignalSuggestion): string {
  if (item.scope === "type")
    return `all ${isTransistor(item.type) ? MODEL_TITLE[item.type] : item.type}`;
  return item.elements.join(" = ");
}

/** Plain text of a suggestion, for labels: "ro M5", "R5 open". */
export function suggestionText(item: SmallSignalSuggestion): string {
  return isTransistor(item.type)
    ? `${item.term} ${suggestionTarget(item)}`
    : `${suggestionTarget(item)} ${item.term}`;
}

/** `parts` with every suggestion's term neglected on each of its parts. */
export function withSuggestions(
  parts: CircuitAssumptions,
  items: readonly SmallSignalSuggestion[],
  elements: readonly SmallSignalElement[],
  defaults: AssumptionDefaults,
): CircuitAssumptions {
  const paths = new Map(
    elements.map((element) => [element.name, partKey(element.instancePath)]),
  );
  let next = parts;
  for (const item of items)
    for (const name of item.elements) {
      const path = paths.get(name);
      if (path)
        next = withTerms(next, path, item.type, [item.term], true, defaults);
    }
  return next;
}

/** A suggestions threshold typed in percent; null unless above 0. */
export function suggestionThreshold(text: string): number | null {
  const percent = parseSpiceNumber(text.trim() ? text : "1");
  return percent !== null && percent > 0 ? percent / 100 : null;
}

const SUGGEST_LABEL: Record<SuggestQuantity, string> = {
  gain: "Gain",
  rin: "Zin",
  rout: "Zout",
};

/**
 * Further assumptions within the threshold of the full model, smallest
 * first: Alone with the current assumptions, Together with every kept row
 * above it.
 */
function SuggestionTable({
  suggestions,
  onApply,
}: {
  suggestions: SmallSignalSuggestions;
  onApply(items: SmallSignalSuggestion[]): void;
}) {
  const kept = suggestions.items.filter((item) => item.cumulative !== null);
  const capped =
    suggestions.capped === null
      ? null
      : `Checked ${suggestions.evaluated} of ${suggestions.candidates}.`;
  if (!suggestions.items.length)
    return (
      <p className="small-signal-muted">
        Nothing within {formatDeviation(suggestions.threshold)}.
        {capped ? ` ${capped}` : ""}
      </p>
    );
  return (
    <>
      <div className="small-signal-suggestions-scroll">
        <table className="small-signal-assumptions small-signal-suggestion-table">
          <thead>
            <tr>
              <th scope="col">Term</th>
              <th scope="col">Alone</th>
              <th scope="col">Together</th>
              <td />
            </tr>
          </thead>
          <tbody>
            {suggestions.items.map((item) => {
              const text = suggestionText(item);
              return (
                <tr
                  key={`${item.scope}:${item.term}:${item.elements.join()}`}
                  className={item.cumulative === null ? undefined : "is-kept"}
                >
                  <th scope="row">
                    {isTransistor(item.type) ? (
                      <>
                        <ColumnSymbol column={item.term} />{" "}
                        {suggestionTarget(item)}
                      </>
                    ) : (
                      text
                    )}
                  </th>
                  <td>{formatDeviation(item.alone)}</td>
                  <td>
                    {item.cumulative === null
                      ? "—"
                      : formatDeviation(item.cumulative)}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="small-signal-reset"
                      aria-label={`Apply ${text}`}
                      onClick={() => onApply([item])}
                    >
                      Apply
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="small-signal-suggestions-footer">
        {kept.length ? (
          <button
            type="button"
            className="small-signal-reset"
            onClick={() => onApply(kept)}
          >
            Apply all
          </button>
        ) : null}
        {suggestions.combined !== null && kept.length ? (
          <small className="small-signal-muted">
            {formatDeviation(suggestions.combined)} from full model
          </small>
        ) : null}
        {capped ? <small className="small-signal-muted">{capped}</small> : null}
      </div>
    </>
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

/** One DC value the bias point is solved from. */
export interface BiasSetting {
  /** "Vin", a Pin's name, or the rails "VDD, VSS". */
  label: string;
  /** The value as written; empty when unknown. */
  value: string;
  unit: "V" | "A";
  role: "input" | "supply" | null;
  /** Shown, not set here (a rail held at 0 V). */
  readOnly?: boolean;
  /** Writes the value; false when it is not one. */
  commit(text: string): boolean;
}

/**
 * Where the bias point comes from: every source's DC value (the input's
 * too: the signal rides on it), each undriven Pin's, and the rails'.
 */
export function BiasSettings({ settings }: { settings: BiasSetting[] }) {
  return (
    <div
      className="small-signal-device-menu-fields small-signal-bias-settings"
      role="group"
      aria-label="DC values"
    >
      <small className="small-signal-muted">Set by these DC values</small>
      {settings.map((setting) => (
        <ValueField
          key={setting.label}
          field={{
            name: setting.label,
            label:
              setting.role === "input"
                ? `${setting.label} (input)`
                : setting.label,
            unit: setting.unit,
            value: setting.value,
            placeholder: "?",
            required: true,
          }}
          readOnly={setting.readOnly}
          label={`${setting.label} DC`}
          onCommit={setting.commit}
        />
      ))}
    </div>
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

export const OP_STORAGE_KEY = "smallsignal.biasOnDrawing";

function loadOpShown(): boolean {
  try {
    return window.localStorage.getItem(OP_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function saveOpShown(shown: boolean) {
  try {
    window.localStorage.setItem(OP_STORAGE_KEY, shown ? "1" : "0");
  } catch {
    // As for the models.
  }
}

/** A transistor's region as the drawing labels it. */
const REGION_SHORT: Record<string, [string, string]> = {
  saturation: ["sat", "saturation"],
  triode: ["triode", "triode"],
  cutoff: ["off", "cutoff"],
  "forward-active": ["active", "active"],
  "reverse-active": ["reverse", "triode"],
};

/**
 * The operating point as the drawing shows it: each node's DC voltage on
 * its wires in the open Cell (ground and the supplies aside), and each
 * transistor drawn there with its region.
 */
export function operatingPointLabels(
  op: NonNullable<SmallSignalResult["op"]>,
  netlist: SmallSignalNetlist,
  document: CircuitProject["documents"][number] | undefined,
): { devices: OpDeviceLabel[]; nets: OpNetLabel[] } {
  const devices: OpDeviceLabel[] = [];
  for (const element of netlist.elements) {
    const device = op.devices[element.name];
    const id = element.instancePath[0];
    if (!device || !id || element.instancePath.length !== 1) continue;
    if (!("region" in device)) continue;
    const [region, tone] = REGION_SHORT[device.region] ?? [
      device.region,
      device.region,
    ];
    // A saturated BJT is out of its amplifying region, as triode is.
    const bjt = device.type === "npn" || device.type === "pnp";
    devices.push({
      instanceId: id,
      element: element.name,
      region,
      tone: bjt && device.region === "saturation" ? "triode" : tone,
    });
  }
  const routes = new Map<string, string[]>();
  for (const net of document?.nets ?? []) {
    const node = net.terminals
      .map(
        (terminal) =>
          netlist.terminals[terminal.instanceId]?.[terminal.pinName],
      )
      .find(Boolean);
    // Every rail the drawing marks, whatever drives it.
    if (!node || node === "0" || netlist.rails.includes(node)) continue;
    const wires = (document?.routes ?? [])
      .filter((route) => route.netId === net.id)
      .map((route) => route.id);
    if (wires.length) routes.set(node, [...(routes.get(node) ?? []), ...wires]);
  }
  const nets = [...routes].flatMap(([node, wires]) => {
    const voltage = op.nodes[node];
    return voltage === undefined
      ? []
      : [{ node, text: formatEngineering(voltage, "V"), routes: wires }];
  });
  return { devices, nets };
}

/** The canvas side of the formula link: a part hovered on the drawing
 * marks its symbols (all of a placed Cell's parts for the Cell). */
function useCanvasHover(
  link: LinkStore,
  symbols: ReadonlyMap<string, readonly string[]>,
  elements: readonly SmallSignalElement[] | undefined,
) {
  useEffect(() => {
    const onOver = (event: PointerEvent) => {
      const target = event.target as Element | null;
      const hit = target?.closest?.(
        '[data-testid="schematic-canvas"] [data-canvas-hit-kind="instance"]',
      );
      const id = hit?.getAttribute("data-canvas-hit-id");
      if (!id) {
        if (link.get()?.source === "canvas") link.set(null);
        return;
      }
      const names = (elements ?? [])
        .filter((element) => element.instancePath[0] === id)
        .map((element) => element.name);
      const marked = elementSymbols(symbols, names);
      link.set(
        names.length
          ? { source: "canvas", elements: names, symbols: marked }
          : null,
      );
    };
    document.addEventListener("pointerover", onOver);
    return () => {
      document.removeEventListener("pointerover", onOver);
      if (link.get()?.source === "canvas") link.set(null);
    };
  }, [link, symbols, elements]);
}

/** The hovered symbols' highlight in every formula of the panel. */
function SymbolHighlight({ link }: { link: LinkStore }) {
  const state = useSyncExternalStore(link.subscribe, link.get, () => null);
  const css = symbolHighlightCss(".small-signal-panel", state?.symbols ?? []);
  return css ? <style data-small-signal-highlight>{css}</style> : null;
}

export const GUIDE_STORAGE_KEY = "smallsignal.guideDismissed";

function loadGuideDismissed(): boolean {
  try {
    return window.localStorage.getItem(GUIDE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function saveGuideDismissed(dismissed: boolean) {
  try {
    if (dismissed) window.localStorage.setItem(GUIDE_STORAGE_KEY, "1");
    else window.localStorage.removeItem(GUIDE_STORAGE_KEY);
  } catch {
    // As for the models.
  }
}

/** Library examples that analyze as drawn (the others need bias values
 * or sit in triode), as the guide offers them. */
export const GUIDE_EXAMPLES = [
  { id: "five-transistor-ota-sky130", label: "5T OTA" },
] as const;

/** How to use the panel, in five steps with the controls' own names. */
function Guide({
  onClose,
  onOpenExample,
}: {
  /** Absent on the empty state, where the guide is the content. */
  onClose?: (() => void) | undefined;
  onOpenExample?: ((id: string) => void) | undefined;
}) {
  return (
    <section
      className="small-signal-guide"
      aria-label="How to use"
      data-testid="small-signal-guide"
    >
      <header>
        <strong>How to use</strong>
        {onClose ? (
          <button
            type="button"
            className="small-signal-device-menu-close"
            aria-label="Close guide"
            onClick={onClose}
          >
            ×
          </button>
        ) : null}
      </header>
      <ol>
        <li>Draw a circuit, or place an example.</li>
        <li>
          Pick <b>Input</b> and <b>Output</b>.
        </li>
        <li>
          Read <b>Gain</b>, <b>Zin</b> and <b>Zout</b>, exact and ≈.
        </li>
        <li>Click a part on the drawing to change its value or assumptions.</li>
        <li>
          Open <b>Suggestions</b> for assumptions within 1%. Point at a plot to
          read it.
        </li>
      </ol>
      <p className="small-signal-muted">
        ≈ is a simpler form within 5%. &ldquo;% from full model&rdquo; is what
        your assumptions cost.
      </p>
      {onOpenExample ? (
        <p className="small-signal-guide-examples">
          Place an example:{" "}
          {GUIDE_EXAMPLES.map((example, index) => (
            <span key={example.id}>
              {index ? ", " : ""}
              <button
                type="button"
                className="small-signal-link-button"
                onClick={() => onOpenExample(example.id)}
              >
                {example.label}
              </button>
            </span>
          ))}
        </p>
      ) : null}
    </section>
  );
}

const DIFF_PREFIX = "diff:";
const NO_ASSUMPTIONS: CircuitAssumptions = {};

/** Symbolic small-signal analysis of the open Cell, solved in a worker. */
export function SmallSignalPanel({
  project,
  rootDocumentId,
  selectedInstanceIds,
  onSelectInstances,
  instanceClick,
  onOpenExample,
  onSetParameters,
  onInspect,
}: {
  project: CircuitProject;
  rootDocumentId?: string;
  /** Instances selected on the canvas (in the open Cell). */
  selectedInstanceIds?: readonly string[];
  /** Select instances of the open Cell on the canvas. */
  onSelectInstances?: (instanceIds: string[]) => void;
  /** The last plain click on a part of the open Cell: opens its menu. A
   * double-click (`open`) on a part with none opens Properties instead. */
  instanceClick?: {
    instanceId: string;
    nonce: number;
    open?: boolean;
  } | null;
  /** Open a Library example by id (the guide's examples). */
  onOpenExample?: (id: string) => void;
  /** Write a part's values (of the open Cell) to the drawing. */
  onSetParameters?: (
    instanceId: string,
    edit: { set?: Record<string, string>; unset?: string[] },
  ) => boolean;
  /** A part's full Properties. */
  onInspect?: (instanceId: string) => void;
}) {
  // The guide: the empty state, and until a viewer first closes it.
  const [guideOpen, setGuideOpen] = useState(() => !loadGuideDismissed());
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
  // How the ≈ forms are made, kept across sessions.
  const [approx, setApprox] = useState<SmallSignalApprox>(loadApprox);
  useEffect(() => saveApprox(approx), [approx]);
  // Assumptions: defaults per transistor type for every circuit, and each
  // circuit's own choices, both kept across sessions.
  const [assumptionDefaults, setAssumptionDefaults] =
    useState<AssumptionDefaults>(loadDefaults);
  const [storedAssumptions, setStoredAssumptions] = useState(loadCircuits);
  const assumptionKey = circuitStorageKey(project.id, rootDocumentId ?? "");
  const assumptionParts =
    storedAssumptions[assumptionKey]?.parts ?? NO_ASSUMPTIONS;
  useEffect(() => saveDefaults(assumptionDefaults), [assumptionDefaults]);
  useEffect(() => saveCircuits(storedAssumptions), [storedAssumptions]);
  useEffect(() => {
    // Opening a circuit keeps its choices from being the next evicted.
    setStoredAssumptions((stored) =>
      touchCircuit(stored, assumptionKey, Date.now()),
    );
  }, [assumptionKey]);
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
  const updateAssumptions = ({ defaults, parts }: AssumptionChange) => {
    if (defaults) setAssumptionDefaults(defaults);
    if (parts) {
      // Parts no longer drawn are forgotten with the next change.
      const drawn = new Set(
        (netlist?.elements ?? []).map((element) =>
          partKey(element.instancePath),
        ),
      );
      setStoredAssumptions((stored) =>
        storeCircuit(stored, assumptionKey, parts, Date.now(), drawn),
      );
    }
  };
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
  // The request the response answers: a queued solve can still deliver an
  // older circuit's result after the circuit changed.
  const [responseKey, setResponseKey] = useState<string | null>(null);
  // The latest answer that was not an error, with the circuit it answered:
  // the Assumptions table keeps its rows while a choice the solver refuses
  // is on screen, but never shows another Cell's.
  const [lastResult, setLastResult] = useState<{
    circuit: string;
    result: SmallSignalResult;
  } | null>(null);
  // Miller splits the circuit's last answer no longer offers are not sent
  // (the request is keyed by its text, so this re-solves at most once).
  const offered = resultForCircuit(lastResult, assumptionKey)?.assumable;
  const assume = useMemo(
    () =>
      netlist
        ? assumptionRequest(
            netlist.elements,
            assumptionDefaults,
            assumptionParts,
            offered,
          )
        : null,
    [netlist, assumptionDefaults, assumptionParts, offered],
  );
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
  // Distortion likewise has its own worker, so stopping one never stops
  // the other.
  const distortionClientRef = useRef<SmallSignalClient | null>(null);
  const distortionBusy = useRef(false);
  // A noise solve was sent and its job is still the current one.
  const noiseBusy = useRef(false);
  const noiseGeneration = useRef(0);
  // Distortion likewise: devices left linear (all expand by default) and
  // the input amplitude for HD2, HD3.
  const [distortionOpen, setDistortionOpen] = useState(false);
  // Devices left linear, per circuit (cell): another cell's M1 is another
  // device, expanded by default.
  const [linearByCircuit, setLinearByCircuit] = useState<
    Readonly<Record<string, readonly string[]>>
  >({});
  const circuitKey = rootDocumentId ?? "";
  const linearDevices = new Set(linearByCircuit[circuitKey] ?? []);
  const setLinearDevices = (
    update: (previous: ReadonlySet<string>) => ReadonlySet<string>,
  ) =>
    setLinearByCircuit((all) => ({
      ...all,
      [circuitKey]: [...update(new Set(all[circuitKey] ?? []))],
    }));
  // Typed amplitude per input unit: "10m" for a voltage input must never
  // become 10 mA when the input is a current source.
  const [amplitudeByUnit, setAmplitudeByUnit] = useState<
    Readonly<Record<"V" | "A", string>>
  >({ V: "", A: "" });
  const [distortionResponse, setDistortionResponse] =
    useState<SmallSignalResponse | null>(null);
  // The job the distortion response answers: shown only while it is the
  // current one, so a new amplitude never sits beside old numbers.
  const [distortionResponseKey, setDistortionResponseKey] = useState<
    string | null
  >(null);
  const distortionGeneration = useRef(0);
  // Suggestions likewise have their own worker, only while open.
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestQuantity, setSuggestQuantity] =
    useState<SuggestQuantity>("gain");
  const [suggestThresholdText, setSuggestThresholdText] = useState("");
  const [suggestResponse, setSuggestResponse] =
    useState<SmallSignalResponse | null>(null);
  const [suggestResponseKey, setSuggestResponseKey] = useState<string | null>(
    null,
  );
  const suggestClientRef = useRef<SmallSignalClient | null>(null);
  const suggestBusy = useRef(false);
  const suggestGeneration = useRef(0);

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
      distortionClientRef.current?.dispose();
      distortionClientRef.current = null;
      suggestClientRef.current?.dispose();
      suggestClientRef.current = null;
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
          // Named assumptions are the solver's default.
          ...(approx === "terms" && !handAnalysis
            ? { approx: "terms" as const }
            : {}),
          // In the key, so Noise and Distortion send it and a response to
          // other assumptions is never taken for this one.
          ...(assume ? { assume } : {}),
        }
      : null;
  // The circuit too: two Cells can draw the same netlist text.
  const requestKey =
    netlist && request
      ? JSON.stringify([netlist.text, request, assumptionKey])
      : null;

  useEffect(() => {
    if (!requestKey) {
      setResponse(null);
      return;
    }
    // The key is the whole job: the netlist text and every request field.
    const [text, job, circuit] = JSON.parse(requestKey) as [
      string,
      SmallSignalRequest,
      string,
    ];
    const current = ++generation.current;
    const timer = setTimeout(() => {
      const client = clientRef.current;
      if (!client) return;
      setSolving(true);
      // The main solve also sweeps gain, Zin and Zout for their plots.
      void client.analyze(text, { ...job, sweep: {} }).then((next) => {
        if (current !== generation.current) return;
        setResponse(next);
        setResponseKey(requestKey);
        if (!isSmallSignalError(next)) setLastResult({ circuit, result: next });
        setSolving(false);
      });
    }, SOLVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // requestKey covers the netlist text and every request field.
  }, [requestKey]);

  // The main solve found the exact forms over the term budget: the Noise
  // and Distortion solves, which show neither, skip them at once.
  const overBudget = Boolean(
    response &&
    !isSmallSignalError(response) &&
    responseKey === requestKey &&
    response.gain?.skipped,
  );
  const numericOnly = (over: boolean) => (over ? { maxTerms: 1 } : {});
  const band = noiseBandRange(noiseBand);
  const noiseKey = noiseJobKey(
    noiseOpen,
    requestKey,
    responseKey,
    band,
    overBudget,
  );
  useEffect(() => {
    // A new job, or none: drop the old result and any solve in flight, so
    // the section never shows numbers for a different circuit or band.
    const current = ++noiseGeneration.current;
    setNoiseResponse(null);
    if (!noiseKey) return;
    const [key, range, over] = JSON.parse(noiseKey) as [
      string,
      [number, number] | null,
      boolean,
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
          ...numericOnly(over),
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

  // Every transistor and diode with a bias point can be expanded.
  // Devices from the response to this very request, never an older one.
  const nonlinearCandidates = Object.keys(
    response && !isSmallSignalError(response) && responseKey === requestKey
      ? (response.op?.devices ?? {})
      : {},
  );
  const nonlinear = nonlinearCandidates.filter(
    (name) => !linearDevices.has(name),
  );
  const currentInput =
    sources.find(
      (source) =>
        source.name === (differential ? differential[0] : chosenInput),
    )?.kind === "current";
  const defaultAmplitude = currentInput ? 1e-6 : 0.01;
  const amplitudeUnit = currentInput ? "A" : "V";
  const amplitudeText = amplitudeByUnit[amplitudeUnit];
  const typedAmplitude = parseSpiceNumber(amplitudeText);
  // Blank means the default; anything else must be a positive number, or
  // nothing is solved (never numbers for an amplitude other than the shown).
  const amplitude = !amplitudeText.trim()
    ? defaultAmplitude
    : typedAmplitude !== null && typedAmplitude > 0
      ? typedAmplitude
      : null;
  const distortionKey =
    distortionOpen &&
    requestKey &&
    !handAnalysis &&
    nonlinear.length &&
    amplitude !== null
      ? JSON.stringify([requestKey, nonlinear, amplitude, overBudget])
      : null;
  useEffect(() => {
    // A new job, or none: drop the old result and any solve in flight.
    const current = ++distortionGeneration.current;
    setDistortionResponse(null);
    if (!distortionKey) return;
    const [key, devices, size, over] = JSON.parse(distortionKey) as [
      string,
      string[],
      number,
      boolean,
    ];
    const [text, job] = JSON.parse(key) as [string, SmallSignalRequest];
    const timer = setTimeout(() => {
      distortionClientRef.current ??= createSmallSignalClient();
      distortionBusy.current = true;
      void distortionClientRef.current
        .analyze(text, {
          ...job,
          nonlinear: devices,
          order: 3,
          amplitude: size,
          ...numericOnly(over),
        })
        .then((next) => {
          if (current !== distortionGeneration.current) return;
          distortionBusy.current = false;
          setDistortionResponse(next);
          setDistortionResponseKey(distortionKey);
        });
    }, SOLVE_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      // As for Noise: stop a solve whose job is no longer wanted.
      if (distortionBusy.current) {
        distortionClientRef.current?.dispose();
        distortionClientRef.current = null;
        distortionBusy.current = false;
      }
    };
  }, [distortionKey]);

  // Suggestions need numbers only: the solve skips the exact forms.
  const suggestThreshold = suggestionThreshold(suggestThresholdText);
  const suggestKey =
    suggestOpen && requestKey && !handAnalysis && suggestThreshold !== null
      ? JSON.stringify([requestKey, suggestQuantity, suggestThreshold])
      : null;
  useEffect(() => {
    // A new job, or none: drop the old result and any solve in flight.
    const current = ++suggestGeneration.current;
    setSuggestResponse(null);
    if (!suggestKey) return;
    const [key, quantity, threshold] = JSON.parse(suggestKey) as [
      string,
      SuggestQuantity,
      number,
    ];
    const [text, job] = JSON.parse(key) as [string, SmallSignalRequest];
    const timer = setTimeout(() => {
      suggestClientRef.current ??= createSmallSignalClient();
      suggestBusy.current = true;
      void suggestClientRef.current
        .analyze(text, {
          ...job,
          suggest: { quantity, threshold },
          maxTerms: 1,
        })
        .then((next) => {
          if (current !== suggestGeneration.current) return;
          suggestBusy.current = false;
          setSuggestResponse(next);
          setSuggestResponseKey(suggestKey);
        });
    }, SOLVE_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      // As for Noise: stop a solve whose job is no longer wanted.
      if (suggestBusy.current) {
        suggestClientRef.current?.dispose();
        suggestClientRef.current = null;
        suggestBusy.current = false;
      }
    };
  }, [suggestKey]);

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
  const firstWithoutFormula = (["gain", "rin", "rout"] as const).find(
    (key) => result?.[key] && !result[key].exact,
  );
  const allGood =
    result &&
    !result.warnings?.length &&
    devices.every(([, device]) =>
      ["saturation", "forward-active"].includes(
        "region" in device ? device.region : "",
      ),
    );
  const solved = resultForCircuit(lastResult, assumptionKey);
  const assumptionTableRows = netlist
    ? assumptionRows(
        solved?.assumable ?? [],
        netlist.elements,
        (solved?.matchCandidates ?? [])
          .filter(
            (candidate) => candidate.kind === "device" && candidate.applied,
          )
          .map((candidate) => candidate.elements),
        { defaults: assumptionDefaults, parts: assumptionParts },
      )
    : [];
  const assumptionsStored =
    Object.keys(assumptionDefaults).length > 0 ||
    Object.keys(assumptionParts).length > 0;
  // The forms are the assumed model's only once something was applied.
  const assumedOn = anyAssumed(result?.assumptions);
  const assumedOf = (quantity: SmallSignalQuantity) =>
    assumedOn ? quantity.assumed : undefined;
  const assumptionChoices = {
    defaults: assumptionDefaults,
    parts: assumptionParts,
  };

  // The device menu: a plain click on a part, its badge, or its name in the
  // table opens it. It reads and writes the table's own choices.
  const [menu, setMenu] = useState<{
    instanceId: string;
    element: string;
    keyboard: boolean;
  } | null>(null);
  const menuRows = useRef(assumptionTableRows);
  menuRows.current = assumptionTableRows;
  const menuOpener = useRef<HTMLElement | null>(null);
  const menuElements = useRef(netlist?.elements);
  menuElements.current = netlist?.elements;
  const openMenu = useCallback((instanceId: string, keyboard: boolean) => {
    // A part with assumptions, else any drawn part the netlist reads.
    const name =
      menuRows.current
        .filter((row) => row.scope !== "type" && hasDeviceMenu(row.type))
        .flatMap((row) => row.members)
        .find((candidate) => candidate.instanceId === instanceId)?.name ??
      menuElements.current?.find(
        (element) =>
          element.instancePath.length === 1 &&
          element.instancePath[0] === instanceId,
      )?.name;
    menuOpener.current = keyboard
      ? (document.activeElement as HTMLElement | null)
      : null;
    setMenu(name ? { instanceId, element: name, keyboard } : null);
    return name !== undefined;
  }, []);
  const onInspectRef = useRef(onInspect);
  onInspectRef.current = onInspect;
  const seenClick = useRef(instanceClick?.nonce ?? 0);
  useEffect(() => {
    if (!instanceClick || instanceClick.nonce === seenClick.current) return;
    seenClick.current = instanceClick.nonce;
    if (!openMenu(instanceClick.instanceId, false) && instanceClick.open)
      onInspectRef.current?.(instanceClick.instanceId);
  }, [instanceClick, openMenu]);
  const menuId = useRef<string | null>(null);
  menuId.current = menu?.instanceId ?? null;
  const menuAnchor = useCallback(() => {
    const id = menuId.current;
    return id ? (instanceHit(id)?.getBoundingClientRect() ?? null) : null;
  }, []);
  const canvasBounds = useCallback(
    () =>
      document
        .querySelector('[data-testid="schematic-canvas"]')
        ?.getBoundingClientRect() ?? null,
    [],
  );
  const closeMenu = useCallback((restoreFocus: boolean) => {
    setMenu(null);
    if (restoreFocus) menuOpener.current?.focus();
    menuOpener.current = null;
  }, []);
  const menuRow = menu
    ? assumptionTableRows.find(
        (row) =>
          row.scope !== "type" &&
          row.members.some((member) => member.name === menu.element),
      )
    : undefined;
  const regionReports = result?.assumptions?.regions;
  const deviceStatus = (row: AssumptionRow): DeviceMenuStatus => {
    const names = row.members.map((member) => member.name);
    const device = result?.op?.devices?.[names[0] ?? ""];
    const bias =
      device && "region" in device
        ? device.region === "forward-active"
          ? "active"
          : device.region
        : null;
    const gainCost = assumedOn
      ? fullModelText(
          result?.gain?.exact?.fullModelError ??
            result?.gain?.assumed?.maxRelError,
        )
      : null;
    return {
      bias,
      notes: (result?.warnings ?? []).filter(
        (warning) =>
          names.some((name) => warning.startsWith(`${name} `)) &&
          !names.some((name) => warning === `${name} is in ${bias ?? ""}`),
      ),
      cost: gainCost ? `Gain ${gainCost}` : null,
    };
  };
  const menuFields = menu
    ? partFields(project, rootDocumentId, menu.instanceId)
    : [];
  const valueActions = (instanceId: string) => ({
    field: (field: PartField, text: string) => {
      const edit = fieldEdit(
        field,
        text,
        (value) =>
          // W and L as the netlist reads them: a bare number is microns.
          parseSpiceNumber(value) !== null,
      );
      return edit !== null && (onSetParameters?.(instanceId, edit) ?? false);
    },
    more: onInspect ? () => onInspect(instanceId) : undefined,
  });
  // Every DC value the bias point is solved from, editable where it is.
  const topLevel = (name: string) =>
    netlist?.elements.find(
      (element) => element.name === name && element.instancePath.length === 1,
    )?.instancePath[0];
  const inputOrder = differential
    ? differential
    : chosenInput
      ? [chosenInput]
      : [];
  const inputNames = new Set(inputOrder);
  // The input first (+ before −), then the rest as drawn.
  const rank = (name: string) =>
    inputNames.has(name) ? inputOrder.indexOf(name) : inputOrder.length;
  const biasSettings: BiasSetting[] = [...sources]
    .sort((a, b) => rank(a.name) - rank(b.name))
    .map((source) => {
      const unit = source.kind === "voltage" ? "V" : "A";
      const role = inputNames.has(source.name) ? "input" : null;
      if (source.pin) {
        const pin = source.pin;
        return {
          label: pin,
          value: pinBiasText[pin] ?? "",
          unit,
          role,
          commit: (text) => {
            // Empty: the Pin's bias is unknown again (hand analysis).
            if (text.trim() && parseSpiceNumber(text) === null) return false;
            setPinBiasText((previous) => {
              const { [pin]: _cleared, ...rest } = previous;
              return text.trim() ? { ...rest, [pin]: text.trim() } : rest;
            });
            return true;
          },
        };
      }
      const value = unknownBias.includes(source.name) ? "" : source.dc;
      const id = topLevel(source.name);
      return {
        label: source.name,
        value,
        unit,
        role,
        commit: (text) => {
          if (!id) return false;
          const edit = fieldEdit(
            {
              name: "dc",
              label: "DC",
              unit,
              value,
              placeholder: "",
              required: true,
            },
            text,
            (typed) => parseSpiceNumber(typed) !== null,
          );
          return edit !== null && (onSetParameters?.(id, edit) ?? false);
        },
      };
    });
  // Rails at the supply voltage share its one value; a ground-like rail
  // (VSS, GND) is held at 0 V and says so.
  const supplies = netlist?.supplies ?? [];
  const grounded = supplies.filter(
    (rail) => netlist?.supplyVolts[rail] === 0 && supplyVoltage !== 0,
  );
  const raised = supplies.filter((rail) => !grounded.includes(rail));
  if (raised.length)
    biasSettings.push({
      label: raised.join(", "),
      value: supply,
      unit: "V",
      role: "supply",
      commit: (text) => {
        const volts = parseSpiceNumber(text);
        if (volts === null || volts < 0) return false;
        setSupply(text.trim());
        return true;
      },
    });
  if (grounded.length)
    biasSettings.push({
      label: grounded.join(", "),
      value: "0",
      unit: "V",
      role: "supply",
      readOnly: true,
      commit: () => false,
    });
  // Called where it goes, after the toggle's state is declared.
  const biasCard = () =>
    biasSettings.length || (result && devices.length) ? (
      <section className="small-signal-card" aria-label="Bias point">
        <header>
          <span>Bias point</span>
          {result && devices.length ? (
            <label className="small-signal-check small-signal-op-toggle">
              <input
                type="checkbox"
                checked={opShown}
                onChange={(event) => setOpShown(event.currentTarget.checked)}
              />
              Show on drawing
            </label>
          ) : null}
        </header>
        {biasSettings.length ? <BiasSettings settings={biasSettings} /> : null}
        {result && devices.length ? (
          <BiasTable devices={devices} regions={regionReports} />
        ) : null}
      </section>
    ) : null;
  const menuActions = (
    row: AssumptionRow,
  ): Omit<DeviceMenuActions, "field" | "more"> => ({
    toggle: (item) => {
      const column = item.id === "leakage" ? "leakage" : termColumn(item.id);
      updateAssumptions(
        assumptionColumnChange(
          row,
          column,
          item.mixed || !item.on,
          assumptionChoices,
          column === "caps" ? (item.id as AssumptionTerm) : undefined,
        ),
      );
    },
    miller: (term, on) =>
      updateAssumptions({
        parts: row.members.reduce(
          (next, member) => withMiller(next, member.path, term, on),
          assumptionParts,
        ),
      }),
    passive: (choice) => {
      const member = row.members[0];
      if (member)
        updateAssumptions({
          parts: passiveChange(
            assumptionParts,
            member.path,
            row.type,
            choice,
            assumptionDefaults,
          ),
        });
    },
    region: (region) =>
      updateAssumptions({
        parts: withRegion(
          assumptionParts,
          row.members.map((member) => member.path),
          region || null,
        ),
      }),
  });
  // A badge on every drawn part with something assumed.
  const badges: CanvasBadge[] = assumptionTableRows
    .filter((row) => row.scope !== "type")
    .flatMap((row) => row.members)
    .flatMap((member) => {
      const badge = deviceBadge(
        member,
        assumptionChoices,
        regionReports?.find((r) => r.element === member.name),
      );
      return badge ? [badge] : [];
    });

  // Formula ↔ drawing: what is hovered, in a store only the highlights read.
  const [link] = useState<LinkStore>(createLinkStore);
  const symbols = useMemo(
    () => symbolElements(result?.params),
    [result?.params],
  );
  // The drawn part (in the open Cell) each element is, or sits inside.
  const instanceOf = useMemo(
    () =>
      new Map(
        (netlist?.elements ?? []).flatMap((element) =>
          element.instancePath[0]
            ? [[element.name, element.instancePath[0]] as const]
            : [],
        ),
      ),
    [netlist?.elements],
  );
  const panelRef = useRef<HTMLElement>(null);
  useCanvasHover(link, symbols, netlist?.elements);
  const onPanelPointer = (event: ReactPointerEvent<HTMLElement>) => {
    const target = event.target as Element;
    const formula = target.closest?.(".small-signal-formula");
    const latex = formula
      ? (symbolAt(target, symbols, formula) ??
        symbolAtPoint(formula, event.clientX, event.clientY, symbols))
      : null;
    if (latex) {
      link.set({
        source: "formula",
        elements: symbols.get(latex) ?? [],
        symbols: [latex],
      });
      return;
    }
    const row = target.closest?.("[data-device]");
    const device = row?.getAttribute("data-device");
    if (device) {
      link.set({
        source: "table",
        elements: [device],
        symbols: elementSymbols(symbols, [device]),
      });
      return;
    }
    if (link.get()?.source !== "canvas") link.set(null);
  };

  // The operating point on the drawing: node voltages on their wires and
  // each transistor's region, while the panel is open.
  const [opShown, setOpShown] = useState(loadOpShown);
  useEffect(() => saveOpShown(opShown), [opShown]);
  const op =
    opShown && result?.op && netlist
      ? operatingPointLabels(
          result.op,
          netlist,
          project.documents.find(
            (d) => d.id === (rootDocumentId ?? project.topDocumentId),
          ),
        )
      : null;

  // Nothing drawn: the guide is the whole panel. Parts but no source to
  // drive: the guide under Input and Output.
  const blank = !netlist?.elements.length;
  const empty = blank || !sources.length;
  const guide =
    empty || guideOpen ? (
      <Guide
        onClose={
          empty
            ? undefined
            : () => {
                setGuideOpen(false);
                saveGuideDismissed(true);
              }
        }
        // Placing an example adds it to the drawing: only on an empty one.
        onOpenExample={blank ? onOpenExample : undefined}
      />
    ) : null;

  return (
    <StaleBuildContext.Provider value={markStale}>
      <SymbolHighlight link={link} />
      <section
        ref={panelRef}
        className="small-signal-panel"
        aria-label="Small-signal analysis"
        data-testid="small-signal-panel"
        onPointerOver={onPanelPointer}
        onPointerMove={(event) => {
          // Between a symbol's strokes the pointer is over the formula
          // itself: the symbol is found by its box.
          if ((event.target as Element).closest?.(".small-signal-formula"))
            onPanelPointer(event);
        }}
        onPointerLeave={() => {
          if (link.get()?.source !== "canvas") link.set(null);
        }}
        onCopy={(event) => {
          const selection = window.getSelection();
          if (!selection?.rangeCount) return;
          const text = copyWithTex(selection.getRangeAt(0).cloneContents());
          if (text === null) return;
          event.clipboardData.setData("text/plain", text);
          event.preventDefault();
        }}
      >
        <header className="small-signal-header">
          <h2>Small-Signal</h2>
          {solving ? (
            <span className="small-signal-muted" role="status">
              Solving…
            </span>
          ) : null}
          {empty ? null : (
            <button
              type="button"
              className="small-signal-help"
              aria-label="How to use"
              aria-expanded={guideOpen}
              title="How to use"
              onClick={() => {
                const next = !guideOpen;
                setGuideOpen(next);
                if (!next) saveGuideDismissed(true);
              }}
            >
              ?
            </button>
          )}
        </header>
        {empty ? null : guide}
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
        {blank || !netlist ? (
          guide
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
            {sources.length ? null : guide}

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
                {unknownBias.length ? (
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

            {/* Missing a bias value: its field leads, ahead of the forms. */}
            {unknownBias.length ? biasCard() : null}

            {result?.gain ? (
              <QuantityCard
                title="Gain"
                symbol={`\\frac{${outputLabel}}{${inputLabel}}`}
                quantity={result.gain}
                unit={inputSource?.kind === "current" ? "Ω" : ""}
                noFormulaNote={firstWithoutFormula === "gain"}
                assumed={assumedOf(result.gain)}
                miller={result.assumptions?.miller}
                regions={regionReports}
                sweep={result.sweep?.f}
              />
            ) : null}
            {result?.rin ? (
              <QuantityCard
                title="Input impedance"
                symbol="Z_{in}"
                quantity={result.rin}
                unit="Ω"
                noFormulaNote={firstWithoutFormula === "rin"}
                assumed={assumedOf(result.rin)}
                miller={result.assumptions?.miller}
                regions={regionReports}
                sweep={result.sweep?.f}
              />
            ) : null}
            {result?.rout ? (
              <QuantityCard
                title="Output impedance"
                symbol="Z_{out}"
                quantity={result.rout}
                unit="Ω"
                noFormulaNote={firstWithoutFormula === "rout"}
                assumed={assumedOf(result.rout)}
                miller={result.assumptions?.miller}
                regions={regionReports}
                sweep={result.sweep?.f}
              />
            ) : null}

            {unknownBias.length ? null : biasCard()}

            {assumptionTableRows.length || assumptionsStored ? (
              <details className="small-signal-options small-signal-assumptions-section">
                <summary>{assume ? "Assumptions (on)" : "Assumptions"}</summary>
                <div>
                  <AssumptionTable
                    rows={assumptionTableRows}
                    defaults={assumptionDefaults}
                    parts={assumptionParts}
                    selected={new Set(selectedInstanceIds)}
                    onChange={updateAssumptions}
                    onSelect={onSelectInstances}
                    onOpenMenu={(row, keyboard) => {
                      const id = row.members[0]?.instanceId;
                      if (id) openMenu(id, keyboard);
                    }}
                  />
                  {assumptionsStored ? (
                    <button
                      type="button"
                      className="small-signal-reset"
                      onClick={() =>
                        updateAssumptions({ defaults: {}, parts: {} })
                      }
                    >
                      Reset
                    </button>
                  ) : null}
                </div>
              </details>
            ) : null}

            {result && assumptionTableRows.length ? (
              <details
                className="small-signal-options small-signal-suggestions"
                open={suggestOpen}
                onToggle={(event) => setSuggestOpen(event.currentTarget.open)}
              >
                <summary>Suggestions</summary>
                <div>
                  {handAnalysis ? (
                    <p className="small-signal-muted">
                      Suggestions need a bias point.
                    </p>
                  ) : (
                    <>
                      <div className="small-signal-suggestions-controls">
                        <label>
                          For
                          <select
                            aria-label="Suggestions for"
                            value={suggestQuantity}
                            onChange={(event) =>
                              setSuggestQuantity(
                                event.currentTarget.value as SuggestQuantity,
                              )
                            }
                          >
                            {(["gain", "rin", "rout"] as const)
                              .filter((key) => key === "gain" || result[key])
                              .map((key) => (
                                <option key={key} value={key}>
                                  {SUGGEST_LABEL[key]}
                                </option>
                              ))}
                          </select>
                        </label>
                        <label>
                          Within (%)
                          <input
                            aria-label="Suggestion threshold"
                            aria-invalid={
                              suggestThreshold === null ? true : undefined
                            }
                            placeholder="1"
                            inputMode="decimal"
                            value={suggestThresholdText}
                            onChange={(event) =>
                              setSuggestThresholdText(event.currentTarget.value)
                            }
                          />
                        </label>
                      </div>
                      {suggestThreshold === null ? (
                        <p className="small-signal-muted">
                          Enter a threshold above 0.
                        </p>
                      ) : !suggestResponse ||
                        suggestResponseKey !== suggestKey ? (
                        <span className="small-signal-formula-pending" />
                      ) : isSmallSignalError(suggestResponse) ? (
                        <p className="small-signal-muted">
                          {suggestResponse.error}
                        </p>
                      ) : suggestResponse.suggestions ? (
                        <SuggestionTable
                          suggestions={suggestResponse.suggestions}
                          onApply={(items) =>
                            updateAssumptions({
                              parts: withSuggestions(
                                assumptionParts,
                                items,
                                netlist.elements,
                                assumptionDefaults,
                              ),
                            })
                          }
                        />
                      ) : null}
                    </>
                  )}
                </div>
              </details>
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
                        assumed={Boolean(anyAssumed(noiseResponse.assumptions))}
                      />
                    </>
                  ) : null}
                </div>
              </details>
            ) : null}

            {result ? (
              <details
                className="small-signal-options small-signal-distortion"
                open={distortionOpen}
                onToggle={(event) =>
                  setDistortionOpen(event.currentTarget.open)
                }
              >
                <summary>Distortion</summary>
                <div>
                  {handAnalysis ? (
                    <p className="small-signal-muted">
                      Distortion needs a bias point.
                    </p>
                  ) : (
                    <>
                      <p className="small-signal-muted">
                        Each device is expanded about the bias point: the DC
                        values under Bias point. The input's sine rides on its
                        DC.
                      </p>
                      <div
                        className="small-signal-match"
                        role="group"
                        aria-label="Nonlinear devices"
                      >
                        <span>Nonlinear</span>
                        {nonlinearCandidates.map((name) => (
                          <button
                            key={name}
                            type="button"
                            aria-pressed={!linearDevices.has(name)}
                            onClick={() =>
                              setLinearDevices((previous) => {
                                const next = new Set(previous);
                                if (next.has(name)) next.delete(name);
                                else next.add(name);
                                return next;
                              })
                            }
                          >
                            {name}
                          </button>
                        ))}
                      </div>
                      <label>
                        Amplitude ({currentInput ? "A" : "V"})
                        <input
                          aria-label="Distortion amplitude"
                          aria-invalid={amplitude === null ? true : undefined}
                          placeholder={currentInput ? "1u" : "10m"}
                          value={amplitudeText}
                          autoCapitalize="off"
                          autoCorrect="off"
                          spellCheck={false}
                          onChange={(event) =>
                            setAmplitudeByUnit({
                              ...amplitudeByUnit,
                              [amplitudeUnit]: event.currentTarget.value,
                            })
                          }
                        />
                      </label>
                      {!nonlinear.length ? (
                        <p className="small-signal-muted">
                          Pick a device to expand.
                        </p>
                      ) : amplitude === null ? (
                        <p className="small-signal-muted">
                          Enter an amplitude above 0.
                        </p>
                      ) : !distortionResponse ||
                        distortionResponseKey !== distortionKey ? (
                        <span className="small-signal-formula-pending" />
                      ) : isSmallSignalError(distortionResponse) ? (
                        <p className="small-signal-muted">
                          {distortionResponse.error}
                        </p>
                      ) : distortionResponse.distortion ? (
                        <>
                          <ExtraWarnings
                            warnings={distortionResponse.warnings}
                            shown={result.warnings}
                          />
                          <DistortionDetails
                            distortion={distortionResponse.distortion}
                            current={currentInput}
                            assumed={Boolean(
                              anyAssumed(distortionResponse.assumptions),
                            )}
                          />
                        </>
                      ) : null}
                    </>
                  )}
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
                <label>
                  ≈ form
                  <select
                    aria-label="Approximation"
                    value={approx}
                    onChange={(event) =>
                      setApprox(event.currentTarget.value as SmallSignalApprox)
                    }
                  >
                    {(["named", "terms"] as const).map((method) => (
                      <option key={method} value={method}>
                        {APPROX_LABEL[method]}
                      </option>
                    ))}
                  </select>
                </label>
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
      <CanvasOverlay
        badges={badges}
        open={menu?.instanceId ?? null}
        onOpen={(badge, keyboard) => {
          onSelectInstances?.([badge.instanceId]);
          openMenu(badge.instanceId, keyboard);
        }}
        op={op}
        store={link}
        instanceOf={instanceOf}
      />
      {menu ? (
        <DeviceMenu
          key={menu.instanceId}
          model={
            menuRow
              ? deviceMenuModel(menuRow, menu.element, assumptionChoices)
              : valuesOnlyModel(
                  menu.element,
                  netlist?.elements.find(
                    (element) => element.name === menu.element,
                  )?.kind,
                )
          }
          part={menu.element}
          fields={menuFields}
          status={menuRow ? deviceStatus(menuRow) : NO_STATUS}
          actions={{
            ...(menuRow ? menuActions(menuRow) : NO_ASSUMPTION_ACTIONS),
            ...valueActions(menu.instanceId),
          }}
          anchor={menuAnchor}
          bounds={canvasBounds}
          focusOnOpen={menu.keyboard}
          onClose={closeMenu}
        />
      ) : null}
    </StaleBuildContext.Provider>
  );
}
