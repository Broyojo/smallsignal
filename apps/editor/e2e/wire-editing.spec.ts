// Editing drawn Wires: re-pointed ends and imported Route guidance.

import { expectStatus, exportedProject, openProject } from "./editor-fixtures";
import {
  createEmptyProject,
  createRoutePath,
  type SchematicDocument,
} from "@icm/model";
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { createRoutingDemoProject } from "../src/demos/routing-demo.js";
import {
  clickRoute,
  junctionRoute,
  placedInstance,
  routeAnchor,
  onScreen,
} from "./canvas-fixtures.js";
import { openSelectionShelf } from "./manual-editor-fixtures.js";

async function dragHandleToPoint(
  page: Page,
  handle: Locator,
  routeIdForFrame: string,
  point: { x: number; y: number },
): Promise<void> {
  const box = await handle.boundingBox();
  if (!box) throw new Error("Drag target is not measurable");
  const [target] = await onScreen(
    page.locator(`[data-layer="routes"] [data-object-id="${routeIdForFrame}"]`),
    [point],
  );
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 4 });
  await page.mouse.up();
}

/** The routing demo, its Nets marked imported from a bound SPICE source. */
function importedRoutingDemo() {
  const project = createRoutingDemoProject();
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
  project.documents[0]!.sourceBinding = {
    cellName: "routing_demo",
    sourceRef: {
      fileId: "source-routing-demo",
      start: { offset: 0, line: 1, column: 1 },
      end: { offset: 1, line: 1, column: 2 },
    },
  };
  return project;
}

test("re-points a Wire end that is anchored to a pin", async ({ page }) => {
  // Before this the handle refused with "A terminal-connected wire end is
  // electrically anchored", so rewiring meant deleting the wire and drawing a
  // new one.
  const project = createEmptyProject("endpoint-repoint", "Endpoint Repoint");
  const document = project.documents[0]!;
  document.instances.push(placedInstance("VDD1", "vdd-port", 300, 120));
  document.nets.push(
    { id: "net-a", terminals: [] },
    { id: "net-supply", terminals: [{ instanceId: "VDD1", pinName: "P" }] },
  );
  document.junctions.push(
    routeAnchor("A1", "net-a", 200, 260),
    routeAnchor("A2", "net-a", 420, 260),
    routeAnchor("S2", "net-supply", 300, 190),
  );
  document.routes.push(
    junctionRoute("route-a", "net-a", "A1", "A2"),
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
  const project = importedRoutingDemo();
  const document = project.documents[0]!;
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
  await expectStatus(page, "Deleted wire route-imported-partial");

  await expect(page.getByTestId("source-status")).toHaveText(
    "connectivity-modified",
  );
  await expect(page.getByTestId("flightline")).toHaveCount(3);
});

test("keeps remaining imported flightlines after routing one guided connection", async ({
  page,
}) => {
  const project = importedRoutingDemo();
  await openProject(page, project);

  await expect(page.getByTestId("flightline")).toHaveCount(3);
  const hint = page.getByTestId("flightline-hit").first();
  await hint.click({ force: true });
  await expect(page.getByTestId("active-tool")).toHaveText("wire");
  await expectStatus(page, "Wire source: flightline on");

  await hint.click({ force: true });
  await expect(page.getByTestId("active-tool")).toHaveText("wire");
  await expect(page.locator('[data-layer="routes"] polyline')).toHaveCount(1);
  await expect(page.getByTestId("flightline")).toHaveCount(2);
});
