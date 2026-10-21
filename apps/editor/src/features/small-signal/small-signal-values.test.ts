import { describe, expect, it } from "vitest";
import type { DeviceOperatingPoint, SmallSignalParam } from "@icm/small-signal";
import {
  deviceLatex,
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

  it("names a device's symbols as the solver does", () => {
    expect(deviceLatex("g", "m", "M1")).toBe("g_{m1}");
    expect(deviceLatex("g", "m", "Mload")).toBe("g_{m,load}");
    expect(deviceLatex("g", "m", "M_load")).toBe("g_{m,\\_load}");
    expect(deviceLatex("g", "m", "M")).toBe("g_{m}");
  });

  const mos = {
    type: "nmos",
    region: "saturation",
    gm: 1e-3,
    gmb: 2e-4,
    gds: 2e-6,
    caps: { cgs: 2.3e-14, cgd: 3e-15, cgb: 0, cbd: 5e-15, cbs: 4e-15 },
  } as DeviceOperatingPoint;

  it("calls a triode channel's resistance R_on", () => {
    const op = { ...mos, region: "triode" } as DeviceOperatingPoint;
    expect(deviceValues("M1", op)[2]?.latex).toBe("R_{on1}");
  });

  it("takes the equations' symbol and value where they use one, and an imposed region's conductances", () => {
    const params = [
      {
        name: "gm_M1",
        latex: "g_{m1,2}",
        value: 9e-4,
        unit: "S",
        element: "M1",
        elements: ["M1", "M2"],
      },
      {
        name: "ron_M1",
        latex: "R_{on1,2}",
        value: 1e3,
        unit: "Ω",
        element: "M1",
        elements: ["M1", "M2"],
      },
    ] as SmallSignalParam[];
    const values = deviceValues("M2", mos, params, {
      element: "M2",
      assumed: "triode",
      actual: "saturation",
      effect: "imposed",
      linearized: { gm: 5e-4, gds: 1e-3, gmb: 1e-4 },
    });
    expect(values[0]).toEqual({ latex: "g_{m1,2}", value: 9e-4, unit: "S" });
    expect(values[1]).toEqual({ latex: "g_{mb2}", value: 1e-4, unit: "S" });
    expect(values[2]).toEqual({ latex: "R_{on1,2}", value: 1e3, unit: "Ω" });
  });

  it("writes an unknown value (hand analysis) as a dash, not ∞", () => {
    expect(valueText(null, "S", format)).toBe("—");
    expect(valueText(Number.NaN, "S", format)).toBe("—");
    expect(valueText(Infinity, "Ω", format)).toBe("∞");
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
