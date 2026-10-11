// Editing drawn Wires: re-pointed ends and imported Route guidance.

import { exportedProject, openProject } from "./editor-fixtures";
import {
  createEmptyProject,
  createRoutePath,
  type SchematicDocument,
} from "@icm/model";
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { createRoutingDemoProject } from "../src/demos/routing-demo.js";
import { clickRoute } from "./canvas-fixtures.js";
import { openSelectionShelf } from "./manual-editor-fixtures.js";

async function dragHandleToPoint(
  page: Page,
  handle: Locator,
  routeIdForFrame: string,
  point: { x: number; y: number },
): Promise<void> {
  const box = await handle.boundingBox();
  if (!box) throw new Error("Drag target is not measurable");
  const target = await page
    .locator(`[data-layer="routes"] [data-object-id="${routeIdForFrame}"]`)
    .evaluate((element, wanted) => {
      const matrix = (element as SVGGraphicsElement).getScreenCTM();
      if (!matrix) return null;
      const screen = new DOMPoint(wanted.x, wanted.y).matrixTransform(matrix);
      return { x: screen.x, y: screen.y };
    }, point);
  if (!target) throw new Error(`Point is not measurable in ${routeIdForFrame}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 4 });
  await page.mouse.up();
}

function markRoutingDemoNetsImported(
  project: ReturnType<typeof createRoutingDemoProject>,
): void {
  // These Port symbols stand in for device endpoints in routing tests, not
  // same-name formal interfaces (which legitimately need no extra wire).
  for (const terminal of project.documents[0]!.netlist!.terminals)
    terminal.name = terminal.interfaceInstanceIds[0]!;
  project.documents[0]!.importReference = {
    files: [],
    nets: project.documents[0]!.nets.map((net) => ({
      id: net.id,
      name: net.id,
      scope: "local",
      terminals: structuredClone(net.terminals),
    })),
  };
  for (const net of project.documents[0]!.nets) {
    project.documents[0]!.connectivityEvidence.push({
      id: `evidence-spice-${net.id}`,
      kind: "spice-source",
      netId: net.id,
      sourceNetId: net.id,
    });
  }
}

test("re-points a Wire end that is anchored to a pin", async ({ page }) => {
  // Before this the handle refused with "A terminal-connected wire end is
  // electrically anchored", so rewiring meant deleting the wire and drawing a
  // new one.
  const project = createEmptyProject("endpoint-repoint", "Endpoint Repoint");
  const document = project.documents[0]!;
  document.instances.push({
    id: "VDD1",
    symbolId: "vdd-port",
    placement: { position: { x: 300, y: 120 }, rotation: 0, mirror: "none" },
  } as (typeof document)["instances"][number]);
  document.nets.push(
    { id: "net-a", terminals: [] },
    { id: "net-supply", terminals: [{ instanceId: "VDD1", pinName: "P" }] },
  );
  document.junctions.push(
    {
      id: "A1",
      netId: "net-a",
      position: { x: 200, y: 260 },
      role: "route-anchor",
    },
    {
      id: "A2",
      netId: "net-a",
      position: { x: 420, y: 260 },
      role: "route-anchor",
    },
    {
      id: "S2",
      netId: "net-supply",
      position: { x: 300, y: 190 },
      role: "route-anchor",
    },
  );
  document.routes.push(
    createRoutePath({
      id: "route-a",
      netId: "net-a",
      start: { kind: "junction", junctionId: "A1" },
      end: { kind: "junction", junctionId: "A2" },
      bends: [],
      modes: ["manual"],
    }),
    createRoutePath({
      id: "route-supply",
      netId: "net-supply",
      // The VDD port's P pin sits 20 below its placement, at (300, 140).
      start: { kind: "terminal", instanceId: "VDD1", pinName: "P" },
      end: { kind: "junction", junctionId: "S2" },
      bends: [],
      modes: ["manual"],
    }),
  );

  await openProject(page, project);
  await clickRoute(page, "route-supply");
  await dragHandleToPoint(
    page,
    page.getByTestId("route-endpoint-handle-route-supply-start"),
    "route-a",
    { x: 300, y: 260 },
  );

  const saved: SchematicDocument = (await exportedProject(page)).documents[0];
  // The pin let go of the wire that was on it, and the wire landed where it
  // was dropped. Both halves are the gesture; neither alone is.
  expect(
    saved.nets.some((net) =>
      net.terminals.some((terminal) => terminal.instanceId === "VDD1"),
    ),
  ).toBe(false);
  expect(new Set(saved.routes.map((route) => route.netId)).size).toBe(1);
});

test("highlighting suppresses only that Net's imported guidance, and cutting an imported Route never reconnects through it", async ({
  page,
}) => {
  const project = createRoutingDemoProject();
  const document = project.documents[0]!;
  markRoutingDemoNetsImported(project);
  document.sourceBinding = {
    cellName: "routing_demo",
    sourceRef: {
      fileId: "source-routing-demo",
      start: { offset: 0, line: 1, column: 1 },
      end: { offset: 1, line: 1, column: 2 },
    },
  };
  document.routes = [
    createRoutePath({
      id: "route-imported-partial",
      netId: "net-h",
      start: { kind: "terminal", instanceId: "A", pinName: "P" },
      end: { kind: "terminal", instanceId: "B", pinName: "P" },
      bends: [],
      modes: ["manual"],
    }),
  ];
  await openProject(page, project);

  const flightlines = page.getByTestId("flightline");
  await clickRoute(page, "route-imported-partial");
  await expect(flightlines).toHaveCount(1);
  // All shows every Net's guidance again; highlighting the selected Net
  // suppresses only that Net's.
  await openSelectionShelf(page);
  await page.getByRole("button", { name: "All", exact: true }).click();
  await expect(flightlines).toHaveCount(2);
  await page.keyboard.press("h");
  await expect(page.getByTestId("net-highlight-overlay")).toHaveAttribute(
    "data-net-id",
    "net-h",
  );
  await expect(flightlines).toHaveCount(1);
  await page.keyboard.press("h");
  await expect(page.getByTestId("net-highlight-overlay")).toHaveCount(0);
  await expect(flightlines).toHaveCount(2);
  await clickRoute(page, "route-imported-partial");
  await page.keyboard.press("Delete");
  await expect(page.locator('[data-layer="routes"] polyline')).toHaveCount(0);
  await expect(page.getByTestId("status")).toContainText(
    "Deleted wire route-imported-partial",
  );

  await expect(page.getByTestId("source-status")).toHaveText(
    "connectivity-modified",
  );
  await expect(page.getByTestId("flightline")).toHaveCount(3);
});

test("keeps remaining imported flightlines after routing one guided connection", async ({
  page,
}) => {
  const project = createRoutingDemoProject();
  markRoutingDemoNetsImported(project);
  project.documents[0]!.sourceBinding = {
    cellName: "routing_demo",
    sourceRef: {
      fileId: "source-routing-demo",
      start: { offset: 0, line: 1, column: 1 },
      end: { offset: 1, line: 1, column: 2 },
    },
  };
  await openProject(page, project);

  await expect(page.getByTestId("flightline")).toHaveCount(3);
  const hint = page.getByTestId("flightline-hit").first();
  await hint.click({ force: true });
  await expect(page.getByTestId("active-tool")).toHaveText("wire");
  await expect(page.getByTestId("status")).toContainText(
    "Wire source: flightline on",
  );

  await hint.click({ force: true });
  await expect(page.getByTestId("active-tool")).toHaveText("wire");
  await expect(page.locator('[data-layer="routes"] polyline')).toHaveCount(1);
  await expect(page.getByTestId("flightline")).toHaveCount(2);
});
