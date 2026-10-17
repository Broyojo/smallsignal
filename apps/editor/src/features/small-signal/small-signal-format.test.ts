import { describe, expect, it } from "vitest";
import type { SmallSignalSource } from "@icm/small-signal";
import {
  differentialPairs,
  formatDensity,
  formatPlain,
  formatSpiceNumber,
  modelOverrides,
  modelTextEdited,
  modelValue,
  noiseBandRange,
  parseFrequencies,
  parseSpiceNumber,
  preferredOutput,
  readModelText,
  signalLabel,
  topContributions,
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
  it("reads every SPICE number exactly as the solver does", () => {
    // Cases from crates/smallsignal-core/src/units.rs, plus a, µ and mil.
    const cases: [string, number | null][] = [
      ["10k", 10e3],
      ["1meg", 1e6],
      ["1MEG", 1e6],
      ["2.5u", 2.5e-6],
      ["1e-3", 1e-3],
      ["1.5E3", 1.5e3],
      ["10kohm", 10e3],
      ["1.8v", 1.8],
      ["-3m", -3e-3],
      [".5p", 0.5e-12],
      ["100f", 100e-15],
      ["1a", 1e-18],
      ["1A", 1e-18],
      ["2\u00b5", 2e-6],
      ["10\u03bcF", 10e-6],
      ["10µF", 10e-6],
      ["5mil", 5 * 25.4e-6],
      ["1e5k", 1e8],
      ["1T", 1e12],
      ["3G", 3e9],
      ["10kΩ", 10e3],
      [" 200u ", 200e-6],
      ["1e-400", 0],
      ["abc", null],
      ["1e400", null],
      ["-1e400", null],
      ["1e308k", null],
      [".", null],
      ["", null],
      ["1 k", null],
      ["1,5", null],
      ["1k2", null],
      // Only ASCII case folds, as in the solver's to_ascii_lowercase().
      ["200\u039c", null],
      ["1\u212a", null],
      ["1\u017fec", null],
      ["10\u03c9", null],
      ["\u00a010k\u2003", 10e3],
      ["\u008510k", 10e3],
      ["\ufeff10k", null],
    ];
    for (const [text, value] of cases)
      expect([text, parseSpiceNumber(text)]).toEqual([text, value]);
  });

  it("reads frequency lists with the same grammar", () => {
    expect(parseFrequencies("1k, 10meg 1a")).toEqual([1e3, 1e7, 1e-18]);
    expect(parseFrequencies("-1k, 5")).toEqual([5]);
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
    // Finite but beyond what the solver can represent: N·V_T underflows.
    expect(modelValue("N", "5e-324")).toBeNull();
    expect(modelValue("N", "1")).toBe(1);
    expect(modelValue("KP", "1e300")).toBeNull();
    expect(modelValue("IS", "1e-40")).toBeNull();
    expect(modelValue("VTO", "-101")).toBeNull();
    expect(modelValue("W", "1u")).toBeNull();
    // VAF = 0 means no Early effect; a tiny positive VAF overflows 1/VAF.
    expect(modelValue("VAF", "0")).toBe(0);
    expect(modelValue("VAF", "5e-324")).toBeNull();
    expect(modelValue("VAF", "50")).toBe(50);
  });

  it("reads stored model text defensively", () => {
    expect(readModelText(null)).toEqual({});
    expect(readModelText("not json")).toEqual({});
    expect(readModelText("[1]")).toEqual({});
    expect(
      readModelText(
        JSON.stringify({
          nmos: { KP: 1, VTO: "0.4", W: "2u", LAMBDA: " " },
          pmos: "x",
          bjt: { IS: "1f" },
        }),
      ),
    ).toEqual({ nmos: { VTO: "0.4" } });
  });

  it("counts any typed value, valid or not, as edited", () => {
    expect(modelTextEdited({})).toBe(false);
    expect(modelTextEdited({ nmos: { KP: "  " } })).toBe(false);
    expect(modelTextEdited({ pmos: { KP: "bad" } })).toBe(true);
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

describe("noise band", () => {
  it("takes two frequencies, low then high, within 40 decades", () => {
    expect(noiseBandRange("1, 10meg")).toEqual([1, 1e7]);
    expect(noiseBandRange("")).toBeNull();
    expect(noiseBandRange("10meg, 1")).toBeNull();
    expect(noiseBandRange("0, 1k")).toBeNull();
    expect(noiseBandRange("1a, 1t")).toEqual([1e-18, 1e12]);
    expect(noiseBandRange("1a, 1e30")).toBeNull();
    expect(noiseBandRange("1, 2, 3")).toBeNull();
    expect(noiseBandRange("x, 1, 10")).toBeNull();
    expect(noiseBandRange("-1, 1, 10")).toBeNull();
    expect(noiseBandRange("1, x")).toBeNull();
    expect(noiseBandRange("1k 1meg")).toEqual([1e3, 1e6]);
  });
});

describe("noise values", () => {
  it("writes a density, or a dash where the PSD is not finite", () => {
    expect(formatDensity(3.4969e-17, "V^2/Hz")).toBe("5.913 nV/√Hz");
    expect(formatDensity(1e-24, "A^2/Hz")).toBe("1 pA/√Hz");
    expect(formatDensity(null, "V^2/Hz")).toBe("—");
  });

  it("lists the largest sources and folds the rest, solver-omitted too", () => {
    const source = (element: string, fraction: number | null) => ({
      element,
      kind: "thermal",
      v2: fraction,
      fraction,
    });
    expect(
      topContributions(
        [source("R1", 0.5), source("M1", null), source("R2", 0.3)],
        0.2,
        1,
      ),
    ).toEqual([
      { label: "R1 thermal", fraction: 0.5 },
      { label: "others", fraction: 0.5 },
    ]);
  });
});
