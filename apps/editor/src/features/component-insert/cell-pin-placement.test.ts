import { describe, expect, it } from "vitest";

import { executeProjectTransaction } from "@icm/edit-engine";
import { createEmptyProject, type CircuitProject } from "@icm/model";
import { builtInSymbols, InMemorySymbolResolver } from "@icm/symbols";

import { planPlacedCellPin } from "./cell-pin-placement";

const resolver = new InMemorySymbolResolver(builtInSymbols);

/** One VDD marker as the Insert picker places it, on its own new Net. */
function placeVddMarker(project: CircuitProject, id: string, x: number) {
  const document = project.documents[0]!;
  const netId = `net-cell-pin-${id.toLowerCase()}`;
  const endpoint = { kind: "terminal" as const, instanceId: id, pinName: "P" };
  const result = executeProjectTransaction(project, {
    transactionId: `place-${id}`,
    projectId: project.id,
    expectedStructureRevision: project.structureRevision,
    actor: { kind: "human", id: "test" },
    edits: planPlacedCellPin(project, document.id, resolver, {
      instance: {
        id,
        symbolId: "vdd-port",
        placement: { position: { x, y: 100 }, rotation: 0, mirror: "none" },
      },
      terminalId: `terminal-${id.toLowerCase()}`,
      netId,
      direction: "inout",
      connectionEdits: [
        {
          kind: "connect_endpoints",
          from: endpoint,
          to: endpoint,
          newNetId: netId,
        },
      ],
    }),
  });
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.project;
}

describe("placing a VDD marker", () => {
  it("makes each marker its own VDD Cell Pin with a bound supply label, not a global claim", () => {
    let project = createEmptyProject("vdd-markers", "VDD markers");
    project = placeVddMarker(project, "VDD1", 100);
    project = placeVddMarker(project, "VDD2", 300);
    const document = project.documents[0]!;

    expect(document.netlist!.terminals).toEqual([
      expect.objectContaining({ name: "VDD", interfaceInstanceIds: ["VDD1"] }),
      expect.objectContaining({ name: "VDD", interfaceInstanceIds: ["VDD2"] }),
    ]);
    expect(
      document.netlist!.terminals.map(
        (terminal) =>
          document.nets.find((net) => net.id === terminal.netId)?.terminals,
      ),
    ).toEqual([
      [{ instanceId: "VDD1", pinName: "P" }],
      [{ instanceId: "VDD2", pinName: "P" }],
    ]);
    expect(
      document.connectivityEvidence.filter(
        (evidence) =>
          evidence.kind === "name-claim" && evidence.powerDomain === "vdd",
      ),
    ).toEqual([]);
    expect(
      document.annotations
        .filter((annotation) => annotation.kind === "power-label")
        .map((annotation) => [annotation.id, annotation.binding]),
    ).toEqual([
      [
        "power-label-vdd1",
        { kind: "cell-terminal-name", terminalId: "terminal-vdd1" },
      ],
      [
        "power-label-vdd2",
        { kind: "cell-terminal-name", terminalId: "terminal-vdd2" },
      ],
    ]);
  });
});
