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
    expect(result.rout.exact.latex).toBe(
      "\\left(r_{o1} \\parallel R_{1}\\right)",
    );
    // The same number from the operating point the solver reports.
    const m1 = result.op.devices.M1;
    expect(result.gain.values[0].re).toBeCloseTo(
      -m1.gm / (m1.gds + 1 / 10e3),
      10,
    );
  });
});
