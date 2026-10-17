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
  exact: SmallSignalExpression;
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
  poles?: Root[];
  zeros?: Root[];
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

/** One closed form of the input-referred white (thermal + shot) PSD. */
export interface NoiseExpression {
  latex: string | null;
  /** null in hand analysis (no operating point). */
  value: number | null;
  terms?: number;
  relError?: number;
  same?: boolean;
  assumption?: string;
}

export interface SmallSignalNoise {
  temperature: number;
  /** Units of `input` and `output`: "V^2/Hz" or "A^2/Hz". */
  inputUnit: string;
  outputUnit: string;
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
    relError?: number;
    converged?: boolean;
    unavailable?: string;
  } | null;
  inputLowFreq:
    | {
        exact: NoiseExpression;
        display: NoiseExpression;
        simplified: NoiseExpression;
        check: { ok: boolean; maxRelDiff: number } | null;
      }
    | { unavailable: string };
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
}

export type SmallSignalResponse = SmallSignalResult | { error: string };

export function isSmallSignalError(
  response: SmallSignalResponse,
): response is { error: string } {
  return typeof (response as { error?: unknown }).error === "string";
}
