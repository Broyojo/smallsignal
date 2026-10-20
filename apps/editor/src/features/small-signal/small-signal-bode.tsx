import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { Root, SweepPoint } from "@icm/small-signal";
import {
  CURVE_LABEL,
  SNAP_LABEL,
  bodeCurves,
  frequencyTicks,
  isFlat,
  magnitudeTicks,
  nearestIndex,
  phaseMargin,
  phaseTicks,
  rootFrequencies,
  snapTarget,
  type BodeCurve,
  type CurveKind,
  type SnapTarget,
} from "./small-signal-bode-data";

// A compact Bode plot on a result card: |H| over a log frequency axis and
// the phase under it, the full model's curve with the assumed model's and
// the ≈ form's over it, poles (×) and zeros (○) on the frequency axis, and
// a crosshair that reads every curve at one swept frequency, landing on a
// pole, zero, unity-gain or −3 dB point when near one (the solver sweeps
// each exactly) unless Alt is held.

const MAG_HEIGHT = 96;
const PHASE_HEIGHT = 54;
const GAP = 12;
const LEFT = 40;
const RIGHT = 8;
const TOP = 16;
const AXIS = 16;
/** How near (px) a marked point pulls the crosshair onto it. */
const SNAP_PX = 8;

/** "1k", "10meg"-free: the editor's engineering prefixes, as on the cards. */
function hzLabel(decade: number): string {
  const prefixes: Record<number, string> = {
    [-3]: "m",
    0: "",
    3: "k",
    6: "M",
    9: "G",
    12: "T",
  };
  const group = Math.floor(decade / 3) * 3;
  const prefix = prefixes[group];
  if (prefix === undefined) return `1e${decade}`;
  return `${10 ** (decade - group)}${prefix}`;
}

/** f, |H| and ∠H as the readout writes them. */
export function readoutText(
  value: { log: number | null; phase: number | null },
  decibels: boolean,
  format: (value: number, unit: string) => string,
): { magnitude: string; phase: string } {
  const magnitude =
    value.log === null
      ? "—"
      : decibels
        ? `${(20 * value.log).toFixed(1).replace(/^-/u, "−")} dB`
        : format(10 ** value.log, "Ω");
  const phase =
    value.phase === null
      ? "—"
      : `${value.phase.toFixed(1).replace(/^-/u, "−")}°`;
  return { magnitude, phase };
}

function pathOf(
  values: readonly (number | null)[],
  x: (index: number) => number,
  y: (value: number) => number,
): string {
  let d = "";
  let pen = false;
  values.forEach((value, index) => {
    if (value === null) {
      pen = false;
      return;
    }
    d += `${pen ? "L" : "M"}${x(index).toFixed(1)},${y(value).toFixed(1)}`;
    pen = true;
  });
  return d;
}

function range(curves: readonly BodeCurve[], key: "log" | "phase") {
  const values = curves.flatMap((curve) =>
    curve[key].filter((value): value is number => value !== null),
  );
  return values.length
    ? { low: Math.min(...values), high: Math.max(...values) }
    : null;
}

/** Pads a range so a flat stretch sits inside the panel, not on its edge. */
function padded(
  span: { low: number; high: number },
  minimum: number,
): { low: number; high: number } {
  const size = Math.max(span.high - span.low, minimum);
  const middle = (span.high + span.low) / 2;
  return { low: middle - size * 0.56, high: middle + size * 0.56 };
}

export interface BodeProps {
  /** Card title, for the figure's name. */
  title: string;
  freqs: readonly number[];
  curves: Partial<Record<CurveKind, readonly SweepPoint[] | null | undefined>>;
  /** Ohms on the magnitude axis instead of dB. */
  ohms: boolean;
  poles: readonly Root[] | null | undefined;
  zeros: readonly Root[] | null | undefined;
  /** The gain's unity and −3 dB frequencies (Hz), swept exactly. */
  crossings?: { unity: number | null; bandwidth: number | null } | null;
  format: (value: number, unit: string) => string;
}

/** Whether a card has anything to plot: a swept curve that moves. */
export function hasBode(
  freqs: readonly number[] | undefined,
  full: readonly SweepPoint[] | null | undefined,
): boolean {
  if (!freqs?.length || !full?.length) return false;
  const [curve] = bodeCurves({ full });
  return Boolean(
    curve && curve.log.filter((v) => v !== null).length >= 2 && !isFlat(curve),
  );
}

export function BodePlot({
  title,
  freqs,
  curves: given,
  ohms,
  poles,
  zeros,
  crossings,
  format,
}: BodeProps) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);
  // The pointer's x on the plot (null off it) and whether Alt is held:
  // the crosshair and any snap follow from these and the current data, so
  // a re-solve or resize never leaves a stale snap.
  const [pointer, setPointer] = useState<{ px: number; alt: boolean } | null>(
    null,
  );
  const pointing = pointer !== null;
  useEffect(() => {
    if (!pointing) return;
    // Alt pressed or released over a still pointer applies at once.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Alt") return;
      setPointer((last) => last && { ...last, alt: event.altKey });
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    };
  }, [pointing]);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () => setWidth(Math.max(200, element.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const curves = useMemo(
    () =>
      bodeCurves(given).filter(
        (curve) => curve.log.filter((value) => value !== null).length >= 2,
      ),
    [given],
  );
  const magnitude = range(curves, "log");
  const phase = range(curves, "phase");
  const fLow = freqs[0];
  const fHigh = freqs[freqs.length - 1];
  if (
    !curves.length ||
    !magnitude ||
    !phase ||
    fLow === undefined ||
    fHigh === undefined ||
    !(fHigh > fLow)
  )
    return null;

  const decibels = !ohms;
  // At least 0.3 decades (6 dB) and 20°, so a flat stretch sits inside.
  const magSpan = padded(magnitude, 0.3);
  const phaseSpan = padded(phase, 20);
  const plotWidth = width - LEFT - RIGHT;
  const xOfF = (f: number) =>
    LEFT +
    ((Math.log10(f) - Math.log10(fLow)) /
      (Math.log10(fHigh) - Math.log10(fLow))) *
      plotWidth;
  const x = (index: number) => xOfF(freqs[index] ?? fLow);
  const magTop = TOP;
  const magBottom = TOP + MAG_HEIGHT;
  const phaseTop = magBottom + GAP;
  const phaseBottom = phaseTop + PHASE_HEIGHT;
  const height = phaseBottom + AXIS;
  const yMag = (value: number) =>
    magBottom -
    ((value - magSpan.low) / (magSpan.high - magSpan.low)) * MAG_HEIGHT;
  const yPhase = (value: number) =>
    phaseBottom -
    ((value - phaseSpan.low) / (phaseSpan.high - phaseSpan.low)) * PHASE_HEIGHT;
  const magTicks = magnitudeTicks(magSpan.low, magSpan.high, decibels);
  const degTicks = phaseTicks(phaseSpan.low, phaseSpan.high);
  const fTicks = frequencyTicks(fLow, fHigh);
  // Zeros first: a pole-zero doublet draws × over ○.
  const marks = [
    ...rootFrequencies(zeros).map((item) => ({ ...item, kind: "zero" })),
    ...rootFrequencies(poles).map((item) => ({ ...item, kind: "pole" })),
  ].filter(({ f }) => f >= fLow && f <= fHigh);
  // Unity gain only on a dB axis (a voltage gain); −3 dB on either.
  const crossingTargets: SnapTarget[] = (
    decibels ? (["unity", "bandwidth"] as const) : (["bandwidth"] as const)
  ).flatMap((kind) => {
    const f = crossings?.[kind];
    return f != null && f >= fLow && f <= fHigh ? [{ f, kind }] : [];
  });
  // A point is a target only where the sweep holds it exactly (an
  // impedance's own zero may not be swept).
  const swept = (f: number) =>
    freqs.some((value) => Math.abs(value / f - 1) < 1e-9);
  const targets: SnapTarget[] = [
    ...marks.map(({ f, kind }) => ({ f, kind: kind as "pole" | "zero" })),
    ...crossingTargets,
  ].filter(({ f }) => swept(f));

  const onPointer = (event: ReactPointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * width;
    setPointer(
      px < LEFT - 4 || px > width - RIGHT + 4
        ? null
        : { px, alt: event.altKey },
    );
  };
  // Alt (⌥) reads freely, as in drawing tools.
  const snapped =
    pointer && !pointer.alt
      ? snapTarget(targets, pointer.px, xOfF, SNAP_PX)
      : null;
  const hover = !pointer
    ? null
    : snapped
      ? nearestIndex(freqs, snapped.f)
      : nearestIndex(
          freqs,
          10 **
            (Math.log10(fLow) +
              Math.min(1, Math.max(0, (pointer.px - LEFT) / plotWidth)) *
                (Math.log10(fHigh) - Math.log10(fLow))),
        );
  const full = curves.find((curve) => curve.kind === "full");
  const margin =
    snapped?.kind === "unity" && hover !== null && full
      ? phaseMargin(full.phase, hover)
      : null;
  const hx = hover === null ? null : x(hover);
  const magLabel = (value: number) =>
    decibels
      ? `${Math.round(value * 20)}`.replace(/^-/u, "−")
      : format(10 ** value, "Ω").replace(" ", "");
  const bandText = `${format(fLow, "Hz")} to ${format(fHigh, "Hz")}`;
  return (
    <figure
      className="small-signal-bode"
      aria-label={`${title} Bode plot`}
      data-testid="small-signal-bode"
      ref={box}
    >
      {curves.length > 1 ? (
        <figcaption className="small-signal-bode-legend">
          {curves.map((curve) => (
            <span key={curve.kind} data-curve={curve.kind}>
              <svg width="18" height="8" aria-hidden="true">
                <line
                  x1="1"
                  y1="4"
                  x2="17"
                  y2="4"
                  className={`small-signal-bode-line is-${curve.kind}`}
                />
              </svg>
              {CURVE_LABEL[curve.kind]}
            </span>
          ))}
        </figcaption>
      ) : null}
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${title}: magnitude and phase from ${bandText}`}
        onPointerMove={onPointer}
        onPointerDown={onPointer}
        onPointerLeave={() => setPointer(null)}
      >
        {/* Grid and axis labels, recessive. */}
        {magTicks.map((tick) => (
          <g key={`m${tick}`} className="small-signal-bode-grid">
            <line
              x1={LEFT}
              x2={width - RIGHT}
              y1={yMag(tick)}
              y2={yMag(tick)}
            />
            <text
              x={LEFT - 4}
              y={yMag(tick)}
              textAnchor="end"
              dominantBaseline="middle"
            >
              {magLabel(tick)}
            </text>
          </g>
        ))}
        {degTicks.map((tick) => (
          <g key={`p${tick}`} className="small-signal-bode-grid">
            <line
              x1={LEFT}
              x2={width - RIGHT}
              y1={yPhase(tick)}
              y2={yPhase(tick)}
            />
            <text
              x={LEFT - 4}
              y={yPhase(tick)}
              textAnchor="end"
              dominantBaseline="middle"
            >
              {`${tick}°`.replace(/^-/u, "−")}
            </text>
          </g>
        ))}
        {fTicks.map((decade) => (
          <g key={`f${decade}`} className="small-signal-bode-grid">
            <line
              x1={xOfF(10 ** decade)}
              x2={xOfF(10 ** decade)}
              y1={magTop}
              y2={magBottom}
            />
            <line
              x1={xOfF(10 ** decade)}
              x2={xOfF(10 ** decade)}
              y1={phaseTop}
              y2={phaseBottom}
            />
            <text x={xOfF(10 ** decade)} y={height - 3} textAnchor="middle">
              {hzLabel(decade)}
            </text>
          </g>
        ))}
        <text className="small-signal-bode-unit" x={2} y={height - 3}>
          Hz
        </text>
        <text
          className="small-signal-bode-unit"
          x={LEFT - 4}
          y={magTop - 9}
          textAnchor="end"
        >
          {decibels ? "dB" : "|Z|"}
        </text>
        <rect
          className="small-signal-bode-frame"
          x={LEFT}
          y={magTop}
          width={plotWidth}
          height={MAG_HEIGHT}
        />
        <rect
          className="small-signal-bode-frame"
          x={LEFT}
          y={phaseTop}
          width={plotWidth}
          height={PHASE_HEIGHT}
        />
        {curves.map((curve) => (
          <g key={curve.kind} data-curve={curve.kind}>
            <path
              className={`small-signal-bode-line is-${curve.kind}`}
              d={pathOf(curve.log, x, yMag)}
            />
            <path
              className={`small-signal-bode-line is-${curve.kind}`}
              d={pathOf(curve.phase, x, yPhase)}
            />
          </g>
        ))}
        {/* Poles × and zeros ○ where the magnitude panel meets the axis. */}
        {marks.map(({ root, f, kind }, index) => {
          const cx = xOfF(f);
          const cy = magBottom;
          const rhp = root.re > 0;
          const label = `${kind === "pole" ? "Pole" : "Zero"} ${format(root.re, "Hz")}${root.im ? ` ± j${format(root.im, "Hz")}` : ""}${rhp ? ", right half-plane" : ""}`;
          return (
            <g
              key={`${kind}${index}`}
              className={`small-signal-bode-root${rhp ? " is-rhp" : ""}`}
              data-root={kind}
            >
              <title>{label}</title>
              <line
                x1={cx}
                x2={cx}
                y1={magTop}
                y2={phaseBottom}
                className="small-signal-bode-root-guide"
              />
              {kind === "pole" ? (
                <path
                  d={`M${cx - 3.5},${cy - 3.5}L${cx + 3.5},${cy + 3.5}M${cx - 3.5},${cy + 3.5}L${cx + 3.5},${cy - 3.5}`}
                />
              ) : (
                <circle cx={cx} cy={cy} r={3.5} />
              )}
            </g>
          );
        })}
        {/* Unity-gain and −3 dB points on the full model's magnitude. */}
        {crossingTargets.map((target) => {
          const index = nearestIndex(freqs, target.f);
          const m = full?.log[index];
          return m == null ? null : (
            <circle
              key={target.kind}
              className="small-signal-bode-crossing"
              data-crossing={target.kind}
              cx={xOfF(target.f)}
              cy={yMag(m)}
              r={2.5}
            >
              <title>{`${SNAP_LABEL[target.kind]} ${format(target.f, "Hz")}`}</title>
            </circle>
          );
        })}
        {hx !== null && hover !== null ? (
          <g
            className={`small-signal-bode-cursor${snapped ? " is-snapped" : ""}`}
          >
            <line x1={hx} x2={hx} y1={magTop} y2={phaseBottom} />
            {curves.map((curve) => {
              const m = curve.log[hover];
              const p = curve.phase[hover];
              return (
                <g key={curve.kind} className={`is-${curve.kind}`}>
                  {m == null ? null : <circle cx={hx} cy={yMag(m)} r={3} />}
                  {p == null ? null : <circle cx={hx} cy={yPhase(p)} r={3} />}
                </g>
              );
            })}
          </g>
        ) : null}
      </svg>
      {hover !== null ? (
        <div
          className="small-signal-bode-readout"
          role="status"
          data-testid="small-signal-bode-readout"
          style={
            // In the plot's far corner from the crosshair, never past
            // the card's edge.
            (hx ?? 0) > width / 2 ? { left: LEFT + 4 } : { right: RIGHT + 4 }
          }
        >
          <strong data-snapped={snapped?.kind}>
            {snapped ? `${SNAP_LABEL[snapped.kind]} ` : ""}
            {format(freqs[hover] ?? fLow, "Hz")}
          </strong>
          <table>
            <tbody>
              {curves.map((curve) => {
                const text = readoutText(
                  {
                    log: curve.log[hover] ?? null,
                    phase: curve.phase[hover] ?? null,
                  },
                  decibels,
                  format,
                );
                return (
                  <tr key={curve.kind} data-curve={curve.kind}>
                    {curves.length > 1 ? (
                      <th scope="row">{CURVE_LABEL[curve.kind]}</th>
                    ) : null}
                    <td data-quantity="magnitude">{text.magnitude}</td>
                    <td data-quantity="phase">{text.phase}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {margin !== null ? (
            <span data-quantity="phase-margin">
              Phase margin {margin.toFixed(1).replace(/^-/u, "−")}°
            </span>
          ) : null}
        </div>
      ) : null}
    </figure>
  );
}
