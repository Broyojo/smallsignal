import { describe, expect, it } from "vitest";
import { createEmptyProject, type CircuitProject } from "@icm/model";
import {
  buildCircuitComponentPackage,
  planCircuitComponentCapture,
  type CircuitComponentPackage,
} from "./circuit-component-package.js";
import { executeProjectTransaction } from "./project-transaction.js";

const body = (name: string) =>
  `.subckt ${name} P N\nR1 P N 1k\n.ends ${name}\n`;

/** Publishes `name` the way the GUI does: Apply, then package the applied owner. */
function published(
  name: string,
  files = [{ path: "model.spice", text: body(name) }],
) {
  const project = createEmptyProject(`${name}-author`, "Author");
  const applied = executeProjectTransaction(project, {
    projectId: project.id,
    expectedStructureRevision: 0,
    transactionId: "apply",
    actor: { kind: "human", id: "test" },
    edits: [
      {
        kind: "apply_model_source",
        source: {
          id: `${name}-source`,
          revision: 0,
          language: "spice",
          entry: "model.spice",
          dependencies: [],
          files,
        },
        definitions: [{ definitionId: `${name}-owner`, entry: name }],
      },
    ],
  });
  if (!applied.ok) throw Error(applied.error.message);
  return {
    project: applied.project,
    packaged: buildCircuitComponentPackage(applied.project, `${name}-owner`),
  };
}

function capture(destination: CircuitProject, packaged: unknown) {
  const planned = planCircuitComponentCapture(destination, packaged, "capture");
  const result = executeProjectTransaction(destination, {
    projectId: destination.id,
    expectedStructureRevision: destination.structureRevision,
    transactionId: crypto.randomUUID(),
    actor: { kind: "human", id: "test" },
    edits: planned.edits,
  });
  if (!result.ok) throw Error(result.error.message);
  return { ...planned, project: result.project };
}

function withDependency(
  name: string,
  id: string,
  digest: string,
  mountPath: string,
): CircuitComponentPackage {
  const { packaged } = published(name);
  const source = packaged.circuit.source;
  source.files[0]!.text = `.include ${mountPath}\n${source.files[0]!.text}`;
  source.dependencies = [{ id, mountPath, sha256: digest.repeat(64) }];
  return packaged;
}

describe("capturing a public native component", () => {
  it("publishes only the applied entry closure, without unrelated Project files", () => {
    const { packaged } = published("finite", [
      { path: "model.spice", text: body("finite") },
      { path: "private.spice", text: "* Unrelated private Project file\n" },
    ]);
    expect(packaged.circuit.source.files).toEqual([
      { path: "model.spice", text: body("finite") },
    ]);
  });

  it("refuses a dependency whose identity, digest or mount path conflicts before capturing another owner", () => {
    const destination = capture(
      createEmptyProject("destination", "Destination"),
      withDependency("alpha", "vendor", "a", "vendor.lib"),
    ).project;
    for (const [name, id, digest, mountPath] of [
      ["beta", "vendor", "b", "vendor.lib"],
      ["delta", "other-vendor", "a", "vendor.lib"],
      ["epsilon", "vendor", "a", "other-vendor.lib"],
    ] as const)
      expect(() =>
        planCircuitComponentCapture(
          destination,
          withDependency(name, id, digest, mountPath),
          "capture",
        ),
      ).toThrow(`Conflicting model dependency ${id}`);
    const compatible = capture(
      destination,
      withDependency("gamma", "vendor", "a", "vendor.lib"),
    );
    expect(compatible.project.modelSources).toHaveLength(2);
  });

  it("reuses compatible applied resources for a fork's artwork and refuses conflicting artwork under the captured ID", () => {
    const { packaged } = published("finite");
    const original = capture(
      createEmptyProject("destination", "Destination"),
      packaged,
    );
    const fork = structuredClone(packaged);
    fork.definition.symbol.id = "fork-artwork";
    fork.circuit.externalDefinition.symbolId = "fork-artwork";
    const forked = capture(original.project, fork);
    expect(forked.symbolId).toBe("fork-artwork");
    expect(forked.definitionId).toBe(original.definitionId);
    expect(forked.project.modelSources).toEqual(original.project.modelSources);
    expect(forked.project.externalSubcircuitDefinitions).toHaveLength(1);
    expect(forked.project.componentDefinitions).toHaveLength(2);
    const changed = structuredClone(original.project);
    changed.componentDefinitions![0]!.symbol.primitives.push({
      kind: "circle",
      center: { x: 0, y: 0 },
      radius: 6,
    });
    expect(() =>
      planCircuitComponentCapture(changed, packaged, "capture"),
    ).toThrow("conflicting artwork or Pin mapping");
  });
});
