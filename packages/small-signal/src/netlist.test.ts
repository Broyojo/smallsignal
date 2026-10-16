import { readFileSync } from "node:fs";
import { parseProject } from "@icm/project-protocol";
import { describe, expect, it } from "vitest";
import { smallSignalNetlist } from "./netlist.js";

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
        ".model nmos_l1 NMOS (LEVEL=1 KP=200u VTO=0.5 LAMBDA=0.05)",
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

  it("flattens a child Cell through its ports", () => {
    const netlist = smallSignalNetlist(example("five-transistor-ota-sky130"))!;
    const lines = netlist.text.split("\n");
    expect(lines).toContain(
      "M1_DUT nleft_DUT vinp tail_DUT 0 nmos_l1 W=96u L=1u",
    );
    expect(lines).toContain(
      "M3_DUT nleft_DUT nleft_DUT vdd vdd pmos_l1 W=64u L=1u",
    );
    expect(lines).toContain("IBIAS vdd ibias DC 15u");
    expect(netlist.nets).toContain("vout");
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
    expect(lines).toContain("ECORE_2 Vout 0 net0 0 1");
  });
});
