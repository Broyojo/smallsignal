import { describe, expect, it } from "vitest";
import type { SmallSignalSource } from "@icm/small-signal";
import {
  differentialPairs,
  formatPlain,
  matchedSubscript,
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

describe("matchedSubscript", () => {
  it("names a matched group the way its symbols are subscripted", () => {
    expect(matchedSubscript(["M1", "M2"])).toBe("1,2");
    expect(matchedSubscript(["M3", "M4"])).toBe("3,4");
    expect(matchedSubscript(["RD1", "RD2"])).toBe("D1,2");
    expect(matchedSubscript(["M10", "M11"])).toBe("10,11");
    expect(matchedSubscript(["Q1", "Q2", "Q3"])).toBe("1,2,3");
  });
});
