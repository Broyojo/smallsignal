import { createEmptyDocument, createRoutePath } from "@icm/model";
import type { SchematicDocument } from "@icm/model";
import { InMemorySymbolResolver, builtInSymbols } from "@icm/symbols";
import { describe, expect, it } from "vitest";

import { buildSvgScene, renderDocumentSvg } from "./render.js";

const resolver = new InMemorySymbolResolver(builtInSymbols);

function tee(portOnJunction: boolean): SchematicDocument {
  const document = createEmptyDocument("doc", "Tee");
  document.instances.push(
    {
      id: "R1",
      symbolId: "resistor",
      placement: { position: { x: 260, y: 220 }, rotation: 90, mirror: "none" },
      reference: "R1",
      netlist: { parameters: {} },
    },
    {
      id: "P1",
      symbolId: "port",
      // The shortened port pin sits at the placement origin;
      // portOnJunction parks that contact on the junction point.
      placement: {
        position: portOnJunction ? { x: 420, y: 240 } : { x: 570, y: 240 },
        rotation: 0,
        mirror: "none",
      },
    },
    {
      id: "R2",
      symbolId: "resistor",
      placement: { position: { x: 420, y: 400 }, rotation: 0, mirror: "none" },
      reference: "R2",
      netlist: { parameters: {} },
    },
  );
  document.netlist!.terminals.push({
    id: "cell-terminal-p1",
    name: "VOUT",
    netId: "net-t",
    direction: "passive",
    interfaceInstanceIds: ["P1"],
  });
  document.nets.push({
    id: "net-t",
    terminals: [
      { instanceId: "R1", pinName: "2" },
      { instanceId: "P1", pinName: "P" },
      { instanceId: "R2", pinName: "1" },
    ],
  });
  document.junctions.push({
    id: "J1",
    netId: "net-t",
    position: { x: 420, y: 240 },
    role: "branch",
  });
  document.routes.push(
    createRoutePath({
      id: "r-left",
      netId: "net-t",
      start: { kind: "terminal", instanceId: "R1", pinName: "2" },
      end: { kind: "junction", junctionId: "J1" },
      bends: [],
      modes: ["manual"],
    }),
    createRoutePath({
      id: "r-tap",
      netId: "net-t",
      start: { kind: "junction", junctionId: "J1" },
      end: { kind: "terminal", instanceId: "R2", pinName: "1" },
      bends: [],
      modes: ["manual"],
    }),
  );
  if (!portOnJunction) {
    document.routes.push(
      createRoutePath({
        id: "r-right",
        netId: "net-t",
        start: { kind: "junction", junctionId: "J1" },
        end: { kind: "terminal", instanceId: "P1", pinName: "P" },
        bends: [],
        modes: ["manual"],
      }),
    );
  }
  return document;
}

function junctionCircleCount(svg: string): number {
  const layer = svg.match(/<g data-layer="junctions">(.*?)<\/g>/su)?.[1] ?? "";
  return (layer.match(/<circle/gu) ?? []).length;
}

function straightTap(): SchematicDocument {
  // A Port riding a Junction in the middle of a straight through-wire:
  // P0.pin (310,240) —— J1 (420,240) —— P2.pin (470,240), with P1's pin
  // parked exactly on J1. Visually this is a plain wire with a Port ring,
  // so no dot may render (the owner-reported "orphaned dot").
  const document = createEmptyDocument("doc", "StraightTap");
  document.instances.push(
    {
      id: "P0",
      symbolId: "port",
      placement: { position: { x: 310, y: 240 }, rotation: 0, mirror: "none" },
    },
    {
      id: "P1",
      symbolId: "port",
      placement: { position: { x: 420, y: 240 }, rotation: 0, mirror: "none" },
    },
    {
      id: "P2",
      symbolId: "port",
      placement: {
        position: { x: 470, y: 240 },
        rotation: 0,
        mirror: "horizontal",
      },
    },
  );
  document.netlist!.terminals.push(
    {
      id: "cell-terminal-p0",
      name: "L",
      netId: "net-s",
      direction: "passive",
      interfaceInstanceIds: ["P0"],
    },
    {
      id: "cell-terminal-p1",
      name: "VIN",
      netId: "net-s",
      direction: "passive",
      interfaceInstanceIds: ["P1"],
    },
    {
      id: "cell-terminal-p2",
      name: "R",
      netId: "net-s",
      direction: "passive",
      interfaceInstanceIds: ["P2"],
    },
  );
  document.nets.push({
    id: "net-s",
    terminals: [
      { instanceId: "P0", pinName: "P" },
      { instanceId: "P1", pinName: "P" },
      { instanceId: "P2", pinName: "P" },
    ],
  });
  document.junctions.push({
    id: "J1",
    netId: "net-s",
    position: { x: 420, y: 240 },
    role: "branch",
  });
  document.routes.push(
    createRoutePath({
      id: "r-west",
      netId: "net-s",
      start: { kind: "terminal", instanceId: "P0", pinName: "P" },
      end: { kind: "junction", junctionId: "J1" },
      bends: [],
      modes: ["manual"],
    }),
    createRoutePath({
      id: "r-east",
      netId: "net-s",
      start: { kind: "junction", junctionId: "J1" },
      end: { kind: "terminal", instanceId: "P2", pinName: "P" },
      bends: [],
      modes: ["manual"],
    }),
  );
  return document;
}

describe("junction dots at Port pins", () => {
  it("keeps the branch dot when a moved group parks the Port on the tee", () => {
    expect(junctionCircleCount(renderDocumentSvg(tee(true), resolver))).toBe(1);
  });

  it.each(["port", "port-filled"])(
    "renders a real three-way %s branch without requiring a Junction object",
    (symbolId) => {
      const document = tee(true);
      document.instances.find((i) => i.id === "P1")!.symbolId = symbolId;
      for (const route of document.routes) {
        if (route.start.kind === "junction")
          route.start = { kind: "terminal", instanceId: "P1", pinName: "P" };
        const last = route.legs.at(-1)!;
        if (last.to.kind === "endpoint" && last.to.endpoint.kind === "junction")
          last.to.endpoint = {
            kind: "terminal",
            instanceId: "P1",
            pinName: "P",
          };
      }
      document.junctions = [
        {
          id: "east",
          netId: "net-t",
          position: { x: 520, y: 240 },
          role: "route-anchor",
        },
      ];
      document.routes.push(
        createRoutePath({
          id: "east-wire",
          netId: "net-t",
          start: { kind: "terminal", instanceId: "P1", pinName: "P" },
          end: { kind: "junction", junctionId: "east" },
          bends: [],
          modes: ["manual"],
        }),
      );
      expect(junctionCircleCount(renderDocumentSvg(document, resolver))).toBe(
        1,
      );
    },
  );

  it("stays dotless where the Port rides a straight through-wire", () => {
    // The owner-reported orphan: a dot in the middle of a plain wire next
    // to a Port ring, with no branch anywhere.
    const svg = renderDocumentSvg(straightTap(), resolver);
    const layer =
      svg.match(/<g data-layer="junctions">(.*?)<\/g>/su)?.[1] ?? "";
    expect((layer.match(/<circle/gu) ?? []).length).toBe(0);
  });

  it("stays dotless where the Port merely terminates the wire", () => {
    const svg = renderDocumentSvg(tee(false), resolver);
    const layer =
      svg.match(/<g data-layer="junctions">(.*?)<\/g>/su)?.[1] ?? "";
    // Exactly the tee's own dot; no second dot at the Port terminus.
    expect((layer.match(/<circle/gu) ?? []).length).toBe(1);
    expect(layer).not.toContain('data-object-id="P1"');
  });
});

describe("Junctions in the SVG bounds (#1637)", () => {
  // The leftover: a Junction no Route meets, far right of the circuit, and a
  // Net anchored only to it.
  function withStrayJunction(): SchematicDocument {
    const document = tee(false);
    document.nets.push({ id: "net-stray", terminals: [] });
    document.junctions.push({
      id: "J-stray",
      netId: "net-stray",
      position: { x: 2190, y: 210 },
      role: "branch",
    });
    return document;
  }

  it("leaves out a Junction that draws nothing and its lone Net", () => {
    const scene = buildSvgScene(withStrayJunction(), resolver);
    expect(scene.formalBody).not.toContain('data-object-id="J-stray"');
    // The tee's ink: R1's turned 48x20 body from x 236 and y 210, the Port's
    // 18-wide body to x 574, R2's upright body to y 424. Plus 40 each side.
    expect(scene.viewBox).toEqual({ x: 196, y: 170, width: 418, height: 294 });
  });

  it("still counts a Junction that draws a branch dot", () => {
    const scene = buildSvgScene(withStrayJunction(), resolver, {
      objectIds: new Set(["J1"]),
    });
    expect(scene.formalBody).toContain('data-object-id="J1"');
    // The dot's centre (420, 240) plus the 40-unit margin.
    expect(scene.viewBox).toEqual({ x: 380, y: 200, width: 80, height: 80 });
  });

  it("leaves out a dotless through-Junction from a copy selection", () => {
    // Without the tap J1 joins two collinear wires and draws no dot. Copying
    // it with R2 but not the wires paints only R2.
    const document = tee(false);
    document.routes = document.routes.filter((route) => route.id !== "r-tap");
    const scene = buildSvgScene(document, resolver, {
      objectIds: new Set(["J1", "R2"]),
    });
    expect(scene.formalBody).not.toContain('data-object-id="J1"');
    // R2's upright 20x48 body at (420, 400) plus the 40-unit margin.
    expect(scene.viewBox).toEqual({ x: 370, y: 336, width: 100, height: 128 });
  });
});
