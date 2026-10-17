import { describe, expect, it } from "vitest";
import type { SmallSignalSource } from "@icm/small-signal";
import {
  differentialPairs,
  formatPlain,
  formatSpiceNumber,
  modelOverrides,
  modelValue,
  parseSpiceNumber,
  preferredOutput,
  signalLabel,
} from "./small-signal-panel";

describe("formatPlain", () => {
  it("writes gains as plain numbers, never with SI prefixes", () => {
    expect(formatPlain(-3.8462)).toBe("-3.846");
    expect(formatPlain(1)).toBe("1");
    expect(formatPlain(-8.481e-31)).toBe("-8.481e-31");
    expect(formatPlain(2.5e7)).toBe("2.500e+7");
    expect(formatPlain(0)).toBe("0");
  });
});

describe("signalLabel", () => {
  it("drops a leading v/i from net and source names", () => {
    expect(signalLabel("v", "Vout")).toBe("v_{out}");
    expect(signalLabel("v", "out")).toBe("v_{out}");
    expect(signalLabel("v", "V1")).toBe("v_{1}");
    expect(signalLabel("i", "IIN")).toBe("i_{IN}");
    expect(signalLabel("v", "v")).toBe("v_{v}");
  });

  it("escapes underscores for TeX", () => {
    expect(signalLabel("v", "out_DUT")).toBe("v_{out\\_DUT}");
  });
});

describe("preferredOutput", () => {
  it("never defaults to a supply rail", () => {
    // The drawing that picked VDD: drain net named Vinp, VDD from a symbol.
    expect(
      preferredOutput(["0", "VDD", "Vinp", "net0"], new Set(["net0", "0"]), [
        "VDD",
      ]),
    ).toBe("Vinp");
  });

  it("prefers a net named like an output", () => {
    expect(
      preferredOutput(["0", "a", "vout", "vdd"], new Set(["vdd"]), []),
    ).toBe("vout");
  });
});

describe("differentialPairs", () => {
  const pin = (name: string): SmallSignalSource => ({
    name: `VPIN_${name}`,
    kind: "voltage",
    nodes: [name, "0"],
    dc: "?",
    pin: name,
  });
  const labels = (sources: SmallSignalSource[]) =>
    differentialPairs(sources).map(([a, b]) => `${a.pin}|${b.pin}`);

  it("pairs Vin1/Vin2, Vin+/Vin−, Vinp/Vinn and INP/INN", () => {
    expect(labels([pin("Vin1"), pin("Vin2"), pin("Vb")])).toEqual([
      "Vin1|Vin2",
    ]);
    expect(labels([pin("Vin-"), pin("Vin+")])).toEqual(["Vin+|Vin-"]);
    expect(labels([pin("Vinp"), pin("Vinn")])).toEqual(["Vinp|Vinn"]);
    expect(labels([pin("INP"), pin("INN")])).toEqual(["INP|INN"]);
  });

  it("does not invent a pair", () => {
    expect(labels([pin("Vin"), pin("Vb")])).toEqual([]);
    expect(labels([pin("Vin1")])).toEqual([]);
  });
});

describe("real values", () => {
  it("prints a real gain with rounding residue as a signed number, not a phase", async () => {
    const { pointTextForTest } = await import("./small-signal-panel");
    expect(pointTextForTest({ f: 1000, re: -4.191, im: 5.13e-16 }, "")).toBe(
      "-4.191",
    );
    expect(pointTextForTest({ f: 1000, re: -1, im: -0.5 }, "")).toContain("∠");
  });
});

describe("model parameters", () => {
  it("reads SPICE numbers, signed, with scale and unit letters", () => {
    expect(parseSpiceNumber("200u")).toBeCloseTo(200e-6, 18);
    expect(parseSpiceNumber("-0.45")).toBe(-0.45);
    expect(parseSpiceNumber("1.2meg")).toBe(1.2e6);
    expect(parseSpiceNumber("50V")).toBe(50);
    expect(parseSpiceNumber(" 1e-15 ")).toBe(1e-15);
    expect(parseSpiceNumber("")).toBeNull();
    expect(parseSpiceNumber("abc")).toBeNull();
    expect(parseSpiceNumber("1 2")).toBeNull();
  });

  it("writes defaults the way SPICE cards do", () => {
    expect(formatSpiceNumber(200e-6)).toBe("200u");
    expect(formatSpiceNumber(-0.5)).toBe("-0.5");
    expect(formatSpiceNumber(0.05)).toBe("0.05");
    expect(formatSpiceNumber(100)).toBe("100");
    expect(formatSpiceNumber(1e-15)).toBe("1f");
    expect(formatSpiceNumber(1e-14)).toBe("10f");
    expect(formatSpiceNumber(0)).toBe("0");
  });

  it("rejects values outside a parameter's range", () => {
    expect(modelValue("VTO", "-0.7")).toBe(-0.7);
    expect(modelValue("KP", "0")).toBeNull();
    expect(modelValue("KP", "-1u")).toBeNull();
    expect(modelValue("LAMBDA", "0")).toBe(0);
    expect(modelValue("LAMBDA", "-0.1")).toBeNull();
    expect(modelValue("VAF", "0")).toBe(0);
    expect(modelValue("IS", "0")).toBeNull();
  });

  it("keeps only valid, known parameters as overrides", () => {
    expect(
      modelOverrides({
        nmos: { KP: "300u", VTO: "", LAMBDA: "bad", W: "2u" },
        pmos: { VTO: "-0.4" },
      }),
    ).toEqual({ nmos: { KP: 300e-6 }, pmos: { VTO: -0.4 } });
  });
});
