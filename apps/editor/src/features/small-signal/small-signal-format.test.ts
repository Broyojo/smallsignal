import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type {
  AssumptionTerm,
  SmallSignalElement,
  SmallSignalSource,
  SmallSignalSuggestion,
} from "@icm/small-signal";
import { partKey } from "./small-signal-assumption-store";
import {
  assumptionColumnChange,
  assumptionColumns,
  assumptionRows,
  formatDeviation,
  resultForCircuit,
  formatPercent,
  suggestionText,
  suggestionThreshold,
  withSuggestions,
  countText,
  differentialPairs,
  formatDensity,
  formatDistortion,
  hdText,
  taylorLatex,
  texEscape,
  formatPlain,
  formatSpiceNumber,
  modelOverrides,
  modelTextEdited,
  modelValue,
  noiseBandRange,
  noiseJobKey,
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

describe("countText", () => {
  it("counts symbolic poles and zeros, or says nothing", () => {
    expect(countText(2, 1)).toBe("2 poles, 1 zero");
    expect(countText(1, 0)).toBe("1 pole");
    expect(countText(0, 2)).toBe("2 zeros");
    expect(countText(0, 0)).toBe("");
    expect(countText()).toBe("");
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

describe("noiseJobKey", () => {
  it("waits for the main solve of this very request", () => {
    // The circuit changed and its main solve has not answered: whether the
    // exact forms are over budget is not known yet.
    expect(noiseJobKey(true, "new", "old", null, false)).toBeNull();
    expect(noiseJobKey(true, "new", null, null, false)).toBeNull();
    expect(noiseJobKey(false, "new", "new", null, false)).toBeNull();
    expect(noiseJobKey(true, null, null, null, false)).toBeNull();
    expect(JSON.parse(noiseJobKey(true, "new", "new", [1, 10], true)!)).toEqual(
      ["new", [1, 10], true],
    );
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
      { label: "M1 thermal", fraction: null },
      { label: "others", fraction: 1.0 },
    ]);
    // Flicker at 0 Hz: the unbounded source leads, finite ones follow.
    expect(
      topContributions([source("R1", 0), source("M1", null)], 0, 4),
    ).toEqual([
      { label: "M1 thermal", fraction: null },
      { label: "R1 thermal", fraction: 0 },
    ]);
    // An unbounded omitted bucket is "others: ∞", not dropped as 0.
    expect(topContributions([source("R1", 0.5)], null, 4)).toEqual([
      { label: "R1 thermal", fraction: 0.5 },
      { label: "others", fraction: null },
    ]);
  });

  // The real solver, when its WASM is built (as end-to-end.test.ts).
  const wasmDir = new URL(
    "../../../../../packages/small-signal/wasm/",
    import.meta.url,
  );
  it.skipIf(!existsSync(new URL("smallsignal_wasm_bg.wasm", wasmDir)))(
    "shows the omitted bucket of 34 flicker sources at 0 Hz as others: ∞",
    async () => {
      const wasm = await import(
        /* @vite-ignore */ new URL("smallsignal_wasm.js", wasmDir).href
      );
      wasm.initSync({
        module: readFileSync(new URL("smallsignal_wasm_bg.wasm", wasmDir)),
      });
      const diodes = Array.from(
        { length: 34 },
        (_, k) => `D${k + 1} a 0 dd`,
      ).join("\n");
      const netlist = `flicker\nI1 0 a DC 1m AC 1\n${diodes}\n.model dd d (is=1e-14 kf=1e-15 af=1)\n`;
      const result = JSON.parse(
        wasm.analyze(
          netlist,
          JSON.stringify({ input: "I1", output: "a", freqs: [0], noise: true }),
        ),
      );
      expect(result.error).toBeUndefined();
      const at0 = result.noise.contributors[0];
      expect(at0.sources).toHaveLength(32);
      // 34 shot plus 34 flicker sources.
      expect(at0.omitted.count).toBe(68 - 32);
      expect(at0.omitted.fraction).toBeNull();
      const rows = topContributions(at0.sources, at0.omitted.fraction);
      expect(rows.at(-1)).toEqual({ label: "others", fraction: null });
    },
  );
});

describe("distortion numbers", () => {
  it("writes distortion as a percentage and in dBc", () => {
    expect(formatDistortion(0.0115)).toEqual(["1.15%", "-38.8 dBc"]);
    expect(formatDistortion(2.35e-5)).toEqual(["2.35e-3%", "-92.6 dBc"]);
    expect(formatDistortion(0)).toEqual(["0%", ""]);
    expect(hdText(0.0115)).toBe("1.15%");
    expect(hdText(null, true)).toBe("∞");
    expect(hdText(null)).toBe("—");
  });
});

describe("Taylor coefficient names", () => {
  it("writes them as the solver's symbols do", () => {
    const t = (element: string, current: string, monomial: string) =>
      taylorLatex({ element, current, monomial });
    expect(t("M1", "D", "2g")).toBe("K_{2g,M1}");
    expect(t("M1", "D", "gd")).toBe("K_{g\\,d,M1}");
    expect(t("M1", "D", "2gd")).toBe("K_{2g\\,d,M1}");
    expect(t("Q1", "C", "2be")).toBe("K^{C}_{2be,Q1}");
    expect(t("Q1", "C", "bece")).toBe("K^{C}_{be\\,ce,Q1}");
    expect(t("Q1", "B", "2bece")).toBe("K^{B}_{2be\\,ce,Q1}");
    // As the solver's symbols: K_{2g,M\_load}.
    expect(t("M_load", "D", "2g")).toBe("K_{2g,M\\_load}");
  });

  it("escapes TeX specials as the solver does", () => {
    expect(texEscape("a_b{c}$&#%")).toBe("a\\_b\\{c\\}\\$\\&\\#\\%");
    expect(texEscape("a\\b^c~d")).toBe("a\\backslash b\\hat{}c\\sim d");
  });
});

describe("formatPercent", () => {
  it("writes two digits, never an exponent", () => {
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(4e-4)).toBe("<0.1%");
    expect(formatPercent(0.02)).toBe("2.0%");
    expect(formatPercent(0.984)).toBe("98%");
    expect(formatPercent(1)).toBe("100%");
    expect(formatPercent(15.2)).toBe("1520%");
  });
});

describe("assumption table", () => {
  const NONE = { defaults: {}, parts: {} };
  const assumable = [
    { element: "R1", type: "resistor" as const, terms: ["open", "short"] },
    { element: "M2", type: "nmos" as const, terms: ["ro", "rbs", "rbd"] },
    { element: "M10", type: "nmos" as const, terms: ["ro", "gmb", "rbd"] },
    { element: "M1", type: "nmos" as const, terms: ["ro", "rbs", "rbd"] },
    { element: "M3", type: "pmos" as const, terms: ["ro", "rbd"] },
    { element: "Q1", type: "npn" as const, terms: ["ro", "rpi", "rmu"] },
  ] as Parameters<typeof assumptionRows>[0];
  const elements = [
    { name: "R1", instancePath: ["r1"], kind: "resistor" as const },
    { name: "M1", instancePath: ["x1", "m1"], kind: "nmos" as const },
    { name: "M2", instancePath: ["x1", "m2"], kind: "nmos" as const },
    { name: "M10", instancePath: ["m10"], kind: "nmos" as const },
    { name: "M3", instancePath: ["m3"], kind: "pmos" as const },
    { name: "Q1", instancePath: ["q1"], kind: "npn" as const },
  ];

  it("a type row, then matched groups and parts by name, then passives", () => {
    const rows = assumptionRows(assumable, elements, [["M2", "M1"]], NONE);
    expect(rows.map((row) => [row.scope, row.label])).toEqual([
      ["type", "All NMOS"],
      ["group", "M1 = M2"],
      ["part", "M10"],
      ["type", "All PMOS"],
      ["part", "M3"],
      ["type", "All NPN"],
      ["part", "Q1"],
      ["part", "R1"],
    ]);
    // Only a part of the open Cell can be selected there.
    expect(rows[1]?.members.map((member) => member.instanceId)).toEqual([
      null,
      null,
    ]);
    expect(rows[2]?.members[0]).toMatchObject({
      path: partKey(["m10"]),
      instanceId: "m10",
    });
    // A group of different types, or with a part not drawn, is no row.
    expect(
      assumptionRows(
        assumable,
        elements,
        [
          ["M1", "M3"],
          ["M1", "M9"],
        ],
        NONE,
      ).filter((row) => row.scope === "group"),
    ).toEqual([]);
  });

  it("a matched pair whose members differ is two rows, as the solver solves it", () => {
    const rows = assumptionRows(assumable, elements, [["M1", "M2"]], {
      defaults: {},
      parts: { [partKey(["x1", "m1"])]: { region: "triode" } },
    });
    expect(
      rows.filter((row) => row.type === "nmos").map((row) => row.label),
    ).toEqual(["All NMOS", "M1", "M2", "M10"]);
    // The same choice by default or by each member's own is one row again.
    const shared = assumptionRows(assumable, elements, [["M1", "M2"]], {
      defaults: { nmos: ["ro"] },
      parts: { [partKey(["x1", "m1"])]: { ignore: { ro: true } } },
    });
    expect(shared.some((row) => row.label === "M1 = M2")).toBe(true);
  });

  it("a part whose type changed since the last solve is no row", () => {
    const rows = assumptionRows(
      assumable,
      elements.map((element) =>
        element.name === "M3" ? { ...element, kind: "npn" as const } : element,
      ),
      [],
      NONE,
    );
    expect(rows.some((row) => row.label === "M3")).toBe(false);
  });

  it("a type's column sets every term the type accepts, present here or not", () => {
    // M1 and M2 have no r_bs here (body on the source); another circuit may.
    const bodyTied = assumable.map((element) =>
      element.type === "nmos"
        ? { ...element, terms: element.terms.filter((term) => term !== "rbs") }
        : element,
    );
    const row = assumptionRows(bodyTied, elements, [], NONE)[0]!;
    expect(row.label).toBe("All NMOS");
    expect(assumptionColumnChange(row, "leakage", true, NONE).defaults).toEqual(
      { nmos: ["rbs", "rbd"] },
    );
  });

  it("a stored answer serves only the circuit it answered", () => {
    const result = { assumable: [] };
    expect(resultForCircuit({ circuit: "p/main", result }, "p/main")).toBe(
      result,
    );
    expect(resultForCircuit({ circuit: "p/main", result }, "p/dut")).toBeNull();
    expect(resultForCircuit(null, "p/main")).toBeNull();
  });

  it("one column per term the circuit has, leakage combined, others after", () => {
    const rows = assumptionRows(
      [
        ...assumable,
        { element: "M4", type: "pmos", terms: ["ro", "cgs"] },
      ] as Parameters<typeof assumptionRows>[0],
      [...elements, { name: "M4", instancePath: ["m4"], kind: "pmos" }],
      [],
      NONE,
    );
    expect(assumptionColumns(rows)).toEqual([
      "ro",
      "gmb",
      "rpi",
      "leakage",
      "cgs",
    ]);
  });
});

describe("suggestions", () => {
  const item = (
    elements: string[],
    term: AssumptionTerm,
    type: SmallSignalSuggestion["type"],
    scope: SmallSignalSuggestion["scope"],
  ): SmallSignalSuggestion => ({
    elements,
    term,
    type,
    scope,
    alone: 0.001,
    cumulative: null,
  });

  it("writes small deviations with a digit, never an exponent", () => {
    expect(formatDeviation(0)).toBe("0%");
    expect(formatDeviation(4e-17)).toBe("<0.001%");
    expect(formatDeviation(4.2e-5)).toBe("0.004%");
    expect(formatDeviation(0.0123)).toBe("1.2%");
  });

  it("names a part, a matched group or a whole type", () => {
    expect(suggestionText(item(["M5"], "ro", "nmos", "part"))).toBe("ro M5");
    expect(suggestionText(item(["M3", "M4"], "ro", "pmos", "group"))).toBe(
      "ro M3 = M4",
    );
    expect(suggestionText(item(["M3", "M4", "M6"], "ro", "pmos", "type"))).toBe(
      "ro all PMOS",
    );
    expect(suggestionText(item(["R5"], "open", "resistor", "part"))).toBe(
      "R5 open",
    );
  });

  it("reads the threshold in percent, blank as 1%", () => {
    expect(suggestionThreshold("")).toBe(0.01);
    expect(suggestionThreshold("5")).toBe(0.05);
    expect(suggestionThreshold("0")).toBeNull();
    expect(suggestionThreshold("x")).toBeNull();
  });

  it("applies each member's term where the Assumptions table stores it", () => {
    const elements = [
      { name: "M3", kind: "pmos", instancePath: ["a"] },
      { name: "M4", kind: "pmos", instancePath: ["b"] },
      { name: "C1", kind: "capacitor", instancePath: ["c"] },
    ] as SmallSignalElement[];
    const parts = withSuggestions(
      { [partKey(["c"])]: { ignore: { open: true } } },
      [
        item(["M3", "M4"], "ro", "pmos", "group"),
        item(["C1"], "short", "capacitor", "part"),
      ],
      elements,
      {},
    );
    expect(parts).toEqual({
      [partKey(["a"])]: { ignore: { ro: true } },
      [partKey(["b"])]: { ignore: { ro: true } },
      [partKey(["c"])]: { ignore: { short: true } },
    });
    // A default already neglecting it stores nothing.
    expect(
      withSuggestions({}, [item(["M3"], "ro", "pmos", "part")], elements, {
        pmos: ["ro"],
      }),
    ).toEqual({ [partKey(["a"])]: { ignore: {} } });
  });
});
