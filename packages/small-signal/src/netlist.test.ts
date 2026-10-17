import { readFileSync } from "node:fs";
import { parseProject } from "@icm/project-protocol";
import { describe, expect, it } from "vitest";
import {
  createIdentifier,
  modelCard,
  smallSignalNetlist,
  type ModelOverrides,
} from "./netlist.js";

const example = (name: string) =>
  parseProject(
    readFileSync(
      new URL(
        `../../../apps/editor/src/examples/${name}.icproj.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  );

// Drawn by the editor's own headless engine: VDD symbol → R1 → Vout → M1,
// V1 on the gate. "open" leaves the VDD symbol just off R1's pin, unwired.
const fixture = (name: string) =>
  parseProject(
    readFileSync(
      new URL(`../test-fixtures/${name}.icproj.json`, import.meta.url),
      "utf8",
    ),
  );

describe("common-source amplifier drawn with a VDD Pin symbol", () => {
  it("holds the VDD Cell Pin at the supply, leaving the Vout Pin alone", () => {
    const netlist = smallSignalNetlist(fixture("cs-vdd-pin-wired"))!;
    const lines = netlist.text.split("\n");
    expect(netlist.unconnected).toEqual([]);
    expect(netlist.supplies).toEqual(["VDD"]);
    expect(lines).toContain("VSUP_VDD VDD 0 DC 1.8");
    expect(lines).toContain("R1 VDD Vout 10k");
    expect(lines.some((line) => line.startsWith("VSUP_Vout"))).toBe(false);
  });

  it("reports a pin that only looks connected", () => {
    const netlist = smallSignalNetlist(fixture("cs-vdd-pin-open"))!;
    expect(netlist.unconnected).toEqual(["R1.1"]);
  });
});

describe("textbook drawings with Pins instead of sources", () => {
  it("turns undriven gate Pins into selectable inputs and AC-ground bias nodes", () => {
    const netlist = smallSignalNetlist(
      example("current-mirror-loaded-differential-pair"),
    )!;
    const pins = netlist.sources.filter((source) => source.pin);
    expect(pins.map((source) => source.pin).sort()).toEqual([
      "Vb",
      "Vin1",
      "Vin2",
    ]);
    // No bias values drawn: the analysis has to be hand analysis.
    expect(netlist.unknownBias.sort()).toEqual(["Vb", "Vin1", "Vin2"]);
    // Vout is an output label on a driven net, not an input.
    expect(pins.some((source) => source.pin === "Vout")).toBe(false);
  });

  it("uses a typed Pin bias and counts it as known", () => {
    const netlist = smallSignalNetlist(
      example("current-mirror-loaded-differential-pair"),
      { pinBias: { Vb: 0.8 } },
    )!;
    expect(netlist.text).toMatch(/^VPIN_Vb Vb 0 DC 0\.8$/mu);
    expect(netlist.unknownBias).not.toContain("Vb");
  });

  it("treats a source with no DC value as an unknown bias, not 0 V", () => {
    const netlist = smallSignalNetlist(example("common-source-amplifier"))!;
    expect(netlist.unknownBias).toContain("Vin");
  });
});

describe("model parameters", () => {
  it("writes the defaults and replaces only what is overridden", () => {
    const base = smallSignalNetlist(example("simulation-common-source"))!;
    expect(base.models).toEqual(["nmos"]);
    const custom = smallSignalNetlist(example("simulation-common-source"), {
      models: { nmos: { KP: 300e-6, LAMBDA: 0.1 } },
    })!;
    expect(custom.text.split("\n")).toContain(
      ".model nmos_l1 NMOS (LEVEL=1 KP=0.0003 VTO=0.5 LAMBDA=0.1 GAMMA=0 PHI=0.6 KF=0 AF=1)",
    );
  });

  it("writes only the editable parameters, with finite values", () => {
    const overrides = {
      nmos: { LEVEL: 2, KPP: 1, KP: Number.NaN, VTO: 0.4 },
    } as unknown as ModelOverrides;
    expect(modelCard("nmos", overrides)).toBe(
      ".model nmos_l1 NMOS (LEVEL=1 KP=0.0002 VTO=0.4 LAMBDA=0.05 GAMMA=0 PHI=0.6 KF=0 AF=1)",
    );
  });

  it("writes BJT cards without a LEVEL", () => {
    expect(modelCard("npn")).toBe(
      ".model npn_l1 NPN (IS=1e-15 BF=100 VAF=50 KF=0 AF=1)",
    );
  });
});

describe("net names", () => {
  it("keeps Vin+ and Vin− as two nets", () => {
    const netlist = smallSignalNetlist(
      example("fully-differential-two-stage-op-amp"),
    )!;
    const pins = netlist.sources.filter((source) => source.pin);
    expect(pins.map((source) => source.pin).sort()).toEqual(
      expect.arrayContaining(["Vin+"]),
    );
    const gateNets = netlist.text
      .split("\n")
      .filter((line) => /^M[5-8] /u.test(line))
      .map((line) => line.split(" ")[2]);
    // M5..M8 are driven by two different inputs, never one merged net.
    expect(new Set(gateNets).size).toBe(2);
  });

  it("never merges names that sanitize alike", () => {
    const id = createIdentifier();
    const names = ["Vin+", "Vin-", "Vin_", "Vinp", "a.b", "a_b", "A_B"];
    const ids = names.map(id);
    expect(new Set(ids.map((x) => x.toLowerCase())).size).toBe(names.length);
    expect(id("Vin+")).toBe(ids[0]);
    expect(ids.every((x) => /^[A-Za-z0-9_]+$/u.test(x))).toBe(true);
  });
});

describe("smallSignalNetlist", () => {
  it("binds a process MOSFET to the level-1 card and keeps W/L in microns", () => {
    const netlist = smallSignalNetlist(example("simulation-common-source"))!;
    expect(netlist.text.split("\n")).toEqual(
      expect.arrayContaining([
        "RD vdd out 10k",
        "CL out 0 1p",
        "VDD vdd 0 DC 1.8",
        "VIN in 0 DC 0.7 AC 1",
        "M1 out in 0 0 nmos_l1 W=10u L=1u",
        ".model nmos_l1 NMOS (LEVEL=1 KP=0.0002 VTO=0.5 LAMBDA=0.05 GAMMA=0 PHI=0.6 KF=0 AF=1)",
        ".end",
      ]),
    );
    expect(netlist.sources.map((source) => source.name)).toEqual([
      "VDD",
      "VIN",
    ]);
    expect(netlist.nets).toEqual(["0", "in", "out", "vdd"]);
    expect(netlist.missing).toEqual([]);
  });

  it("flattens a child Cell through its ports, keeping part names when unique", () => {
    const netlist = smallSignalNetlist(example("five-transistor-ota-sky130"))!;
    const lines = netlist.text.split("\n");
    expect(lines).toContain("M1 nleft_DUT vinp tail_DUT 0 nmos_l1 W=96u L=1u");
    expect(lines).toContain(
      "M3 nleft_DUT nleft_DUT vdd vdd pmos_l1 W=64u L=1u",
    );
    expect(lines).toContain("IBIAS vdd ibias DC 15u");
    expect(netlist.nets).toContain("vout");
  });

  it("holds an undriven VDD symbol at a DC supply (AC ground)", () => {
    const netlist = smallSignalNetlist(example("common-source-amplifier"))!;
    expect(netlist.supplies).toEqual(["VDD"]);
    expect(netlist.text.split("\n")).toContain("VSUP_VDD VDD 0 DC 1.8");
    const at3v3 = smallSignalNetlist(example("common-source-amplifier"), {
      supplyVoltage: 3.3,
    })!;
    expect(at3v3.text.split("\n")).toContain("VSUP_VDD VDD 0 DC 3.3");
  });

  it("leaves a supply that a source already drives alone", () => {
    const netlist = smallSignalNetlist(example("simulation-common-source"))!;
    expect(netlist.supplies).toEqual([]);
    expect(netlist.text).not.toMatch(/^VSUP/mu);
  });

  it("keeps a drawing without values symbolic", () => {
    const netlist = smallSignalNetlist(example("common-source-amplifier"))!;
    expect(netlist.missing).toEqual(expect.arrayContaining(["RD", "RS"]));
    expect(netlist.text).toMatch(/^RD \S+ \S+$/mu);
  });
});

describe("ideal blocks", () => {
  it("writes the ideal op-amp as its linear core and resolves child parameters", () => {
    const netlist = smallSignalNetlist(example("two-stage-op-amp"))!;
    const lines = netlist.text.split("\n");
    expect(lines).toContain("EX1 net0 0 Vin Vout 1e6");
    expect(lines).toContain("ECORE Vout 0 net0 0 1");
  });
});

describe("BJT multiplicity", () => {
  const raw = readFileSync(
    new URL("../test-fixtures/bjt-op-amp.icproj.json", import.meta.url),
    "utf8",
  );
  const lines = (text: string) =>
    smallSignalNetlist(parseProject(text))!.text.split("\n");

  it("writes each transistor's M, as the SPICE export does", () => {
    const project = JSON.parse(raw);
    project.defaults.instancesByType.npn.parameters.m = "3";
    const text = lines(JSON.stringify(project));
    expect(text).toContain("Q1 net8 INP net3 npn_l1 M=3");
    expect(text).toContain("Q3 net7 net1 net3 pnp_l1 M=1");
  });
});

describe("element instance paths", () => {
  const raw = readFileSync(
    new URL(
      "../../../apps/editor/src/examples/five-transistor-ota-sky130.icproj.json",
      import.meta.url,
    ),
    "utf8",
  );
  const elements = (project: unknown) =>
    smallSignalNetlist(parseProject(JSON.stringify(project)))!.elements;

  it("names each part by its instance ids, whatever its reference", () => {
    const project = JSON.parse(raw);
    expect(elements(project).find((e) => e.name === "M1")).toEqual({
      name: "M1",
      instancePath: ["XDUT", "M1"],
      kind: "nmos",
    });
    const child = project.documents.find(
      (d: { id: string }) => d.id === "document-ota-5t",
    );
    child.instances.find((i: { id: string }) => i.id === "M1").reference =
      "XM9";
    const renamed = elements(project).find(
      (e) => e.instancePath.join("/") === "XDUT/M1",
    );
    expect(renamed?.name).toBe("M9");
    expect(elements(project).map((e) => e.kind)).toContain("capacitor");
  });

  it("tells two placements of one child Cell apart", () => {
    const project = JSON.parse(raw);
    const top = project.documents.find(
      (d: { id: string }) => d.id === project.topDocumentId,
    );
    const dut = top.instances.find((i: { id: string }) => i.id === "XDUT");
    top.instances.push({ ...dut, id: "XDUT2", reference: "XDUT2" });
    const paths = elements(project)
      .filter((e) => e.instancePath.at(-1) === "M1")
      .map((e) => e.instancePath.join("/"));
    expect(paths).toEqual(["XDUT/M1", "XDUT2/M1"]);
    const names = elements(project)
      .filter((e) => e.instancePath.at(-1) === "M1")
      .map((e) => e.name);
    expect(new Set(names).size).toBe(2);
  });
});
