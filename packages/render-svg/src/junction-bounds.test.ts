import { createEmptyDocument, createRoutePath } from "@icm/model";
import type { SchematicDocument } from "@icm/model";
import { InMemorySymbolResolver, builtInSymbols } from "@icm/symbols";
import { describe, expect, it } from "vitest";

import { buildSvgScene } from "./render.js";

const resolver = new InMemorySymbolResolver(builtInSymbols);

// A tee whose Junction J1 at (420, 240) draws a real branch dot.
function tee(): SchematicDocument {
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
      id: "R2",
      symbolId: "resistor",
      placement: { position: { x: 420, y: 400 }, rotation: 0, mirror: "none" },
      reference: "R2",
      netlist: { parameters: {} },
    },
    {
      id: "R3",
      symbolId: "resistor",
      placement: { position: { x: 600, y: 220 }, rotation: 90, mirror: "none" },
      reference: "R3",
      netlist: { parameters: {} },
    },
  );
  document.nets.push({
    id: "net-t",
    terminals: [
      { instanceId: "R1", pinName: "2" },
      { instanceId: "R2", pinName: "1" },
      { instanceId: "R3", pinName: "1" },
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
    createRoutePath({
      id: "r-right",
      netId: "net-t",
      start: { kind: "junction", junctionId: "J1" },
      end: { kind: "terminal", instanceId: "R3", pinName: "1" },
      bends: [],
      modes: ["manual"],
    }),
  );
  return document;
}

// The #1637 leftover: a Junction no Route meets, far right of the circuit,
// and a Net anchored only to it.
function withStrayJunction(): SchematicDocument {
  const document = tee();
  document.nets.push({ id: "net-stray", terminals: [] });
  document.junctions.push({
    id: "J-stray",
    netId: "net-stray",
    position: { x: 2190, y: 210 },
    role: "branch",
  });
  return document;
}

describe("Junctions in the SVG bounds", () => {
  it("leaves out a Junction that draws nothing and its lone Net", () => {
    const scene = buildSvgScene(withStrayJunction(), resolver);
    expect(scene.formalBody).not.toContain('data-object-id="J-stray"');
    // The tee's ink: R1's and R3's turned 48x20 bodies span x 236..624 and
    // reach up to y 210; R2's upright body ends at y 424. Plus 40 each side.
    expect(scene.viewBox).toEqual({ x: 196, y: 170, width: 468, height: 294 });
  });

  it("still counts a Junction that draws a branch dot", () => {
    const scene = buildSvgScene(withStrayJunction(), resolver, {
      objectIds: new Set(["J1"]),
    });
    expect(scene.formalBody).toContain('data-object-id="J1"');
    expect(scene.viewBox).toEqual({ x: 380, y: 200, width: 80, height: 80 });
  });

  it("finds nothing to copy in a lone undrawn Junction", () => {
    expect(() =>
      buildSvgScene(withStrayJunction(), resolver, {
        objectIds: new Set(["J-stray"]),
      }),
    ).toThrow("Select visible objects before copying");
  });
});
