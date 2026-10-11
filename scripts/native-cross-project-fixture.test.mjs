import { it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { createEmptyProject } from "@icm/model";
import { parseProject } from "@icm/project-protocol";
import {
  planProjectCellImport,
  executeProjectTransaction,
} from "../packages/edit-engine/src/index.js";
import { prepareSourceExecutionInput } from "@icm/simulation-service";
import { nativeImportedTestbench } from "./lib/native-cross-project-fixture.mjs";

async function prepareImportedFixture() {
  const reference = parseProject(
    await readFile(
      "apps/editor/src/examples/five-transistor-ota-sky130.icproj.json",
      "utf8",
    ),
  );
  const before = structuredClone(reference);
  const destination = createEmptyProject("cross-native", "Cross native");
  const plan = planProjectCellImport(destination, reference, "document-ota-5t");
  expect(plan.ok).toBe(true);
  const imported = executeProjectTransaction(destination, {
    transactionId: "import",
    projectId: destination.id,
    expectedStructureRevision: destination.structureRevision,
    actor: { kind: "human", id: "test" },
    edits: plan.edits,
  });
  expect(imported.ok, JSON.stringify(imported.error)).toBe(true);
  const { testbench, folder } = nativeImportedTestbench(
    reference,
    plan.rootDocumentId,
    "cross-tb",
    "cross-op",
  );
  const authored = executeProjectTransaction(imported.project, {
    transactionId: "tb",
    projectId: destination.id,
    expectedStructureRevision: imported.project.structureRevision,
    actor: { kind: "human", id: "test" },
    edits: [
      { kind: "add_document", document: testbench },
      { kind: "upsert_simulation_folder", folder },
    ],
  });
  expect(authored.ok, JSON.stringify(authored.error)).toBe(true);
  const symbols = JSON.parse(
    await readFile(
      "netlists/vacask-sky130/model-symbols-sections.json",
      "utf8",
    ),
  );
  const capabilities = {
    configured: true,
    rawfileCollection: "native-multi-ascii",
    inputs: ["source"],
    analyses: ["op"],
    parsedAnalyses: ["op"],
    maxTimeoutMs: 15000,
    maxInputBytes: 1048576,
    maxInputFiles: 24,
    maxOutputBytes: 8388608,
    cancel: true,
    profiles: [
      {
        id: "vacask-sky130-candidate",
        corners: symbols.sections,
        dependencies: [symbols.dependency],
        modelSymbols: symbols.modelSymbols,
        modelLibrary: {
          dependencyId: symbols.dependency.id,
          defaultSection: "tt",
          defaultScale: 1e-6,
        },
      },
    ],
  };
  const prepared = await prepareSourceExecutionInput(
    authored.project,
    folder,
    capabilities,
  );
  expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
  expect(prepared.input.language).toBe("vacask");
  expect(prepared.input.environment.corner).toBe("tt");
  expect(prepared.input.preparedDeck).toContain("options scale=0.000001");
  expect(prepared.input.preparedDeck).not.toContain(".control");
  const dut = authored.project.documents.find(
    (d) => d.id === plan.rootDocumentId,
  );
  expect(
    dut.netlist.terminals.map(({ name, direction }) => ({ name, direction })),
  ).toEqual(
    reference.documents
      .find((d) => d.id === "document-ota-5t")
      .netlist.terminals.map(({ name, direction }) => ({ name, direction })),
  );
  for (const terminal of dut.netlist.terminals) {
    expect(dut.nets.some((n) => n.id === terminal.netId)).toBe(true);
    expect(
      terminal.interfaceInstanceIds.every((id) =>
        dut.instances.some((i) => i.id === id),
      ),
    ).toBe(true);
  }
  const circuit = prepared.input.files.find(
    (f) => f.path === "circuit.spice",
  ).text;
  expect(circuit).toMatch(/subckt\s+\S+\s*\(vdd vss ibias vinn vinp vout\)/u);
  expect(circuit).toMatch(/XDUT\s+\(vdd 0 ibias vinn vinp vout\)\s+\S+/u);
  expect(
    testbench.instances.find((i) => i.id === "XDUT").netlist.binding
      .childDocumentId,
  ).toBe(plan.rootDocumentId);
  expect(reference).toEqual(before);
  return {
    project: authored.project,
    input: prepared.input,
    capabilities,
    symbols,
  };
}

it(
  "imports the real OTA DUT through the shared transaction and prepares its native Canvas TB",
  prepareImportedFixture,
);
