import { existsSync, readFileSync } from "node:fs";
import { parseProject } from "@icm/project-protocol";
import { describe, expect, it } from "vitest";
import { smallSignalNetlist } from "./netlist.js";
import type {
  DistortionForm,
  DistortionQuantity,
  DistortionVsFreqPoint,
  NoiseExpression,
  NoiseSource,
  SmallSignalDistortion,
  SmallSignalNoise,
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
] as const);
const QUANTITY_KEYS = allKeys<DistortionQuantity>()([
  ...FORM_KEYS,
  "display",
  "simplified",
  "skipped",
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
      for (const point of distortion.vsFreq)
        declared(point, VS_FREQ_KEYS);
    });
  },
);
