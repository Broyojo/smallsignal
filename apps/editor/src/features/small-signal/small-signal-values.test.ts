import { describe, expect, it } from "vitest";
import type { DeviceOperatingPoint } from "@icm/small-signal";
import {
  deviceValues,
  modelUnit,
  symbolText,
  valueText,
} from "./small-signal-values";

const format = (value: number, unit: string) => `${value} ${unit}`;

describe("small-signal values", () => {
  it("writes a symbol's LaTeX as a base and a subscript", () => {
    expect(symbolText("C_{gs3}")).toEqual({ base: "C", sub: "gs3" });
    expect(symbolText("r_{\\pi 1}")).toEqual({ base: "r", sub: "π1" });
    expect(symbolText("g_{m1,2}")).toEqual({ base: "g", sub: "m1,2" });
    expect(symbolText("V_{OD1}")).toEqual({ base: "V", sub: "OD1" });
    expect(symbolText("\\gamma")).toEqual({ base: "γ", sub: "" });
  });

  it("lists a MOSFET's conductances as the equations write them and every capacitance", () => {
    const op = {
      type: "nmos",
      gm: 1e-3,
      gmb: 2e-4,
      gds: 2e-6,
      caps: { cgs: 2.3e-14, cgd: 3e-15, cgb: 0, cbd: 5e-15, cbs: 4e-15 },
    } as DeviceOperatingPoint;
    const values = deviceValues("M3", op);
    expect(values.map((v) => v.latex)).toEqual([
      "g_{m3}",
      "g_{mb3}",
      "r_{o3}",
      "C_{gs3}",
      "C_{gd3}",
      "C_{gb3}",
      "C_{db3}",
      "C_{sb3}",
    ]);
    expect(values[2]).toEqual({ latex: "r_{o3}", value: 5e5, unit: "Ω" });
    // Zeros stay: a reader sees the capacitance is 0, not missing.
    expect(values[5]?.value).toBe(0);
  });

  it("writes a BJT's r_π and C_π with the device's number, and an open r_o as ∞", () => {
    const op = {
      type: "npn",
      gm: 4e-2,
      gpi: 4e-4,
      go: 0,
      caps: { cpi: 1e-12, cmu: 1e-13, csub: 0, cx: 0 },
    } as DeviceOperatingPoint;
    const values = deviceValues("Q2", op);
    expect(values.map((v) => v.latex)).toEqual([
      "g_{m2}",
      "r_{\\pi 2}",
      "r_{o2}",
      "C_{\\pi 2}",
      "C_{\\mu 2}",
      "C_{cs2}",
    ]);
    expect(valueText(values[2]!.value, "Ω", format)).toBe("∞");
  });

  it("knows each Models parameter's unit, none for a pure number", () => {
    expect(modelUnit("CGSO")).toBe("F/m");
    expect(modelUnit("CJ")).toBe("F/m²");
    expect(modelUnit("TOX")).toBe("m");
    expect(modelUnit("KP")).toBe("A/V²");
    expect(modelUnit("MJ")).toBe("");
    expect(modelUnit("BF")).toBe("");
  });
});
