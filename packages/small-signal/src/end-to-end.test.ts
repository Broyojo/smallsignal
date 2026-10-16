import { existsSync, readFileSync } from "node:fs";
import { parseProject } from "@icm/project-protocol";
import { describe, expect, it } from "vitest";
import { smallSignalNetlist } from "./netlist.js";

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
    expect(result.gain.exact.latex).toBe(
      "-g_{m1} \\left(r_{o1} \\parallel R_{1}\\right)",
    );
    // A bare parallel group needs no parentheses.
    expect(result.rout.exact.latex).toBe("r_{o1} \\parallel R_{1}");
    // The same number from the operating point the solver reports.
    const m1 = result.op.devices.M1;
    expect(result.gain.values[0].re).toBeCloseTo(
      -m1.gm / (m1.gds + 1 / 10e3),
      10,
    );
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
    expect(result.gain.exact.latex).toBe(
      "-\\frac{g_{m1} \\left(r_{o1} \\parallel R_{D}\\right)}{1 + C_{L} \\left(r_{o1} \\parallel R_{D}\\right) s}",
    );
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
