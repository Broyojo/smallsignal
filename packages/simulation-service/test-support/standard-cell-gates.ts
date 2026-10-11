import {
  createEmptyProject,
  createSimulationFolder,
  type CircuitProject,
} from "@icm/model";
import {
  executeProjectTransaction,
  planSetDeviceModelTarget,
} from "../../edit-engine/src/index.js";

/**
 * A Library NOR2 (X1), inverter (X2) and NAND2 (X3) sharing input A, each bound to a
 * SKY130 HD standard cell by the edit the Agent's set-model and Properties
 * make (#1596), with a simulation folder over the drawing. The nets are the
 * drawing's own; the generated circuit names them.
 */
export function standardCellGates(profileId: string) {
  let project: CircuitProject = createEmptyProject("cells", "Cells");
  const document = project.documents[0]!;
  for (const [id, symbolId, body] of [
    ["X1", "nor-gate", "nor_gate"],
    ["X2", "inverter", "inverter"],
    ["X3", "nand-gate", "nand_gate"],
  ] as const)
    document.instances.push({
      id,
      reference: id,
      symbolId,
      placement: null,
      netlist: {
        binding: { kind: "unresolved-subcircuit", name: body },
        parameters: { vt: "10m", td: "10p" },
      },
    });
  const nets: readonly (readonly [string, ...(readonly [string, string])[]])[] =
    [
      ["a", ["X1", "A"], ["X2", "A"], ["X3", "A"]],
      ["b", ["X1", "B"], ["X3", "B"]],
      ["y", ["X1", "Y"]],
      ["yi", ["X2", "Y"]],
      ["yn", ["X3", "Y"]],
    ];
  for (const [id, ...pins] of nets)
    document.nets.push({
      id: `net-${id}`,
      terminals: pins.map(([instanceId, pinName]) => ({ instanceId, pinName })),
    });
  for (const [instanceId, cell] of [
    ["X1", "sky130_fd_sc_hd__nor2_1"],
    ["X2", "sky130_fd_sc_hd__inv_1"],
    ["X3", "sky130_fd_sc_hd__nand2_1"],
  ] as const) {
    const bound = executeProjectTransaction(project, {
      transactionId: `model-${instanceId}`,
      projectId: project.id,
      expectedStructureRevision: project.structureRevision,
      actor: { kind: "agent", id: "test" },
      edits: planSetDeviceModelTarget(
        project,
        project.topDocumentId,
        instanceId,
        cell,
      ),
    });
    if (!bound.ok) throw Error(bound.error.message);
    project = bound.project;
  }
  const folder = createSimulationFolder({
    id: "cells",
    name: "Cells",
    profileId,
    engine: "ngspice",
    documentId: project.topDocumentId,
  });
  project.simulationFolders = [folder];
  const entry = folder.input.files.find(
    (file) => file.path === folder.input.entry,
  )!;
  return { project, folder, entry };
}
