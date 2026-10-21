import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  DeviceOperatingPoint,
  RegionReport,
  SmallSignalParam,
} from "@icm/small-signal";
import { symbolKey, type LinkStore } from "./small-signal-link";

// Every value the equations use, where a reader looks for it: on the symbol
// pointed at, in the device's menu, and in one Parameters table.

/** A symbol's LaTeX as text: `r_{\pi 1}` is r with subscript π1. */
export function symbolText(latex: string): { base: string; sub: string } {
  const plain = (text: string) =>
    text
      .replace(/\\pi\s*/gu, "π")
      .replace(/\\mu\s*/gu, "μ")
      .replace(/\\gamma\s*/gu, "γ")
      .replace(/\\,/gu, "")
      .replace(/[{}]/gu, "")
      .trim();
  const match = /^\{?([^_{}]+)\}?_\{(.*)\}$/u.exec(latex);
  return match
    ? { base: plain(match[1] ?? ""), sub: plain(match[2] ?? "") }
    : { base: plain(latex), sub: "" };
}

export function SymbolLabel({ latex }: { latex: string }) {
  const { base, sub } = symbolText(latex);
  return (
    <span className="small-signal-symbol">
      {base}
      {sub ? <sub>{sub}</sub> : null}
    </span>
  );
}

/** A value with its unit and engineering prefix: 23.0 fF, 520 kΩ. */
export type Format = (value: number, unit: string) => string;

/** Each Models parameter's unit, as SPICE level 1 and Gummel–Poon take it. */
const MODEL_UNITS: Readonly<Record<string, string>> = {
  KP: "A/V²",
  VTO: "V",
  LAMBDA: "1/V",
  GAMMA: "√V",
  PHI: "V",
  TOX: "m",
  CGSO: "F/m",
  CGDO: "F/m",
  CGBO: "F/m",
  CJ: "F/m²",
  CJSW: "F/m",
  CBD: "F",
  CBS: "F",
  PB: "V",
  IS: "A",
  VAF: "V",
  CJE: "F",
  VJE: "V",
  CJC: "F",
  VJC: "V",
  CJS: "F",
  TF: "s",
  CJO: "F",
  VJ: "V",
  TT: "s",
};

/** A Models parameter's unit; "" for a pure number (MJ, BF, N, KF, …). */
export function modelUnit(name: string): string {
  return MODEL_UNITS[name] ?? "";
}

/** One small-signal value of a device: its symbol, value and unit. */
export interface DeviceValue {
  latex: string;
  value: number;
  unit: string;
}

/** The solver's TeX escaping of a name's characters. */
function escTex(text: string): string {
  const named: Record<string, string> = {
    "\\": "\\backslash ",
    "^": "\\hat{}",
    "~": "\\sim ",
  };
  return text.replace(/[_{}$&#%\\^~]/gu, (c) => named[c] ?? `\\${c}`);
}

/** `g_{m1}` for M1, `g_{m,load}` for Mload, `g_{m}` for M: as the solver
 * writes a device's symbol. */
export function deviceLatex(base: string, sub: string, element: string) {
  const rest = element.slice(1);
  if (!rest) return `${base}_{${sub}}`;
  return /^[\d,]+$/u.test(rest)
    ? `${base}_{${sub}${rest}}`
    : `${base}_{${sub},${escTex(rest)}}`;
}

/**
 * A device's small-signal values at its bias: conductances as the
 * equations write them (g_m, g_mb; r_o or a triode R_on, r_π, r_d as
 * resistances), then every capacitance, zeros included. A value the
 * equations use is theirs (its symbol, and the assumed model's value);
 * the rest come from the operating point, linearized in an imposed region.
 */
export function deviceValues(
  name: string,
  op: DeviceOperatingPoint,
  params: readonly SmallSignalParam[] = [],
  region?: RegionReport,
): DeviceValue[] {
  const r = (g: number) => (g > 0 ? 1 / g : Infinity);
  const used = (prefix: string) =>
    params.find(
      (p) =>
        p.name === `${prefix}_${name}` ||
        (p.name.startsWith(`${prefix}_`) && p.elements?.includes(name)),
    );
  // The equations' symbol and value where they use it, else the bias's.
  const v = (
    prefixes: readonly string[],
    base: string,
    sub: string,
    value: number,
    unit: string,
  ): DeviceValue => {
    for (const prefix of prefixes) {
      const p = used(prefix);
      if (p && typeof p.value === "number")
        return { latex: p.latex, value: p.value, unit };
    }
    return { latex: deviceLatex(base, sub, name), value, unit };
  };
  switch (op.type) {
    case "nmos":
    case "pmos": {
      const imposed =
        region?.effect === "imposed" ? region.linearized : undefined;
      const { gm, gmb, gds } = imposed ?? op;
      const triode = (imposed ? region?.assumed : op.region) === "triode";
      return [
        v(["gm"], "g", "m", gm, "S"),
        v(["gmb"], "g", "mb", gmb, "S"),
        triode
          ? v(["ron", "ro"], "R", "on", r(gds), "Ω")
          : v(["ro", "ron"], "r", "o", r(gds), "Ω"),
        v(["cgs"], "C", "gs", op.caps.cgs, "F"),
        v(["cgd"], "C", "gd", op.caps.cgd, "F"),
        v(["cgb"], "C", "gb", op.caps.cgb, "F"),
        v(["cbd"], "C", "db", op.caps.cbd, "F"),
        v(["cbs"], "C", "sb", op.caps.cbs, "F"),
      ];
    }
    case "npn":
    case "pnp":
      return [
        v(["gm"], "g", "m", op.gm, "S"),
        v(["rpi"], "r", "\\pi ", r(op.gpi), "Ω"),
        v(["ro"], "r", "o", r(op.go), "Ω"),
        v(["cpi"], "C", "\\pi ", op.caps.cpi, "F"),
        v(["cmu"], "C", "\\mu ", op.caps.cmu, "F"),
        v(["ccs"], "C", "cs", op.caps.csub, "F"),
      ];
    case "diode":
      return [
        v(["rd"], "r", "d", r(op.gd), "Ω"),
        v(["cj"], "C", "j", op.caps.cj, "F"),
      ];
  }
}

/** A value whose bias is unknown (hand analysis): the solver sends null. */
function known(value: number | null): value is number {
  return typeof value === "number" && !Number.isNaN(value);
}

/** "520 kΩ", "∞" for an open (an output conductance of 0). */
export function valueText(
  value: number | null,
  unit: string,
  format: Format,
): string {
  if (!known(value)) return "—";
  return Number.isFinite(value) ? format(value, unit) : "∞";
}

/**
 * The value of the formula symbol pointed at, beside the pointer: it reads
 * the hover link (no re-render of the panel) and follows the pointer only
 * while a symbol is under it. A tap's value stays until the next tap, as a
 * finger lifting leaves the symbol. It keeps inside the viewport.
 */
export function SymbolValueTip({
  link,
  params,
  format,
}: {
  link: LinkStore;
  params: readonly SmallSignalParam[];
  format: Format;
}) {
  const state = useSyncExternalStore(link.subscribe, link.get, link.get);
  const pointed =
    state?.source === "formula" ? (state.symbols[0] ?? null) : null;
  const pointedRef = useRef(pointed);
  pointedRef.current = pointed;
  const [held, setHeld] = useState<string | null>(null);
  const latex = pointed ?? held;
  const param = latex
    ? params.find((p) => symbolKey(p.latex) === symbolKey(latex))
    : undefined;
  const shown =
    param && (known(param.value) || (param.elements?.length ?? 0) > 1);
  const shownRef = useRef(false);
  shownRef.current = Boolean(shown);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (event.type === "pointerdown" || shownRef.current)
        setAt({ x: event.clientX, y: event.clientY });
    };
    // A touch lifting keeps the symbol it tapped; a tap elsewhere clears it.
    const up = (event: PointerEvent) =>
      setHeld(event.pointerType === "touch" ? pointedRef.current : null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerdown", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerdown", move);
      window.removeEventListener("pointerup", up);
    };
  }, []);
  const tipRef = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(
    null,
  );
  useLayoutEffect(() => {
    const tip = tipRef.current;
    if (!tip || !at) return;
    const { width, height } = tip.getBoundingClientRect();
    const margin = 8;
    // Below right of the pointer; flipped where that leaves the viewport.
    let left = at.x + 12;
    let top = at.y + 16;
    if (left + width > window.innerWidth - margin) left = at.x - 12 - width;
    if (top + height > window.innerHeight - margin) top = at.y - 8 - height;
    left = Math.max(margin, Math.min(left, window.innerWidth - margin - width));
    top = Math.max(margin, top);
    setPlace((old) =>
      old?.left === left && old.top === top ? old : { left, top },
    );
  });
  if (!param || !shown || !at) return null;
  const members = param.elements ?? [param.element];
  return (
    <div
      ref={tipRef}
      className="small-signal-value-tip"
      role="tooltip"
      data-testid="small-signal-value-tip"
      style={place ?? { left: at.x + 12, top: at.y + 16 }}
    >
      <SymbolLabel latex={param.latex} />
      {known(param.value) ? <> = {format(param.value, param.unit)}</> : null}
      {members.length > 1 ? (
        <small className="small-signal-muted"> {members.join(" = ")}</small>
      ) : null}
    </div>
  );
}

/** Every symbol the equations use, with its value: one table. */
export function ParametersTable({
  params,
  format,
}: {
  params: readonly SmallSignalParam[];
  format: Format;
}) {
  return (
    <table className="small-signal-values" aria-label="Parameters">
      <tbody>
        {params.map((param) => (
          <tr key={param.name} data-param={param.name}>
            <th scope="row">
              <SymbolLabel latex={param.latex} />
            </th>
            <td>{valueText(param.value, param.unit, format)}</td>
            <td className="small-signal-muted">
              {(param.elements ?? [param.element]).join(", ")}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
