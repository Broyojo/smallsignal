import { useEffect, useState, useSyncExternalStore } from "react";
import type { DeviceOperatingPoint, SmallSignalParam } from "@icm/small-signal";
import type { LinkStore } from "./small-signal-link";

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

/**
 * A device's small-signal values at its bias, from the operating point:
 * conductances as the equations write them (g_m, g_mb; r_o, r_π, r_d as
 * resistances), then every capacitance, zeros included.
 */
export function deviceValues(
  name: string,
  op: DeviceOperatingPoint,
): DeviceValue[] {
  const n = name.replace(/^[A-Za-z]+/u, "") || name;
  const r = (g: number) => (g > 0 ? 1 / g : Infinity);
  // r_{o1}, C_{\pi 1}: the quantity's subscript, then the device's number.
  const v = (base: string, sub: string, value: number, unit: string) => ({
    latex: `${base}_{${sub}${n}}`,
    value,
    unit,
  });
  switch (op.type) {
    case "nmos":
    case "pmos":
      return [
        v("g", "m", op.gm, "S"),
        v("g", "mb", op.gmb, "S"),
        v("r", "o", r(op.gds), "Ω"),
        v("C", "gs", op.caps.cgs, "F"),
        v("C", "gd", op.caps.cgd, "F"),
        v("C", "gb", op.caps.cgb, "F"),
        v("C", "db", op.caps.cbd, "F"),
        v("C", "sb", op.caps.cbs, "F"),
      ];
    case "npn":
    case "pnp":
      return [
        v("g", "m", op.gm, "S"),
        v("r", "\\pi ", r(op.gpi), "Ω"),
        v("r", "o", r(op.go), "Ω"),
        v("C", "\\pi ", op.caps.cpi, "F"),
        v("C", "\\mu ", op.caps.cmu, "F"),
        v("C", "cs", op.caps.csub, "F"),
      ];
    case "diode":
      return [v("r", "d", r(op.gd), "Ω"), v("C", "j", op.caps.cj, "F")];
  }
}

/** "520 kΩ", "∞" for an open (an output conductance of 0). */
export function valueText(value: number, unit: string, format: Format): string {
  return Number.isFinite(value) ? format(value, unit) : "∞";
}

/**
 * The value of the formula symbol pointed at, beside the pointer: it reads
 * the hover link (no re-render of the panel) and follows the pointer only
 * while a symbol is under it.
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
  const latex = state?.source === "formula" ? (state.symbols[0] ?? null) : null;
  const param = latex ? params.find((p) => p.latex === latex) : undefined;
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!param) return;
    const move = (event: PointerEvent) =>
      setAt({ x: event.clientX, y: event.clientY });
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerdown", move);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerdown", move);
    };
  }, [param]);
  if (!param || !at) return null;
  const members = param.elements ?? [param.element];
  return (
    <div
      className="small-signal-value-tip"
      role="tooltip"
      data-testid="small-signal-value-tip"
      style={{ left: at.x + 12, top: at.y + 16 }}
    >
      <SymbolLabel latex={param.latex} /> ={" "}
      {valueText(param.value, param.unit, format)}
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
