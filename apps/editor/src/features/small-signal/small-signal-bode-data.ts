import type { Root, SweepPoint } from "@icm/small-signal";

// The numbers a Bode plot draws, from the solver's swept values: nothing
// here fits, smooths or resamples, so every plotted point is a solver value.

/** One curve of a plot, by what it shows. */
export type CurveKind = "full" | "assumed" | "approx";

export const CURVE_LABEL: Record<CurveKind, string> = {
  full: "Full model",
  assumed: "Assumed",
  approx: "≈ form",
};

export interface BodeCurve {
  kind: CurveKind;
  /** log10 |H| per swept frequency; null where H is not finite or 0. */
  log: (number | null)[];
  /** Phase in degrees, unwrapped along the sweep; null where undefined. */
  phase: (number | null)[];
}

/** log10 |H|, null where the point is missing, infinite or zero. */
export function logMagnitude(point: SweepPoint): number | null {
  if (!point) return null;
  const magnitude = Math.hypot(point[0], point[1]);
  return magnitude > 0 && Number.isFinite(magnitude)
    ? Math.log10(magnitude)
    : null;
}

/**
 * The phase of each point in degrees, made continuous: each step is the
 * principal difference from the last defined point, so a phase that keeps
 * falling past −180° keeps falling rather than jumping to +180°. The first
 * defined point lies within 180° of `near` (the full model's start), so
 * two curves of one quantity start on the same branch.
 */
export function unwrapPhase(
  points: readonly SweepPoint[],
  near?: number | null,
): (number | null)[] {
  let last: number | null = null;
  return points.map((point) => {
    if (!point || (point[0] === 0 && point[1] === 0)) return null;
    const principal = (Math.atan2(point[1], point[0]) * 180) / Math.PI;
    if (last === null) {
      last =
        near == null
          ? principal
          : principal + 360 * Math.round((near - principal) / 360);
      return last;
    }
    const step = principal - last;
    last += step - 360 * Math.round(step / 360);
    return last;
  });
}

export function bodeCurve(
  kind: CurveKind,
  points: readonly SweepPoint[],
  near?: number | null,
): BodeCurve {
  return {
    kind,
    log: points.map(logMagnitude),
    phase: unwrapPhase(points, near),
  };
}

/** The first defined value. */
function first(values: readonly (number | null)[]): number | null {
  return values.find((value) => value !== null) ?? null;
}

/**
 * The curves a card plots: the full model's, then the assumed model's,
 * then the ≈ form's, each only when given. Every later curve's phase
 * starts on the full model's branch.
 */
export function bodeCurves(
  curves: Partial<Record<CurveKind, readonly SweepPoint[] | null | undefined>>,
): BodeCurve[] {
  const out: BodeCurve[] = [];
  let near: number | null = null;
  for (const kind of ["full", "assumed", "approx"] as const) {
    const points = curves[kind];
    if (!points?.length) continue;
    const curve = bodeCurve(kind, points, near);
    near ??= first(curve.phase);
    out.push(curve);
  }
  return out;
}

/** Below these, a response is flat: nothing for a plot to show. */
const FLAT_DECADES = 0.0005;
const FLAT_DEGREES = 0.1;

/** Whether a curve moves at all over the sweep (magnitude or phase). */
export function isFlat(curve: BodeCurve): boolean {
  const span = (values: readonly (number | null)[]) => {
    const defined = values.filter((value): value is number => value !== null);
    return defined.length < 2 ? 0 : Math.max(...defined) - Math.min(...defined);
  };
  return span(curve.log) < FLAT_DECADES && span(curve.phase) < FLAT_DEGREES;
}

/** Ticks of a log10 magnitude axis: dB for a gain, decades for ohms. */
export function magnitudeTicks(
  low: number,
  high: number,
  decibels: boolean,
): number[] {
  if (!(high > low)) return [low];
  if (decibels) {
    // 20 dB = one decade; finer when the range is small.
    const db = (high - low) * 20;
    const step = db > 120 ? 40 : db > 50 ? 20 : db > 20 ? 10 : db > 8 ? 4 : 2;
    const ticks: number[] = [];
    for (
      let tick = Math.ceil((low * 20) / step) * step;
      tick <= high * 20 + 1e-9;
      tick += step
    )
      ticks.push(tick / 20);
    return ticks;
  }
  const stride = high - low > 6 ? 2 : 1;
  const decades: number[] = [];
  for (let decade = Math.ceil(low); decade <= Math.floor(high); decade += 1)
    if (decade % stride === 0) decades.push(decade);
  if (decades.length >= 2) return decades;
  // Within a decade or two: the 1-2-5 values (one is enough), else every
  // digit, so the axis reads in round values.
  for (const digits of [
    [1, 2, 5],
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
  ]) {
    const ticks: number[] = [];
    for (let decade = Math.floor(low); decade <= Math.ceil(high); decade += 1)
      for (const digit of digits) {
        const tick = decade + Math.log10(digit);
        if (tick >= low - 1e-9 && tick <= high + 1e-9) ticks.push(tick);
      }
    if (ticks.length) return ticks;
  }
  return [low, high];
}

/** Phase ticks: multiples of 45° or 90°, a handful across the range. */
export function phaseTicks(low: number, high: number): number[] {
  const span = high - low;
  const step = span > 360 ? 180 : span > 135 ? 90 : span > 40 ? 45 : 15;
  const ticks: number[] = [];
  for (
    let tick = Math.ceil(low / step) * step;
    tick <= high + 1e-9;
    tick += step
  )
    ticks.push(tick);
  return ticks;
}

/** Decades on the frequency axis, every other one when there are many. */
export function frequencyTicks(fLow: number, fHigh: number): number[] {
  const low = Math.ceil(Math.log10(fLow) - 1e-9) + 0;
  const high = Math.floor(Math.log10(fHigh) + 1e-9);
  const stride = high - low > 8 ? 2 : 1;
  const ticks: number[] = [];
  for (let decade = low; decade <= high; decade += 1)
    if ((decade - low) % stride === 0) ticks.push(decade);
  return ticks;
}

/**
 * The poles or zeros to mark, as |p| in Hz, one per conjugate pair; roots
 * at DC have no place on a log axis.
 */
export function rootFrequencies(roots: readonly Root[] | null | undefined) {
  return (roots ?? [])
    .filter((root) => root.im >= 0)
    .map((root) => ({ root, f: Math.hypot(root.re, root.im) }))
    .filter(({ f }) => f > 0 && Number.isFinite(f));
}

/** The swept point nearest to a frequency on the log axis. */
export function nearestIndex(freqs: readonly number[], f: number): number {
  let best = 0;
  let distance = Infinity;
  const target = Math.log10(f);
  freqs.forEach((value, index) => {
    const d = Math.abs(Math.log10(value) - target);
    if (d < distance) {
      distance = d;
      best = index;
    }
  });
  return best;
}
