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

export interface MatchCandidate {
  elements: string[];
  kind: "device" | "passive";
  /** Whether this solve matched them (matchAuto, minus unmatch). */
  applied?: boolean;
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
  gain?: SmallSignalQuantity;
  rin?: SmallSignalQuantity;
  rout?: SmallSignalQuantity;
}

export type SmallSignalResponse = SmallSignalResult | { error: string };

export function isSmallSignalError(
  response: SmallSignalResponse,
): response is { error: string } {
  return typeof (response as { error?: unknown }).error === "string";
}
