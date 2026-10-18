// The solver's JSON contract (crates/smallsignal-wasm `analyze`).

/**
 * A term taken to its limit: a device's r_o, g_mb, r_bs, r_bd, r_π or r_μ
 * neglected (r → ∞, g_mb → 0), a device capacitance taken to 0 (MOS
 * C_gs, C_gd, C_gb, C_sb, C_db; BJT C_π, C_μ, substrate C_cs; diode C_j),
 * or a passive or diode taken open or shorted.
 */
export type AssumptionTerm =
  | "ro"
  | "gmb"
  | "rbs"
  | "rbd"
  | "rpi"
  | "rmu"
  | "cgs"
  | "cgd"
  | "cgb"
  | "cbs"
  | "cbd"
  | "cpi"
  | "cmu"
  | "ccs"
  | "cj"
  | "open"
  | "short";

/**
 * A capacitance split by the Miller approximation: an explicit capacitor
 * (no term, or null), or a device's capacitance by its term (C_gd: "cgd").
 */
export interface MillerAssumption {
  element: string;
  term?: AssumptionTerm | null;
}

/** Per-device assumptions: terms neglected and regions expected. */
export interface SmallSignalAssumptions {
  ignore?: { element: string; term: AssumptionTerm }[];
  /** MOS saturation, triode, cutoff; BJT forward-active, saturation,
   * reverse-active, cutoff. Checked against the operating point only. */
  regions?: { element: string; region: string }[];
  /** Feedback capacitances split into C(1 − K) at a and C(K − 1)/K at b,
   * K = v_b(0)/v_a(0) under the gain's excitation. */
  miller?: MillerAssumption[];
}

export interface SmallSignalRequest {
  /** Name of the independent V or I source that drives the input. */
  input: string;
  /** Output node; `ref` is the reference node (ground when null). */
  output: string;
  ref?: string | null;
  freqs?: number[];
  rin?: boolean;
  rout?: boolean;
  /** Target max relative error of the simplified expressions (default 0.05). */
  tolerance?: number;
  /**
   * How numeric mode simplifies gain, Zin and Zout: the exact form under
   * named assumptions the numbers choose (default), or the smallest terms
   * dropped.
   */
  approx?: SmallSignalApprox;
  /** Symbolic only: no operating point or numbers. */
  symbolic?: boolean;
  /** Second input for a differential drive: input +½, inputNeg −½. */
  inputNeg?: string | null;
  /** With inputNeg: differential (v+ − v−) or common-mode drive. */
  mode?: "differential" | "common";
  /** Devices that share one set of symbols, e.g. [["M1", "M2"]]. */
  match?: string[][];
  /** Also match every candidate pair in this solve, except `unmatch`. */
  matchAuto?: boolean;
  unmatch?: string[][];
  /** Also compute noise: spectra, sources and the input-referred PSD. */
  noise?: boolean;
  /** Integrate the noise over [fLow, fHigh] in Hz (implies `noise`). */
  noiseBand?: [number, number];
  /** Devices whose currents are expanded to `order`: distortion. */
  nonlinear?: string[];
  order?: 2 | 3;
  /** Input amplitude for HD2, HD3 (V, or A for a current input). */
  amplitude?: number;
  /** Term budget of each exact polynomial (default 2,000,000); over it a
   * quantity is numeric only. */
  maxTerms?: number;
  /** Assumptions: the forms describe the assumed model, values stay the
   * full model's. */
  assume?: SmallSignalAssumptions;
  /** Further assumptions within `threshold` of the full model. */
  suggest?: SmallSignalSuggestRequest;
}

export type SmallSignalApprox = "named" | "terms";

/** An assumption a named simplified form makes, on one element or a
 * matched group. */
export interface NamedAssumption {
  elements: string[];
  term: AssumptionTerm;
  /** e.g. r_{o2} \to \infty; null without a symbol. */
  latex: string | null;
}

export type SuggestQuantity = "gain" | "rin" | "rout";

export interface SmallSignalSuggestRequest {
  /** rin and rout need `rin` and `rout` in the request. */
  quantity: SuggestQuantity;
  /** Largest deviation from the full model (default 0.01). */
  threshold?: number;
  /** Seconds before evaluation stops (default 20). */
  timeLimit?: number;
  /** Candidates evaluated at most (default 400). */
  maxCandidates?: number;
}

export interface ComplexPoint {
  f: number;
  /** null when the value is infinite (e.g. looking into a gate). */
  re: number | null;
  im: number | null;
  inf?: boolean;
}

/** A pole or zero, in Hz: s = 2π(re + j·im). */
export interface Root {
  re: number;
  im: number;
}

export interface SmallSignalExpression {
  num?: string | null;
  den?: string | null;
  /** null when the exact form is too large to typeset. */
  latex: string | null;
  /** Number of terms in numerator and denominator. */
  terms?: { num: number; den: number };
  /** Simplified forms only: worst relative error against the exact form. */
  maxRelError?: number;
  /** Simplified forms only: nothing was dropped, so it is exact. */
  same?: boolean;
  /** The approximation the simplified form makes: hand analysis
   * ("ro ≫ R, 1/gm"), or a named form's label ("r_o2 → ∞", "r_o → ∞ for
   * M2, M4 and g_mb → 0"; "_" starts a subscript). */
  assumption?: string;
  /** Numeric simplified forms only: how they were made (`approx`). */
  method?: SmallSignalApprox;
  /** Named forms: the assumptions made on top of the request's. */
  named?: NamedAssumption[];
  /** Named forms: named assumptions appear in the form, but no set within
   * the tolerance makes it simpler; the form is the exact one. */
  none?: boolean;
  /** Simplified forms only: the tolerance they were made within. */
  tolerance?: number;
  /** The plain sum-of-products form when `latex` uses ∥ notation. */
  latexExpanded?: string | null;
  /** Under assumptions: the worst relative distance of this form from the
   * full model over the check grid; null without numbers or unbounded. */
  fullModelError?: number | null;
}

/** An assumed model's root and the full model's it pairs with (in Hz). */
export interface RootPair {
  assumed: Root | null;
  full: Root | null;
  relError: number | null;
}

/** An assumption the solver put back for one quantity. */
export interface RestoredAssumption {
  element: string;
  term: AssumptionTerm;
  /** The symbol kept, e.g. r_{o1}; null for a short of an absent element. */
  latex: string | null;
}

/** A quantity of the assumed model, against the full one. */
export interface AssumedQuantity {
  values: ComplexPoint[];
  /** Per requested frequency: |assumed − full| / max(|full|, 1e-3·peak). */
  relError: (number | null)[];
  /** The worst over the check grid; null when unbounded or symbolic. */
  maxRelError: number | null;
  infinite?: boolean;
  /** The comparison's own accuracy (rounding of both sides). */
  resolution: number | null;
  /** Assumptions without which the quantity is unbounded at DC. */
  restored: RestoredAssumption[];
  poles: RootPair[];
  zeros: RootPair[];
}

export interface SmallSignalAssumptionReport {
  applied: { element: string; term: AssumptionTerm; latex: string }[];
  /** Asked for, but the full model has no such term (e.g. g_mb with the
   * body on the source). */
  absent: { element: string; term: AssumptionTerm }[];
  regions: { element: string; assumed: string; actual: string | null }[];
  /** The Miller splits made (a refused one is a warning instead). */
  miller: MillerReport[];
}

/** A Miller split: the forms are exact for the split model, over C and K. */
export interface MillerReport {
  element: string;
  /** Null for an explicit capacitor. */
  term: AssumptionTerm | null;
  /** The capacitance, e.g. C_{C} or C_{gd2}. */
  latex: string;
  /** Its K, e.g. K_{CC} or K_{gd2} (also in `params`). */
  symbol: string;
  /** K's value; null in symbolic mode. */
  k: number | null;
  /** K = v_b/v_a at s = 0 in closed form; null over the budget. */
  definition: { latex: string; num: string; den: string } | null;
}

/** An element that can take assumptions, with the terms its model has. */
export interface AssumableElement {
  element: string;
  type:
    | "nmos"
    | "pmos"
    | "npn"
    | "pnp"
    | "diode"
    | "resistor"
    | "capacitor"
    | "inductor";
  terms: AssumptionTerm[];
  /** Its capacitances between two signal nodes, which a Miller split can
   * take: the term, or null for a capacitor's own. */
  miller: (AssumptionTerm | null)[];
}

const MOS_TERMS: readonly AssumptionTerm[] = [
  "ro",
  "gmb",
  "rbs",
  "rbd",
  "cgs",
  "cgd",
  "cgb",
  "cbs",
  "cbd",
];
const BJT_TERMS: readonly AssumptionTerm[] = [
  "ro",
  "rpi",
  "rmu",
  "cpi",
  "cmu",
  "ccs",
];
const PASSIVE_TERMS: readonly AssumptionTerm[] = ["open", "short"];
const DIODE_TERMS: readonly AssumptionTerm[] = ["open", "short", "cj"];

/**
 * Every term each element type accepts (the solver's `assume::terms_for`);
 * `assumable` lists the ones a given element's model has.
 */
export const ASSUMPTION_TERMS: Readonly<
  Record<AssumableElement["type"], readonly AssumptionTerm[]>
> = {
  nmos: MOS_TERMS,
  pmos: MOS_TERMS,
  npn: BJT_TERMS,
  pnp: BJT_TERMS,
  diode: DIODE_TERMS,
  resistor: PASSIVE_TERMS,
  capacitor: PASSIVE_TERMS,
  inductor: PASSIVE_TERMS,
};

const MOS_REGIONS = ["saturation", "triode", "cutoff"] as const;
const BJT_REGIONS = [
  "forward-active",
  "saturation",
  "reverse-active",
  "cutoff",
] as const;

/** The regions an assumption can expect, per transistor type. */
export const ASSUMPTION_REGIONS = {
  nmos: MOS_REGIONS,
  pmos: MOS_REGIONS,
  npn: BJT_REGIONS,
  pnp: BJT_REGIONS,
} as const;

export interface SmallSignalQuantity {
  unit?: string;
  infinite?: boolean;
  /**
   * null when the exact form is over the term budget (`skipped` says so):
   * then display and simplified are null too, and values, poles and zeros
   * come from the numeric model.
   */
  exact: SmallSignalExpression | null;
  /** Why there is no exact form: "too large for the exact closed form". */
  skipped?: string;
  /**
   * The exact form without gmin-level junction leakage (r_bs, r_bd, r_μ),
   * with its measured error against the full model; `same` when there was
   * no leakage to drop.
   */
  display?: (SmallSignalExpression & { same?: boolean }) | null;
  /** Junction leakage changes a value by more than 1e-3: it stays shown. */
  leakageMatters?: boolean;
  simplified?: SmallSignalExpression | null;
  values?: ComplexPoint[];
  /** In Hz; empty in symbolic mode (no values). null when the numeric
   * model's roots were not found (a warning says so). */
  poles?: Root[] | null;
  zeros?: Root[] | null;
  /** Number of poles and zeros: the degree in s of the denominator and
   * numerator (also in symbolic mode). */
  poleCount?: number;
  zeroCount?: number;
  /** Symbolic against direct numeric solve (numeric mode); null when the
   * exact form is over budget. */
  check?: { ok: boolean; maxRelDiff: number } | null;
  /** Under assumptions: values, poles and zeros above stay the full
   * model's; exact, display and simplified are the assumed model's. */
  assumed?: AssumedQuantity;
}

export interface MosOperatingPoint {
  type: "nmos" | "pmos";
  region: string;
  id: number;
  vgs: number;
  vds: number;
  vbs: number;
  gm: number;
  gds: number;
  gmb: number;
  vth: number;
  vdsat: number;
  reversed: boolean;
  /** Capacitances at this bias (F), zeros included: Meyer plus overlap
   * gate capacitances and the bulk junctions (cbd: C_db, cbs: C_sb). */
  caps: MosCapacitances;
}

export interface MosCapacitances {
  cgs: number;
  cgd: number;
  cgb: number;
  cbd: number;
  cbs: number;
}

/** BJT capacitances (F): C_π, C_μ, the substrate's (to the collector, or the
 * base of a lateral device), and the transcapacitance C_x (TF with VAF or
 * VTF: C_x·s·v_bc from emitter to base). */
export interface BjtCapacitances {
  cpi: number;
  cmu: number;
  csub: number;
  cx: number;
}

export interface BjtOperatingPoint {
  type: "npn" | "pnp";
  region: string;
  gmu: number;
  ic: number;
  ib: number;
  vbe: number;
  vce: number;
  gm: number;
  gpi: number;
  go: number;
  caps: BjtCapacitances;
}

export interface DiodeOperatingPoint {
  type: "diode";
  id: number;
  vd: number;
  gd: number;
  /** CJO depletion plus TT·g_d (F). */
  caps: { cj: number };
}

export type DeviceOperatingPoint =
  MosOperatingPoint | BjtOperatingPoint | DiodeOperatingPoint;

export interface SmallSignalParam {
  name: string;
  latex: string;
  value: number;
  unit: string;
  element: string;
  /** All elements a merged (matched) symbol stands for. */
  elements?: string[];
}

export interface MatchCandidate {
  elements: string[];
  kind: "device" | "passive";
  /** Whether this solve matched them (matchAuto, minus unmatch). */
  applied?: boolean;
}

/** A PSD at one frequency, in the spectrum's unit (V²/Hz or A²/Hz). */
export interface NoisePoint {
  f: number;
  /** null where the PSD is not finite (flicker at 0 Hz, no gain). */
  v2: number | null;
}

export interface NoiseContribution {
  element: string;
  /** thermal, flicker, shot, shot_c (collector) or shot_b (base). */
  kind: string;
  /** Its share of the output PSD, in V²/Hz (null when not finite). */
  v2: number | null;
  fraction: number | null;
}

/** Plain-text numerator and denominator, for checking tools. */
export interface PlainFraction {
  num: string;
  den: string;
}

/** One closed form of the input-referred white (thermal + shot) PSD. */
export interface NoiseExpression {
  /** null when too large to typeset. */
  latex: string | null;
  /** null in hand analysis (no operating point). */
  value: number | null;
  /** Coefficients of 4kT and of 2q, when small enough to write out. */
  thermal?: PlainFraction | null;
  shot?: PlainFraction | null;
  terms?: number;
  relError?: number | null;
  same?: boolean;
  leakageMatters?: boolean;
  /** Simplified form: how it was made, and what it assumes (if anything). */
  method?: string;
  assumption?: string;
  tolerance?: number;
  /** Under assumptions: relative distance from the full model's value. */
  fullModelError?: number | null;
}

/** A noise source: its PSD formula and the numbers behind it. */
export interface NoiseSource {
  element: string;
  kind: string;
  /** The PSD formula as LaTeX, e.g. "\\frac{4kT}{R}". */
  psd: string;
  /** White PSD in A²/Hz; null for a flicker source. */
  white: number | null;
  /** Flicker: coef/f^exp in A²/Hz. */
  flicker: { coef: number; exp: number } | null;
  /** An assumption takes its PSD to 0: left out of `inputLowFreq`. */
  ignored?: true;
}

/** A bias-current symbol in the shot-noise terms, e.g. I_{C1}. */
export interface NoiseCurrent {
  name: string;
  latex: string;
  value: number | null;
  unit: string;
  elements: string[];
}

export interface SmallSignalNoise {
  temperature: number;
  /** Units of `input` and `output`: "V^2/Hz" or "A^2/Hz". */
  inputUnit: string;
  outputUnit: string;
  sources: NoiseSource[];
  output: NoisePoint[];
  input: NoisePoint[];
  /** The largest sources per frequency; the rest summed in `omitted`. */
  contributors: {
    f: number;
    sources: NoiseContribution[];
    omitted?: { count: number; v2: number | null; fraction: number | null };
  }[];
  integrated: {
    fLow: number;
    fHigh: number;
    /** inputRms null, with `unavailable`, when the gain is zero inside the band (outputRms too when the output noise cannot be integrated). */
    outputRms: number | null;
    inputRms: number | null;
    outputV2?: number | null;
    inputV2?: number | null;
    evaluations?: number;
    relError?: number;
    converged?: boolean;
    unavailable?: string;
  } | null;
  inputLowFreq:
    | {
        /** "per Hz": the forms are PSDs. */
        unit: string;
        exact: NoiseExpression;
        display: NoiseExpression;
        simplified: NoiseExpression;
        currents: NoiseCurrent[];
        check: { ok: boolean; maxRelDiff: number } | null;
      }
    | { unavailable: string };
}

/** One closed form of a distortion quantity. */
export interface DistortionForm {
  /** null when too large to typeset. */
  latex: string | null;
  value: number | null;
  /** Plain numerator/denominator for checking tools, when small enough. */
  plain?: PlainFraction | null;
  terms?: number | null;
  relError?: number | null;
  same?: boolean;
  leakageMatters?: boolean;
  /** Simplified forms: how they were made, e.g. "leading order (ro ≫ R, 1/gm)". */
  method?: string;
  tolerance?: number;
  /** Under assumptions: relative distance from the full model's value. */
  fullModelError?: number | null;
}

export interface DistortionQuantity extends DistortionForm {
  display?: DistortionForm | null;
  simplified?: DistortionForm | null;
  /** Why there is no exact form, e.g. "too large for the exact closed form". */
  skipped?: string;
}

/** HD2 and HD3 at one frequency; null when unavailable or infinite. */
export interface DistortionVsFreqPoint {
  f: number;
  hd2: number | null;
  hd3: number | null;
  /** Present (true) only when HD2 is infinite (H1 = 0, H2 ≠ 0). */
  hd2Infinite?: true;
  /** Present (true) only when HD3 is infinite (H1 = 0, H3 ≠ 0). */
  hd3Infinite?: true;
}

export interface SmallSignalDistortion {
  /** v_out = a1·v_in + a2·v_in² + a3·v_in³ around the bias. */
  coefficients: (DistortionQuantity & {
    order: number;
    /** The value from the numeric expansion (the closed forms' check). */
    numeric: number | null;
  })[];
  /**
   * null when unavailable (order 2 for hd3/iip3, or 0/0 at DC). An infinite
   * value (HD with a1 = 0, IIP3 with a3 = 0) is `latex: "\\infty"`,
   * `value: null`, and so its display and simplified forms.
   */
  hd2: DistortionQuantity | null;
  hd3: DistortionQuantity | null;
  iip3: DistortionQuantity | null;
  amplitude: number;
  /** "V" or "A". */
  inputUnit: string;
  nonlinear: string[];
  order: number;
  /** HD2 and HD3 at each frequency (Volterra kernels). */
  vsFreq: DistortionVsFreqPoint[];
  /** The devices' Taylor coefficients, e.g. K_{2g,M1} = ½∂²I_D/∂v_GS². */
  symbols: {
    name: string;
    latex: string;
    value: number | null;
    unit: string;
    elements: string[];
  }[];
  /** Each device current's Taylor terms, e.g. 2g = v_GS², with its value. */
  taylor: {
    element: string;
    current: string;
    monomial: string;
    order: number;
    value: number;
    kept: boolean;
    /** An assumption drops it from the closed forms. */
    ignored?: true;
  }[];
  /** The exact aₙ that materialized, against the numeric expansion. */
  check: {
    ok: boolean;
    maxRelDiff: number;
    orders: number[];
    /** The accepted matching mismatch's largest relative effect on aₙ. */
    matchBound: number;
  } | null;
  /** Largest relative change from junctions left out of the model. */
  omissionError: number | null;
}

export interface SmallSignalResult {
  /** True when no operating point was computed (missing values or requested). */
  symbolic?: boolean;
  op?: {
    nodes: Record<string, number>;
    devices: Record<string, DeviceOperatingPoint>;
  } | null;
  warnings?: string[];
  /**
   * Elements that may share symbols: transistors with the same model, size
   * (and bias, in numeric mode), and passives with equal values.
   */
  matchCandidates?: MatchCandidate[];
  /** Every symbol in the equations and the elements it stands for. */
  params?: SmallSignalParam[];
  gain?: SmallSignalQuantity;
  rin?: SmallSignalQuantity;
  rout?: SmallSignalQuantity;
  noise?: SmallSignalNoise;
  distortion?: SmallSignalDistortion;
  /** Elements that can take assumptions (always present). */
  assumable?: AssumableElement[];
  /** Present when the request has `assume`. */
  assumptions?: SmallSignalAssumptionReport;
  /** Present when the request has `suggest`. */
  suggestions?: SmallSignalSuggestions;
}

/** One further assumption: a term of one part, a matched group or a type. */
export interface SmallSignalSuggestion {
  elements: string[];
  term: AssumptionTerm;
  type: AssumableElement["type"];
  /** "type": the term of every part of that type. */
  scope: "part" | "group" | "type";
  /** Deviation from the full model with it added to the current assumptions. */
  alone: number;
  /** Deviation with it and every earlier kept item; null when not kept. */
  cumulative: number | null;
}

export interface SmallSignalSuggestions {
  quantity: SuggestQuantity;
  threshold: number;
  /** The current assumptions' deviation; null when unbounded throughout. */
  base: number | null;
  /** Candidates within the threshold, smallest deviation first. */
  items: SmallSignalSuggestion[];
  /** Deviation with every kept item together. */
  combined: number | null;
  candidates: number;
  evaluated: number;
  /** Candidates left out: the quantity would be unbounded. */
  unbounded: number;
  /** The cap that stopped the evaluation, if any. */
  capped: "time" | "candidates" | null;
}

export type SmallSignalResponse = SmallSignalResult | { error: string };

export function isSmallSignalError(
  response: SmallSignalResponse,
): response is { error: string } {
  return typeof (response as { error?: unknown }).error === "string";
}
