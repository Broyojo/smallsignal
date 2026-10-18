import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseProject } from "@icm/project-protocol";
import {
  smallSignalNetlist,
  type SmallSignalQuantity,
  type SmallSignalResult,
} from "@icm/small-signal";
import { approxShown, operatingPointLabels } from "./small-signal-panel";

const example = (name: string) =>
  parseProject(
    readFileSync(
      new URL(`../../examples/${name}.icproj.json`, import.meta.url),
      "utf8",
    ),
  );

describe("bias on the drawing", () => {
  it("leaves out a supply rail a drawn source drives, as one it adds", () => {
    const project = example("simulation-common-source");
    const netlist = smallSignalNetlist(project)!;
    // The drawn source drives the VDD rail: no source added for it.
    expect(netlist.supplies).toEqual([]);
    expect(netlist.rails.length).toBeGreaterThan(0);
    const document = project.documents.find(
      (d) => d.id === project.topDocumentId,
    );
    const nodes = Object.fromEntries(
      netlist.nets.map((net) => [net, 1] as const),
    );
    const op = { nodes, devices: {} } as NonNullable<SmallSignalResult["op"]>;
    const labelled = operatingPointLabels(op, netlist, document).nets.map(
      (net) => net.node,
    );
    expect(labelled.length).toBeGreaterThan(0);
    for (const rail of netlist.rails) expect(labelled).not.toContain(rail);
    // The rail has wires to label: only knowing it is a rail keeps it off.
    const unknown = operatingPointLabels(
      op,
      { ...netlist, rails: [] },
      document,
    ).nets.map((net) => net.node);
    expect(unknown).toEqual(expect.arrayContaining(netlist.rails));
  });
});

describe("the ≈ curve", () => {
  const form = (latex: string, extra: object = {}) => ({
    latex,
    ...extra,
  });
  const quantity = (q: Partial<SmallSignalQuantity>) =>
    ({ exact: form("X"), ...q }) as SmallSignalQuantity;

  it("is plotted when the lead form itself is the ≈ one", () => {
    // Junction leakage dropped (written ≈), and nothing simpler than that.
    expect(
      approxShown(
        quantity({
          display: form("D", { same: false, maxRelError: 2e-4 }),
          simplified: form("D", { same: false }),
        }),
      ),
    ).toBe(true);
  });

  it("is plotted for its own row, and not for an exact lead", () => {
    expect(
      approxShown(
        quantity({
          display: form("X", { same: true }),
          simplified: form("S", { same: false }),
        }),
      ),
    ).toBe(true);
    // Leakage below what four digits show: the lead reads "=".
    expect(
      approxShown(
        quantity({
          display: form("D", { same: false, maxRelError: 1e-9 }),
          simplified: form("D", { same: false }),
        }),
      ),
    ).toBe(false);
    expect(
      approxShown(
        quantity({
          display: form("X", { same: true }),
          simplified: form("X", { same: true }),
        }),
      ),
    ).toBe(false);
  });
});
