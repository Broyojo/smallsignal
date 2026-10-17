// The solver's JSON contract (crates/smallsignal-wasm `analyze`).

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
  /** Hand analysis: the approximation the simplified form makes. */
  assumption?: string;
  /** The plain sum-of-products form when `latex` uses ∥ notation. */
  latexExpanded?: string | null;
}

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
  /** In Hz; empty in symbolic mode (no values). */
  poles?: Root[];
  zeros?: Root[];
  /** Number of poles and zeros: the degree in s of the denominator and
   * numerator (also in symbolic mode). */
  poleCount?: number;
  zeroCount?: number;
  /** Symbolic against direct numeric solve (numeric mode); null when the
   * exact form is over budget. */
  check?: { ok: boolean; maxRelDiff: number } | null;
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
}

export type DeviceOperatingPoint =
  | MosOperatingPoint
  | BjtOperatingPoint
  | ({ type: string } & Record<string, number | string>);

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
}

export type SmallSignalResponse = SmallSignalResult | { error: string };

export function isSmallSignalError(
  response: SmallSignalResponse,
): response is { error: string } {
  return typeof (response as { error?: unknown }).error === "string";
}
