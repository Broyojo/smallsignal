import { describe, expect, it } from "vitest";

import {
  executeProjectTransaction,
  executeTransaction,
} from "@icm/edit-engine";
import { createEmptyProject, type Instance } from "@icm/model";
import { builtInSymbols, InMemorySymbolResolver } from "@icm/symbols";

import { planPropertyApply } from "./property-apply-plan";

const resolver = new InMemorySymbolResolver(builtInSymbols);

describe("planPropertyApply", () => {
  it("refuses to show a component value until the value is valid, then shows it", () => {
    const project = createEmptyProject("value-display", "Value display");
    const document = project.documents[0]!;
    const instance: Instance = {
      id: "R1",
      reference: "R1",
      symbolId: "resistor",
      placement: { position: { x: 100, y: 100 }, rotation: 0, mirror: "none" },
      netlist: {
        binding: { kind: "primitive", deviceClass: "resistor" },
        parameters: {},
      },
    };
    document.instances.push(instance);
    const context = { project, document, resolver, instance };
    const showValue = (parameters: Record<string, string>) =>
      planPropertyApply(context, {
        placement: null,
        appearance: { color: "auto" },
        display: { value: true },
        parameters,
      });

    expect(showValue({ value: "" })).toEqual({
      kind: "rejected",
      message: "Set a valid component value before enabling its display",
    });
    const shown = showValue({ value: "33k" });
    expect(shown.kind).toBe("edits");
    expect(JSON.stringify(shown)).toContain("instance-value-R1");
  });

  it("hides and shows a component's name label from display.visualAnnotation", () => {
    const project = createEmptyProject("name-display", "Name display");
    const document = project.documents[0]!;
    const instance: Instance = {
      id: "R1",
      reference: "R1",
      symbolId: "resistor",
      placement: { position: { x: 100, y: 100 }, rotation: 0, mirror: "none" },
    };
    document.instances.push(instance);
    document.annotations.push({
      id: "instance-label-R1",
      kind: "instance-label",
      binding: { kind: "instance-reference", instanceId: "R1" },
      anchor: {
        kind: "object",
        objectId: "R1",
        localOffset: { x: 25, y: 0 },
        fallbackPosition: { x: 125, y: 100 },
      },
      alignment: "middle",
      rotation: 0,
      locked: false,
    });
    const plan = (visualAnnotation: boolean) =>
      planPropertyApply(
        { project, document, resolver, instance },
        {
          placement: null,
          appearance: { color: "auto" },
          display: { visualAnnotation },
        },
      );

    // Already shown: nothing to do.
    expect(plan(true)).toEqual({ kind: "unchanged" });
    const hidden = plan(false);
    if (hidden.kind !== "edits") throw new Error(JSON.stringify(hidden));
    const result = executeTransaction(document, {
      transactionId: "hide-name",
      documentId: document.id,
      expectedRevision: document.revision,
      actor: { kind: "human", id: "test" },
      edits: hidden.edits,
    });
    if (!result.ok) throw new Error(JSON.stringify(result));
    expect(
      result.document.annotations.find(
        (annotation) => annotation.id === "instance-label-R1",
      )?.visible,
    ).toBe(false);
  });

  it("renames a copied Cell Pin's formal name though it has no canvas label", () => {
    const project = createEmptyProject("pin-name", "Pin name");
    const document = project.documents[0]!;
    const instance: Instance = {
      id: "P2-copy-1",
      symbolId: "port",
      placement: { position: { x: 300, y: 200 }, rotation: 0, mirror: "none" },
    };
    document.instances.push(instance);
    document.nets.push({
      id: "net-voc",
      terminals: [{ instanceId: instance.id, pinName: "P" }],
    });
    document.netlist = {
      name: document.name,
      formalParameters: [],
      terminals: [
        {
          id: "terminal-voc",
          name: "Voc",
          netId: "net-voc",
          direction: "passive",
          interfaceInstanceIds: [instance.id],
        },
      ],
    };
    const plan = planPropertyApply(
      { project, document, resolver, instance },
      { placement: null, appearance: { color: "auto" }, displayName: "Vcm" },
    );
    if (plan.kind !== "structure") throw new Error(JSON.stringify(plan));
    const renamed = executeProjectTransaction(project, {
      transactionId: "rename-pin",
      projectId: project.id,
      expectedStructureRevision: project.structureRevision,
      actor: { kind: "human", id: "test" },
      edits: plan.structureEdits,
    });
    if (!renamed.ok) throw new Error(JSON.stringify(renamed));
    const after = renamed.project.documents[0]!;
    expect(after.netlist!.terminals).toEqual([
      expect.objectContaining({
        id: "terminal-voc",
        name: "Vcm",
        netId: "net-voc",
      }),
    ]);
    expect(after.instances.map((item) => item.id)).toEqual(["P2-copy-1"]);
  });
});
