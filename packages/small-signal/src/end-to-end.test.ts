import { existsSync, readFileSync } from "node:fs";
import { parseProject } from "@icm/project-protocol";
import { describe, expect, it } from "vitest";
import { smallSignalNetlist } from "./netlist.js";
import { ASSUMPTION_TERMS } from "./types.js";
import type {
  AssumableElement,
  BjtCapacitances,
  MillerReport,
  MosCapacitances,
  MosOperatingPoint,
  RegionReport,
  Root,
  AssumedQuantity,
  DistortionForm,
  DistortionQuantity,
  DistortionVsFreqPoint,
  NoiseExpression,
  NoiseSource,
  RestoredAssumption,
  RootPair,
  SmallSignalAssumptionReport,
  SmallSignalDistortion,
  SmallSignalExpression,
  SmallSignalNoise,
  SmallSignalQuantity,
  SmallSignalSuggestion,
  SmallSignalSuggestions,
  SmallSignalSweep,
  QuantitySweep,
} from "./types.js";

// Runs the real solver when the WASM has been built (wasm-pack, see
// crates/README.md); skipped otherwise.
const wasmDir = new URL("../wasm/", import.meta.url);
const built = existsSync(new URL("smallsignal_wasm_bg.wasm", wasmDir));

describe.skipIf(!built)("drawing → netlist → solver", () => {
  it("gives −gm(ro ∥ R1) for the common-source drawing with a VDD symbol", async () => {
    const wasm = await import(
      /* @vite-ignore */ new URL("smallsignal_wasm.js", wasmDir).href
    );
    wasm.initSync({
      module: readFileSync(new URL("smallsignal_wasm_bg.wasm", wasmDir)),
    });
    const project = parseProject(
      readFileSync(
        new URL(
          "../test-fixtures/cs-vdd-pin-wired.icproj.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const netlist = smallSignalNetlist(project)!;
    const result = JSON.parse(
      wasm.analyze(
        netlist.text,
        JSON.stringify({ input: "V1", output: "Vout", rout: true }),
      ),
    );
    expect(result.error).toBeUndefined();
    expect(result.warnings).toEqual([]);
    expect(result.op.devices.M1.region).toBe("saturation");
    // What the panel shows: the leakage-free form, indistinguishable at the
    // printed precision; the exact form keeps the drain junction.
    expect(result.gain.display.latex).toBe(
      "-g_{m1} \\left(r_{o1} \\parallel R_{1}\\right)",
    );
    expect(result.gain.display.maxRelError).toBeLessThan(1e-6);
    expect(result.gain.exact.latex).toContain("r_{bd1}");
    // A bare parallel group needs no parentheses.
    expect(result.rout.display.latex).toBe("r_{o1} \\parallel R_{1}");
    // The same number from the operating point the solver reports. The hand
    // formula leaves out the drain junction's gmin-level conductance
    // (1e-12 S), which the solver keeps: about 1e-8 relative.
    const m1 = result.op.devices.M1;
    const hand = -m1.gm / (m1.gds + 1 / 10e3);
    expect(Math.abs(result.gain.values[0].re / hand - 1)).toBeLessThan(1e-6);
  });
});

const SIMPLIFIED_KEYS = allKeys<SmallSignalExpression>()([
  "num",
  "den",
  "latex",
  "terms",
  "maxRelError",
  "same",
  "assumption",
  "latexExpanded",
  "fullModelError",
  "method",
  "named",
  "leadingOrder",
  "none",
  "tolerance",
] as const);

describe.skipIf(!built)("a CMOS inverter with M1 in triode", () => {
  it("names M1's channel R_on and assumes r_o2 → ∞ for its ≈ forms", async () => {
    const wasm = await import(
      /* @vite-ignore */ new URL("smallsignal_wasm.js", wasmDir).href
    );
    wasm.initSync({
      module: readFileSync(new URL("smallsignal_wasm_bg.wasm", wasmDir)),
    });
    const project = parseProject(
      readFileSync(
        new URL(
          "../test-fixtures/cmos-inverter-triode.icproj.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const netlist = smallSignalNetlist(project)!;
    const solve = (approx?: string) =>
      JSON.parse(
        wasm.analyze(
          netlist.text,
          JSON.stringify({
            input: "VIN",
            output: "out",
            rout: true,
            ...(approx ? { approx } : {}),
          }),
        ),
      );
    const result = solve();
    expect(result.error).toBeUndefined();
    expect(result.op.devices.M1.region).toBe("triode");
    expect(result.op.devices.M2.region).toBe("saturation");
    expect(
      result.params.find((p: { name: string }) => p.name === "ron_M1").latex,
    ).toBe("R_{on1}");
    for (const [quantity, form] of [
      ["gain", "-R_{on1} \\left(g_{m2} + g_{m1}\\right)"],
      ["rout", "R_{on1}"],
    ] as const) {
      const simplified = result[quantity].simplified;
      expect(simplified.latex).toBe(form);
      expect(simplified.method).toBe("named");
      expect(simplified.assumption).toBe("r_o2 → ∞");
      expect(simplified.named).toEqual([
        { elements: ["M2"], term: "ro", latex: "r_{o2} \\to \\infty" },
      ]);
      expect(simplified.maxRelError).toBeLessThan(0.005);
      expect(
        Object.keys(simplified).filter(
          (key) => !(SIMPLIFIED_KEYS as readonly string[]).includes(key),
        ),
      ).toEqual([]);
    }
    // No r_o to neglect on a triode device.
    const m1 = (result.assumable as AssumableElement[]).find(
      (entry) => entry.element === "M1",
    )!;
    expect(m1.terms).not.toContain("ro");
    // Smallest terms: the earlier form, the same here, with no label.
    const terms = solve("terms");
    expect(terms.gain.simplified.method).toBe("terms");
    expect(terms.gain.simplified.latex).toBe(result.gain.simplified.latex);
    expect(terms.gain.simplified.assumption).toBeUndefined();
  });
});

/**
 * Every example the editor ships, through drawing → netlist → solver, with
 * outcomes reviewed by hand. A drawing must give a correct result or a
 * clear refusal, never a silent wrong number.
 */
describe.skipIf(!built)("every shipped example", () => {
  const examples = new URL(
    "../../../apps/editor/src/examples/",
    import.meta.url,
  );
  const run = async (name: string, chosenOutput?: string) => {
    const wasm = await import(
      /* @vite-ignore */ new URL("smallsignal_wasm.js", wasmDir).href
    );
    wasm.initSync({
      module: readFileSync(new URL("smallsignal_wasm_bg.wasm", wasmDir)),
    });
    const netlist = smallSignalNetlist(
      parseProject(
        readFileSync(new URL(`${name}.icproj.json`, examples), "utf8"),
      ),
    )!;
    expect(netlist.unconnected).toEqual([]);
    expect(netlist.noDcPath).toEqual([]);
    const input = (
      netlist.sources.find((s) => /in/iu.test(s.pin ?? s.name)) ??
      netlist.sources[0]
    )?.name;
    const output =
      chosenOutput ??
      netlist.nets.find(
        (net) => /out/iu.test(net) && !netlist.supplies.includes(net),
      );
    const result = JSON.parse(
      wasm.analyze(
        netlist.text,
        JSON.stringify({
          input,
          output,
          rin: true,
          rout: true,
          verify: true,
          symbolic: netlist.unknownBias.length > 0,
        }),
      ),
    );
    expect(result.error).toBeUndefined();
    expect(result.verify.kcl).toBe(true);
    return { netlist, result };
  };
  const regions = (result: {
    op: { devices: Record<string, { region: string }> };
  }) => Object.values(result.op.devices).map((device) => device.region);

  it("simulation-common-source: −gm(ro ∥ RD) with its output pole", async () => {
    const { result } = await run("simulation-common-source");
    expect(result.gain.display.latex).toBe(
      "-\\frac{g_{m1} \\left(r_{o1} \\parallel R_{D}\\right)}{1 + C_{L} \\left(r_{o1} \\parallel R_{D}\\right) s}",
    );
    expect(result.gain.display.maxRelError).toBeLessThan(1e-6);
    expect(regions(result)).toEqual(["saturation"]);
    expect(result.warnings).toEqual([]);
  });

  it("simulation-rc and simulation-rlc: the first- and second-order low-pass", async () => {
    expect((await run("simulation-rc")).result.gain.exact.latex).toBe(
      "\\frac{1}{1 + R_{1} C_{1} s}",
    );
    expect((await run("simulation-rlc")).result.gain.exact.latex).toBe(
      "\\frac{1}{1 + R_{1} C_{1} s + C_{1} L_{1} s^{2}}",
    );
  });

  it.each(["simulation-ota", "five-transistor-ota-sky130"])(
    "%s: every transistor saturated, names as drawn",
    async (name) => {
      const { result } = await run(name);
      expect(new Set(regions(result))).toEqual(new Set(["saturation"]));
      expect(result.warnings).toEqual([]);
      expect(result.gain.check.ok).toBe(true);
      expect(result.gain.exact.latex ?? result.gain.simplified.latex).toContain(
        "g_{m1}",
      );
    },
  );

  it("textbook drawings without values give hand analysis", async () => {
    for (const name of [
      "current-mirror-loaded-differential-pair",
      "fully-differential-two-stage-op-amp",
      "two-stage-op-amp",
    ]) {
      const { netlist, result } = await run(name);
      expect(netlist.unknownBias.length).toBeGreaterThan(0);
      expect(result.symbolic).toBe(true);
      expect(result.gain.exact.terms.num).toBeGreaterThan(0);
    }
  });

  it("common-source-amplifier: its drain is drawn on ground, so only the gate node responds", async () => {
    const { netlist, result } = await run("common-source-amplifier", "net0");
    expect(netlist.nets).toEqual(["0", "VDD", "net0", "net1"]);
    // RS into CGS ∥ CGD (the drain is ground): a first-order low-pass.
    expect(result.gain.exact.latex).toBe(
      "\\frac{1}{1 + \\left(R_{S} C_{GD} + R_{S} C_{GS}\\right) s}",
    );
  });
});

/**
 * Every key of `T`, checked at compile time: the list must name them all.
 * The runtime check below then fails when the solver emits a field the
 * TypeScript contract does not declare.
 */
function allKeys<T>() {
  return <K extends readonly (keyof T)[]>(
    keys: K & ([Exclude<keyof T, K[number]>] extends [never] ? unknown : never),
  ) => keys;
}

type LowFreq = Exclude<
  SmallSignalNoise["inputLowFreq"],
  { unavailable: string }
>;
type Integrated = NonNullable<SmallSignalNoise["integrated"]>;

const NOISE_KEYS = allKeys<SmallSignalNoise>()([
  "temperature",
  "inputUnit",
  "outputUnit",
  "sources",
  "output",
  "input",
  "contributors",
  "integrated",
  "inputLowFreq",
] as const);
const LOW_FREQ_KEYS = allKeys<LowFreq>()([
  "unit",
  "exact",
  "display",
  "simplified",
  "currents",
  "check",
] as const);
const EXPRESSION_KEYS = allKeys<NoiseExpression>()([
  "latex",
  "value",
  "thermal",
  "shot",
  "terms",
  "relError",
  "same",
  "leakageMatters",
  "method",
  "assumption",
  "tolerance",
  "fullModelError",
] as const);
const INTEGRATED_KEYS = allKeys<Integrated>()([
  "fLow",
  "fHigh",
  "outputRms",
  "inputRms",
  "outputV2",
  "inputV2",
  "evaluations",
  "relError",
  "converged",
  "unavailable",
] as const);
const SOURCE_KEYS = allKeys<NoiseSource>()([
  "element",
  "kind",
  "psd",
  "white",
  "flicker",
  "ignored",
] as const);

describe.skipIf(!built)(
  "the solver's JSON matches the TypeScript contract",
  () => {
    it("noise: every emitted field is declared", async () => {
      const wasm = await import(
        /* @vite-ignore */ new URL("smallsignal_wasm.js", wasmDir).href
      );
      wasm.initSync({
        module: readFileSync(new URL("smallsignal_wasm_bg.wasm", wasmDir)),
      });
      const project = parseProject(
        readFileSync(
          new URL(
            "../test-fixtures/cs-vdd-pin-wired.icproj.json",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      const netlist = smallSignalNetlist(project)!;
      const result = JSON.parse(
        wasm.analyze(
          netlist.text,
          JSON.stringify({
            input: "V1",
            output: "Vout",
            noise: true,
            noiseBand: [1, 1e7],
          }),
        ),
      );
      expect(result.error).toBeUndefined();
      const declared = (value: object, keys: readonly string[]) =>
        expect(Object.keys(value).filter((key) => !keys.includes(key))).toEqual(
          [],
        );
      const noise = result.noise;
      declared(noise, NOISE_KEYS);
      declared(noise.inputLowFreq, LOW_FREQ_KEYS);
      for (const form of ["exact", "display", "simplified"])
        declared(noise.inputLowFreq[form], EXPRESSION_KEYS);
      declared(noise.integrated, INTEGRATED_KEYS);
      for (const source of noise.sources) declared(source, SOURCE_KEYS);
      for (const point of noise.contributors)
        declared(point, ["f", "sources", "omitted"]);
      for (const point of [...noise.input, ...noise.output])
        declared(point, ["f", "v2"]);
    });
  },
);

const GAIN_KEYS = allKeys<SmallSignalQuantity>()([
  "unit",
  "infinite",
  "exact",
  "display",
  "leakageMatters",
  "simplified",
  "values",
  "poles",
  "zeros",
  "poleCount",
  "zeroCount",
  "check",
  "skipped",
  "assumed",
  "sweep",
] as const);

const SWEEP_KEYS = allKeys<SmallSignalSweep>()([
  "fLow",
  "fHigh",
  "perDecade",
  "f",
  "unity",
  "bandwidth",
] as const);
const QUANTITY_SWEEP_KEYS = allKeys<QuantitySweep>()([
  "full",
  "approx",
  "assumed",
] as const);

describe.skipIf(!built)("the gain JSON matches the TypeScript contract", () => {
  it.each([
    ["symbolic", "", 2, 1],
    ["numeric", " 1k", 2, 1],
  ])(
    "%s: poles and zeros are counted, every field declared",
    async (_, value, poles, zeros) => {
      const wasm = await import(
        /* @vite-ignore */ new URL("smallsignal_wasm.js", wasmDir).href
      );
      wasm.initSync({
        module: readFileSync(new URL("smallsignal_wasm_bg.wasm", wasmDir)),
      });
      // RC low-pass into an RC high-pass: two poles, one zero at 0 Hz.
      const net = [
        "rc",
        "VIN in 0 AC 1",
        `R1 in a${value}`,
        `C1 a 0${value ? " 1n" : ""}`,
        `C2 a out${value ? " 1n" : ""}`,
        `R2 out 0${value}`,
      ].join("\n");
      const result = JSON.parse(
        wasm.analyze(net, JSON.stringify({ input: "VIN", output: "out" })),
      );
      expect(result.error).toBeUndefined();
      expect(result.symbolic).toBe(!value);
      const gain = result.gain;
      expect(
        Object.keys(gain).filter(
          (key) => !(GAIN_KEYS as readonly string[]).includes(key),
        ),
      ).toEqual([]);
      expect(gain.poleCount).toBe(poles);
      expect(gain.zeroCount).toBe(zeros);
      expect(gain.poles).toHaveLength(value ? poles : 0);
    },
  );
});

type Coefficient = SmallSignalDistortion["coefficients"][number];
const DISTORTION_KEYS = allKeys<SmallSignalDistortion>()([
  "coefficients",
  "hd2",
  "hd3",
  "iip3",
  "amplitude",
  "inputUnit",
  "nonlinear",
  "order",
  "vsFreq",
  "symbols",
  "taylor",
  "check",
  "omissionError",
] as const);
const FORM_KEYS = allKeys<DistortionForm>()([
  "latex",
  "value",
  "plain",
  "terms",
  "relError",
  "same",
  "leakageMatters",
  "method",
  "tolerance",
  "fullModelError",
] as const);
const QUANTITY_KEYS = allKeys<DistortionQuantity>()([
  ...FORM_KEYS,
  "display",
  "simplified",
  "skipped",
  "nested",
] as const);
const VS_FREQ_KEYS = allKeys<DistortionVsFreqPoint>()([
  "f",
  "hd2",
  "hd3",
  "hd2Infinite",
  "hd3Infinite",
] as const);
const COEFFICIENT_KEYS = allKeys<Coefficient>()([
  ...QUANTITY_KEYS,
  "order",
  "numeric",
] as const);

describe.skipIf(!built)(
  "the distortion JSON matches the TypeScript contract",
  () => {
    it.each([
      ["order 3", { order: 3 }],
      ["order 2", { order: 2 }],
      ["closed forms over budget", { order: 3, maxTerms: 4 }],
    ])("%s: every field is present and declared", async (_, options) => {
      const wasm = await import(
        /* @vite-ignore */ new URL("smallsignal_wasm.js", wasmDir).href
      );
      wasm.initSync({
        module: readFileSync(new URL("smallsignal_wasm_bg.wasm", wasmDir)),
      });
      const project = parseProject(
        readFileSync(
          new URL(
            "../test-fixtures/cs-vdd-pin-wired.icproj.json",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      const netlist = smallSignalNetlist(project)!;
      const result = JSON.parse(
        wasm.analyze(
          netlist.text,
          JSON.stringify({
            input: "V1",
            output: "Vout",
            freqs: [1e3, 1e6],
            nonlinear: ["M1"],
            amplitude: 0.01,
            ...options,
          }),
        ),
      );
      expect(result.error).toBeUndefined();
      const distortion = result.distortion;
      // Required fields are always there (null or empty when unavailable)...
      expect(Object.keys(distortion).sort()).toEqual(
        [...DISTORTION_KEYS].sort(),
      );
      // ...and nothing undeclared is.
      const declared = (value: object | null, keys: readonly string[]) => {
        if (value)
          expect(
            Object.keys(value).filter((key) => !keys.includes(key)),
          ).toEqual([]);
      };
      for (const coefficient of distortion.coefficients) {
        declared(coefficient, COEFFICIENT_KEYS);
        declared(coefficient.display, FORM_KEYS);
        declared(coefficient.simplified, FORM_KEYS);
      }
      for (const name of ["hd2", "hd3", "iip3"]) {
        declared(distortion[name], QUANTITY_KEYS);
        declared(distortion[name]?.display, FORM_KEYS);
        declared(distortion[name]?.simplified, FORM_KEYS);
      }
      for (const point of distortion.vsFreq) declared(point, VS_FREQ_KEYS);
    });
  },
);

describe.skipIf(!built)(
  "gain, Zin and Zout match the TypeScript contract",
  () => {
    const solve = async (fixture: string, request: object) => {
      const wasm = await import(
        /* @vite-ignore */ new URL("smallsignal_wasm.js", wasmDir).href
      );
      wasm.initSync({
        module: readFileSync(new URL("smallsignal_wasm_bg.wasm", wasmDir)),
      });
      const netlist = smallSignalNetlist(
        parseProject(
          readFileSync(
            new URL(`../test-fixtures/${fixture}.icproj.json`, import.meta.url),
            "utf8",
          ),
        ),
      )!;
      return JSON.parse(wasm.analyze(netlist.text, JSON.stringify(request)));
    };
    const declared = (value: object) =>
      expect(
        Object.keys(value).filter(
          (key) => !(GAIN_KEYS as readonly string[]).includes(key),
        ),
      ).toEqual([]);

    it.each([
      ["exact forms", {}],
      ["over the term budget", { maxTerms: 1 }],
    ])("%s: every field is declared", async (_, options) => {
      const result = await solve("cs-vdd-pin-wired", {
        input: "V1",
        output: "Vout",
        rin: true,
        rout: true,
        ...options,
      });
      expect(result.error).toBeUndefined();
      for (const name of ["gain", "rin", "rout"]) declared(result[name]);
    });

    it("the sweep: every field declared, one point per swept frequency", async () => {
      const result = await solve("two-stage-miller-ota", {
        input: "VINP",
        inputNeg: "VINN",
        output: "vout",
        rin: true,
        rout: true,
        sweep: {},
        assume: { miller: [{ element: "CC" }] },
      });
      expect(result.error).toBeUndefined();
      expect(Object.keys(result.sweep).sort()).toEqual([...SWEEP_KEYS].sort());
      const n = result.sweep.f.length;
      // Whole decades around the poles (1.1 kHz to 132 MHz) and 1 kHz.
      expect(result.sweep.fLow).toBe(100);
      expect(result.sweep.fHigh).toBe(1e10);
      // 20 per decade, plus the poles, zeros, unity and −3 dB in the band,
      // each exactly.
      const { unity, bandwidth } = result.sweep;
      expect(unity).toBeGreaterThan(100);
      expect(bandwidth).toBeGreaterThan(100);
      expect(bandwidth).toBeLessThan(unity);
      expect(result.sweep.f).toContain(unity);
      expect(result.sweep.f).toContain(bandwidth);
      for (const pole of result.gain.poles) {
        const f = Math.hypot(pole.re, pole.im);
        if (f >= 100 && f <= 1e10)
          expect(
            Math.min(...result.sweep.f.map((x: number) => Math.abs(x / f - 1))),
          ).toBeLessThan(1e-6);
      }
      expect(n).toBeGreaterThan(8 * 20 + 1);
      expect([...result.sweep.f].sort((a, b) => a - b)).toEqual(result.sweep.f);
      for (const name of ["gain", "rout"]) {
        const q = result[name];
        declared(q);
        expect(Object.keys(q.sweep).sort()).toEqual(
          [...QUANTITY_SWEEP_KEYS].sort(),
        );
        for (const key of QUANTITY_SWEEP_KEYS)
          if (q.sweep[key]) expect(q.sweep[key]).toHaveLength(n);
      }
      // Zin looks into a gate: unbounded at every frequency, nothing swept.
      expect(result.rin.infinite).toBe(true);
      expect(result.rin.sweep).toBeUndefined();
      // Nothing reactive: no sweep at all.
      const flat = await solve("cmos-inverter-triode", {
        input: "VIN",
        output: "out",
        sweep: {},
      });
      expect(flat.sweep).toBeNull();
      expect(flat.gain.sweep).toBeUndefined();
    });

    it("a 25-BJT op-amp: numbers without formulas, fast", async () => {
      const started = Date.now();
      const result = await solve("bjt-op-amp", {
        input: "VINP",
        inputNeg: "VINN",
        mode: "differential",
        output: "OUT",
        freqs: [0],
        rin: true,
        rout: true,
      });
      expect(result.error).toBeUndefined();
      for (const name of ["gain", "rin", "rout"]) {
        declared(result[name]);
        expect(result[name].skipped).toBe(
          "too large for the exact closed form",
        );
        expect(result[name].exact).toBeNull();
      }
      // ngspice-47 at this bias: open-loop gain 68,823, Zout 113 Ω, one pole
      // at -10.61 Hz (the 30 pF compensation).
      expect(result.gain.values[0].re).toBeCloseTo(68824, -1);
      expect(result.rout.values[0].re).toBeCloseTo(113.04, 1);
      expect(result.gain.poles).toHaveLength(1);
      expect(result.gain.poles[0].re).toBeCloseTo(-10.608, 2);
      expect(Object.keys(result.op.devices)).toHaveLength(25);
      expect(Date.now() - started).toBeLessThan(15_000);
    });

    it("the op-amp with device capacitances: past 128 parameters, numeric", async () => {
      const wasm = await import(
        /* @vite-ignore */ new URL("smallsignal_wasm.js", wasmDir).href
      );
      wasm.initSync({
        module: readFileSync(new URL("smallsignal_wasm_bg.wasm", wasmDir)),
      });
      const netlist = smallSignalNetlist(
        parseProject(
          readFileSync(
            new URL("../test-fixtures/bjt-op-amp.icproj.json", import.meta.url),
            "utf8",
          ),
        ),
        {
          models: {
            npn: { CJE: 1e-12, CJC: 0.5e-12, TF: 0.35e-9 },
            pnp: { CJE: 0.3e-12, CJC: 1e-12, TF: 30e-9 },
          },
        },
      )!;
      const started = Date.now();
      const result = JSON.parse(
        wasm.analyze(
          netlist.text,
          JSON.stringify({
            input: "VINP",
            inputNeg: "VINN",
            mode: "differential",
            output: "OUT",
            freqs: [1, 1e6],
            rin: true,
            rout: true,
          }),
        ),
      );
      expect(result.error).toBeUndefined();
      expect(result.params.length).toBeGreaterThan(128);
      for (const name of ["gain", "rin", "rout"]) {
        declared(result[name]);
        expect(result[name].skipped).toBe(
          "too large for the exact closed form",
        );
      }
      // Each BJT's C_π and C_μ add poles; the 30 pF one stays dominant.
      expect(result.gain.poles.length).toBeGreaterThan(10);
      const slowest = Math.min(
        ...result.gain.poles.map((p: Root) => Math.hypot(p.re, p.im)),
      );
      expect(slowest).toBeCloseTo(10.6, 0);
      for (const device of Object.values(result.op.devices) as {
        caps: object;
      }[])
        expect(Object.keys(device.caps).sort()).toEqual(
          [...BJT_CAP_KEYS].sort(),
        );
      expect(Date.now() - started).toBeLessThan(15_000);
    });

    it("device capacitances: every op field is declared", async () => {
      const wasm = await import(
        /* @vite-ignore */ new URL("smallsignal_wasm.js", wasmDir).href
      );
      wasm.initSync({
        module: readFileSync(new URL("smallsignal_wasm_bg.wasm", wasmDir)),
      });
      const netlist = smallSignalNetlist(
        parseProject(
          readFileSync(
            new URL(
              "../test-fixtures/cs-vdd-pin-wired.icproj.json",
              import.meta.url,
            ),
            "utf8",
          ),
        ),
        { models: { nmos: { TOX: 20e-9, CGDO: 3e-10, CBD: 1e-15 } } },
      )!;
      const result = JSON.parse(
        wasm.analyze(
          netlist.text,
          JSON.stringify({ input: "V1", output: "Vout" }),
        ),
      );
      expect(result.error).toBeUndefined();
      const m1 = result.op.devices.M1 as MosOperatingPoint;
      expect(Object.keys(m1.caps).sort()).toEqual([...MOS_CAP_KEYS].sort());
      expect(m1.caps.cgs).toBeGreaterThan(0);
      const value = (name: string) =>
        result.params.find((p: { name: string }) => p.name === name)?.value;
      // Saturated: C_gd is CGDO·W alone, as the parameter list has it.
      expect(m1.caps.cgd).toBeGreaterThan(0);
      expect(value("cgd_M1")).toBe(m1.caps.cgd);
      expect(value("cbd_M1")).toBeGreaterThan(0);
    });
  },
);

const MOS_CAP_KEYS = allKeys<MosCapacitances>()([
  "cgs",
  "cgd",
  "cgb",
  "cbd",
  "cbs",
]);
const BJT_CAP_KEYS = allKeys<BjtCapacitances>()(["cpi", "cmu", "csub", "cx"]);

const ASSUMED_KEYS = allKeys<AssumedQuantity>()([
  "values",
  "relError",
  "maxRelError",
  "infinite",
  "resolution",
  "restored",
  "poles",
  "zeros",
] as const);
const ROOT_PAIR_KEYS = allKeys<RootPair>()([
  "assumed",
  "full",
  "relError",
] as const);
const REPORT_KEYS = allKeys<SmallSignalAssumptionReport>()([
  "applied",
  "absent",
  "regions",
  "miller",
] as const);
const REGION_KEYS = allKeys<RegionReport>()([
  "element",
  "assumed",
  "actual",
  "effect",
  "linearized",
] as const);
const MILLER_KEYS = allKeys<MillerReport>()([
  "element",
  "term",
  "latex",
  "symbol",
  "k",
  "definition",
] as const);
const DEFINITION_KEYS = allKeys<NonNullable<MillerReport["definition"]>>()([
  "latex",
  "num",
  "den",
] as const);
const RESTORED_KEYS = allKeys<RestoredAssumption>()([
  "element",
  "term",
  "latex",
] as const);
const ASSUMABLE_KEYS = allKeys<AssumableElement>()([
  "element",
  "type",
  "terms",
  "miller",
] as const);

describe.skipIf(!built)("assumptions match the TypeScript contract", () => {
  it("every assumption field is present and declared", async () => {
    const wasm = await import(
      /* @vite-ignore */ new URL("smallsignal_wasm.js", wasmDir).href
    );
    wasm.initSync({
      module: readFileSync(new URL("smallsignal_wasm_bg.wasm", wasmDir)),
    });
    const netlist = smallSignalNetlist(
      parseProject(
        readFileSync(
          new URL(
            "../test-fixtures/cs-vdd-pin-wired.icproj.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ),
    )!;
    const plain = { input: "V1", output: "Vout", rin: true, rout: true };
    const request = {
      ...plain,
      freqs: [1e3, 1e6],
      noise: true,
      nonlinear: ["M1"],
      assume: {
        ignore: [
          { element: "M1", term: "ro" },
          { element: "M1", term: "gmb" },
        ],
        regions: [{ element: "M1", region: "saturation" }],
      },
    };
    const result = JSON.parse(
      wasm.analyze(netlist.text, JSON.stringify(request)),
    );
    expect(result.error).toBeUndefined();
    const keys = (value: object, want: readonly string[]) =>
      expect(Object.keys(value).sort()).toEqual([...want].sort());
    const declared = (value: object, allowed: readonly string[]) =>
      expect(
        Object.keys(value).filter((key) => !allowed.includes(key)),
      ).toEqual([]);
    keys(result.assumptions, REPORT_KEYS);
    expect(result.assumptions.applied).toEqual([
      { element: "M1", term: "ro", latex: "r_{o1} \\to \\infty" },
    ]);
    expect(result.assumptions.absent).toEqual([{ element: "M1", term: "gmb" }]);
    expect(result.assumptions.regions).toEqual([
      {
        element: "M1",
        assumed: "saturation",
        actual: "saturation",
        effect: "same",
      },
    ]);
    // Triode cannot hold at a saturated bias: refused, the bias's model
    // kept, with every field declared.
    const triode = JSON.parse(
      wasm.analyze(
        netlist.text,
        JSON.stringify({
          ...plain,
          assume: { regions: [{ element: "M1", region: "triode" }] },
        }),
      ),
    );
    for (const region of triode.assumptions.regions)
      declared(region, REGION_KEYS);
    expect(triode.assumptions.regions[0].effect).toBe("refused");
    for (const element of result.assumable) {
      keys(element, ASSUMABLE_KEYS);
      // The panel only sends terms its type accepts.
      expect(
        ASSUMPTION_TERMS[element.type as AssumableElement["type"]],
      ).toEqual(expect.arrayContaining(element.terms));
    }
    for (const name of ["gain", "rin", "rout"]) {
      const q = result[name];
      declared(q, GAIN_KEYS);
      declared(q.assumed, ASSUMED_KEYS);
      for (const pair of [...q.assumed.poles, ...q.assumed.zeros])
        keys(pair, ROOT_PAIR_KEYS);
      for (const r of q.assumed.restored) keys(r, RESTORED_KEYS);
      // Zin looks into a gate: infinite, with only an exact form.
      for (const form of ["exact", "display", "simplified"])
        if (q[form]) expect(q[form]).toHaveProperty("fullModelError");
    }
    expect(result.rin.assumed.infinite).toBe(true);
    // ro → ∞ with a resistor load: −g_m R_1, a few percent from the full
    // model, whose values are unchanged.
    expect(result.gain.display.latex).toBe("-g_{m1} R_{1}");
    expect(result.gain.assumed.maxRelError).toBeGreaterThan(0.001);
    const full = JSON.parse(
      wasm.analyze(
        netlist.text,
        JSON.stringify({ ...plain, freqs: [1e3, 1e6] }),
      ),
    );
    expect(result.gain.values).toEqual(full.gain.values);
    for (const source of result.noise.sources) declared(source, SOURCE_KEYS);
    for (const form of ["exact", "display", "simplified"])
      expect(result.noise.inputLowFreq[form]).toHaveProperty("fullModelError");
    const ignored = result.distortion.taylor.filter(
      (t: { ignored?: true }) => t.ignored,
    );
    expect(ignored.length).toBeGreaterThan(0);
    for (const t of ignored) expect(t.monomial).toContain("d");
    for (const c of result.distortion.coefficients)
      expect(c).toHaveProperty("fullModelError");
  });

  it("a Miller split's report is present and declared", async () => {
    const wasm = await import(
      /* @vite-ignore */ new URL("smallsignal_wasm.js", wasmDir).href
    );
    wasm.initSync({
      module: readFileSync(new URL("smallsignal_wasm_bg.wasm", wasmDir)),
    });
    // Two transconductance stages, CC across the second: K = −g₂R₂ = −100.
    const netlist = [
      "two stage",
      "VIN in 0 DC 0 AC 1",
      "G1 n1 0 in 0 1m",
      "R1 n1 0 100k",
      "G2 out 0 n1 0 2m",
      "R2 out 0 50k",
      "CL out 0 2p",
      "CC n1 out 1p",
    ].join("\n");
    const result = JSON.parse(
      wasm.analyze(
        netlist,
        JSON.stringify({
          input: "VIN",
          output: "out",
          rout: true,
          freqs: [1e3, 1e6],
          assume: { miller: [{ element: "CC" }] },
        }),
      ),
    );
    expect(result.error).toBeUndefined();
    const keys = (value: object, want: readonly string[]) =>
      expect(Object.keys(value).sort()).toEqual([...want].sort());
    keys(result.assumptions, REPORT_KEYS);
    expect(result.assumptions.applied).toEqual([]);
    const [split] = result.assumptions.miller;
    keys(split, MILLER_KEYS);
    keys(split.definition, DEFINITION_KEYS);
    expect(split).toMatchObject({
      element: "CC",
      term: null,
      latex: "C_{C}",
      symbol: "K_{CC}",
    });
    expect(split.k).toBeCloseTo(-100, 9);
    expect(split.definition.latex).toBe("-G_{2} R_{2}");
    for (const element of result.assumable) keys(element, ASSUMABLE_KEYS);
    const of = (name: string) =>
      result.assumable.find(
        (e: AssumableElement) => e.element === name,
      ) as AssumableElement;
    expect(of("CC").miller).toEqual([null]);
    expect(of("CL").miller).toEqual([]);
    // K is a parameter with its value; the forms are over C_C and K.
    expect(
      result.params.find((p: { name: string }) => p.name === "K_CC").value,
    ).toBe(split.k);
    expect(result.gain.exact.latex).toContain("K_{CC}");
    expect(result.gain.exact).toHaveProperty("fullModelError");
  });
});

const SUGGESTIONS_KEYS = allKeys<SmallSignalSuggestions>()([
  "quantity",
  "threshold",
  "base",
  "items",
  "combined",
  "candidates",
  "evaluated",
  "unbounded",
  "capped",
] as const);
const SUGGESTION_KEYS = allKeys<SmallSignalSuggestion>()([
  "elements",
  "term",
  "type",
  "scope",
  "alone",
  "cumulative",
] as const);

describe.skipIf(!built)("suggestions match the TypeScript contract", () => {
  it("every suggestions field is present and declared", async () => {
    const wasm = await import(
      /* @vite-ignore */ new URL("smallsignal_wasm.js", wasmDir).href
    );
    wasm.initSync({
      module: readFileSync(new URL("smallsignal_wasm_bg.wasm", wasmDir)),
    });
    const netlist = smallSignalNetlist(
      parseProject(
        readFileSync(
          new URL(
            "../test-fixtures/cs-vdd-pin-wired.icproj.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ),
    )!;
    const result = JSON.parse(
      wasm.analyze(
        netlist.text,
        JSON.stringify({
          input: "V1",
          output: "Vout",
          rin: true,
          rout: true,
          suggest: { quantity: "gain", threshold: 0.5 },
        }),
      ),
    );
    expect(result.error).toBeUndefined();
    const keys = (value: object, want: readonly string[]) =>
      expect(Object.keys(value).sort()).toEqual([...want].sort());
    const s = result.suggestions;
    keys(s, SUGGESTIONS_KEYS);
    expect(s.quantity).toBe("gain");
    expect(s.threshold).toBe(0.5);
    expect(s.base).toBe(0);
    expect(s.capped).toBeNull();
    expect(s.items.length).toBeGreaterThan(0);
    for (const item of s.items) {
      keys(item, SUGGESTION_KEYS);
      expect(item.alone).toBeLessThanOrEqual(0.5);
      expect(ASSUMPTION_TERMS[item.type as AssumableElement["type"]]).toContain(
        item.term,
      );
    }
    // r_o of the only transistor: a few percent of −g_m(r_o ∥ R_1).
    expect(
      s.items.some(
        (item: SmallSignalSuggestion) =>
          item.term === "ro" && item.elements.join() === "M1",
      ),
    ).toBe(true);
  });
});
