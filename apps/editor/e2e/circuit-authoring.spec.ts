// Authoring a circuit by hand: power rails, Cell Pins and Bias Voltage Ports,
// MOS bulk, switch contacts and No Connect marks.

import { expect, test } from "@playwright/test";
import {
  revealPropertiesShelf,
  awaitEditorReady,
  chooseComponent,
  clickDrawTool,
  setComponentCodeField,
} from "./editor-fixtures.js";
import {
  placeComponent,
  openSelectionShelf,
} from "./manual-editor-fixtures.js";
import { clickRoute, readRoutePoints, dragBy } from "./canvas-fixtures.js";

// The rail's edit, Net and label look are vdd-rail's, standard-label-look's
// and the render contract's; this is the two-click gesture and its cancels.
test("constructs VDD as a drawn dotless power rail, cancelled before or after its first endpoint", async ({
  page,
}) => {
  await page.goto("/editor");
  const canvas = page.getByTestId("schematic-canvas");
  const preview = page.getByTestId("vdd-rail-preview");

  await page.getByTestId("shapes-chip-vdd").click();
  await canvas.hover({ position: { x: 180, y: 120 } });
  await expect(page.getByTestId("component-placement-preview")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("component-input-plane")).toHaveCount(0);
  await page.getByTestId("shapes-chip-vdd").click();
  await canvas.click({ position: { x: 180, y: 120 } });
  await canvas.hover({ position: { x: 520, y: 120 } });
  await expect(preview).toHaveAttribute("stroke-width", "3.24");
  await page.keyboard.press("Escape");
  await expect(preview).toHaveCount(0);
  await expect(
    page.locator('[data-route-presentation="power-rail"]'),
  ).toHaveCount(0);

  await page.getByTestId("shapes-chip-vdd").click();
  await canvas.click({ position: { x: 180, y: 120 } });
  await canvas.hover({ position: { x: 520, y: 120 } });
  await expect(preview).toHaveAttribute("stroke-width", "3.24");
  expect(
    await preview.evaluate(
      (element) => element.getAttribute("x1") !== element.getAttribute("x2"),
    ),
  ).toBe(true);
  await canvas.click({ position: { x: 520, y: 120 } });

  await expect(page.getByTestId("route-hit-route-vdd1-rail")).toHaveCount(1);
  await expect(
    canvas.locator('[data-object-id="route-vdd1-rail"]'),
  ).toHaveAttribute("data-route-presentation", "power-rail");
  await expect(
    canvas.locator('[data-object-id="junction-vdd1-start"]'),
  ).toHaveCount(0);
  await expect(page.getByTestId("hit-VDD1")).toHaveCount(0);
  const powerLabel = canvas.locator('[data-kind="power-label"]');
  await expect(powerLabel).toHaveText("VDD");
  await expect(page.getByTestId("component-input-plane")).toHaveCount(0);

  await page.keyboard.press("Delete");
  await expect(page.getByTestId("route-hit-route-vdd1-rail")).toHaveCount(0);
  await expect(powerLabel).toHaveCount(0);
});

test("a switch changes contact style in place, keeping its wires", async ({
  page,
}) => {
  await page.goto("/editor");
  await awaitEditorReady(page);
  await chooseComponent(page, "spdt-switch");
  const canvas = page.getByTestId("schematic-canvas");
  await canvas.click({ position: { x: 360, y: 220 } });
  await page.keyboard.press("Escape");

  // Wire the common terminal, so the swap has something to lose.
  await clickDrawTool(page, "wire");
  await page.getByTestId("terminal-S1-COM").click();
  await canvas.dblclick({ position: { x: 200, y: 320 } });
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-layer="routes"] polyline')).toHaveCount(1);

  await page.locator('[data-canvas-hit-kind="instance"]').first().click();
  await revealPropertiesShelf(page);
  await page.getByTestId("selection-shelf").click();

  // The plain drawing is a state of this component, not a second part: the
  // Library never grew a tile for it.
  await expect(page.getByTestId("shapes-chip-simple-spdt-switch")).toHaveCount(
    0,
  );

  await setComponentCodeField(page, "symbol", "simple-spdt-switch");
  await expect(page.locator("[data-symbol-id]").first()).toHaveAttribute(
    "data-symbol-id",
    "simple-spdt-switch",
  );
  // Same instance, same designator, same wire: the exchange keeps terminal
  // identity, so nothing is orphaned.
  await expect(page.getByTestId("hit-S1")).toHaveCount(1);
  await expect(page.locator('[data-layer="routes"] polyline')).toHaveCount(1);

  await setComponentCodeField(page, "symbol", "spdt-switch");
  await expect(page.locator("[data-symbol-id]").first()).toHaveAttribute(
    "data-symbol-id",
    "spdt-switch",
  );
  await expect(page.locator('[data-layer="routes"] polyline')).toHaveCount(1);
});

test("keeps a tapped VDD rail movable and stretchable as one supply bar", async ({
  page,
}) => {
  await page.goto("/editor");
  const canvas = page.getByTestId("schematic-canvas");
  await page.getByTestId("shapes-chip-vdd").click();
  await canvas.click({ position: { x: 180, y: 120 } });
  await canvas.click({ position: { x: 520, y: 120 } });
  await placeComponent(page, "resistor", { x: 360, y: 300 });

  await clickDrawTool(page, "wire");
  await clickRoute(page, "route-vdd1-rail");
  await page.locator('[data-testid^="terminal-R"][data-testid$="-1"]').click();
  await page.keyboard.press("Escape");

  const railHits = page.locator('[data-testid^="route-hit-route-vdd1-rail"]');
  await expect(railHits).toHaveCount(2);
  const selectedTestId = await railHits.first().getAttribute("data-testid");
  if (!selectedTestId) throw new Error("Tapped VDD rail is not selectable");
  const selectedRailId = selectedTestId.replace(/^route-hit-/u, "");
  const railIds = await railHits.evaluateAll((elements) =>
    elements.map((element) =>
      element.getAttribute("data-testid")!.replace(/^route-hit-/u, ""),
    ),
  );
  const beforeMove = await Promise.all(
    railIds.map((id) => readRoutePoints(page, id)),
  );

  await clickRoute(page, selectedRailId);
  await dragBy(page.getByTestId(`route-handle-${selectedRailId}`), {
    x: 30,
    y: 40,
  });
  await expect(page.getByTestId("status")).toContainText("Moved Power Rail");
  const afterMove = await Promise.all(
    railIds.map((id) => readRoutePoints(page, id)),
  );
  expect(Math.min(...afterMove.flat().map((point) => point.y))).toBeGreaterThan(
    Math.min(...beforeMove.flat().map((point) => point.y)),
  );

  const beforeResizeRight = Math.max(
    ...afterMove.flat().map((point) => point.x),
  );
  await dragBy(page.getByTestId("junction-junction-vdd1-end"), {
    x: 80,
    y: 0,
  });
  await expect(page.getByTestId("status")).toContainText("Resized Power Rail");
  const afterResize = await Promise.all(
    railIds.map((id) => readRoutePoints(page, id)),
  );
  expect(
    Math.max(...afterResize.flat().map((point) => point.x)),
  ).toBeGreaterThan(beforeResizeRight);
});

// P placing a Cell Pin is label-typography's V_LO case; the Cell Pin and
// Bias Voltage Port name sequences are netlist-authoring's ("allocates Cell
// Pin and Bias Voltage Port names from separate sequences"), and deleting a
// wired interface is project-transaction's ("deletes a Cell Pin and
// automatically disconnects every caller") and instance-lifecycle's.
test("authors components, connectivity and No Connect manually from an empty canvas", async ({
  page,
}) => {
  await page.goto("/editor");
  await awaitEditorReady(page);
  // A flat Project has no hierarchy to navigate, so that row stays hidden.
  await expect(page.getByTestId("cell-navigation")).toHaveCount(0);
  await expect(page.getByTestId("revision")).toHaveText("0");

  await placeComponent(page, "resistor", { x: 340, y: 220 });
  await placeComponent(page, "nmos", { x: 560, y: 220 });
  await expect(page.getByTestId("hit-R1")).toBeVisible();
  await expect(page.getByTestId("hit-M1")).toBeVisible();
  await expect(page.getByTestId("terminal-M1-B")).toHaveCount(0);
  await expect(page.getByTestId("revision")).toHaveText("2");
  await expect(page.getByTestId("source-status")).toHaveText(
    "connectivity-modified",
  );

  await clickDrawTool(page, "wire");
  await page.getByTestId("terminal-R1-2").click();
  await page.getByTestId("terminal-M1-G").click();
  await expect(page.getByTestId("revision")).toHaveText("3");
  await expect(page.locator('[data-layer="routes"] polyline')).toHaveCount(1);
  await page.keyboard.press("Escape");

  await page.getByTestId("terminal-R1-2").click({ button: "right" });
  await openSelectionShelf(page);
  await expect(
    page.getByRole("button", { name: "Disconnect endpoint" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Delete connection" }).click();
  await expect(page.locator('[data-layer="routes"] polyline')).toHaveCount(0);
  await expect(page.getByTestId("status")).toHaveText(
    "Deleted endpoint connection",
  );

  await page.keyboard.press("Control+z");
  await expect(page.locator('[data-layer="routes"] polyline')).toHaveCount(1);
  await page.keyboard.press("Control+z");
  await expect(page.getByTestId("revision")).toHaveText("6");
  await expect(page.locator('[data-layer="routes"] polyline')).toHaveCount(0);

  // An unconnected endpoint is marked and cleared as No Connect.
  await page.getByTestId("terminal-R1-1").click({ button: "right" });
  await page.getByRole("button", { name: "Mark No Connect" }).click();
  await expect(page.getByTestId("status")).toContainText(
    "Marked terminal-R1-1 No Connect",
  );
  await expect(page.locator('[data-role="no-connect"]')).toHaveCount(1);
  await page.getByTestId("terminal-R1-1").click({ button: "right" });
  await page.getByRole("button", { name: "Clear No Connect" }).click();
  await expect(page.getByTestId("status")).toContainText(
    "Cleared No Connect on terminal-R1-1",
  );
  await expect(page.locator('[data-role="no-connect"]')).toHaveCount(0);
});

test("keeps Bulk status and its prominent draw action on one compact row", async ({
  page,
}) => {
  await page.goto("/editor");
  await placeComponent(page, "nmos", { x: 360, y: 220 });
  await page.getByTestId("hit-M1").click();
  await openSelectionShelf(page);

  const bulk = page.getByLabel("MOS bulk connection");
  const draw = bulk.getByRole("button", { name: "Draw bulk connection" });
  await expect(draw).toBeVisible();
  await expect(draw).toHaveText("Connect");
  await expect(bulk.locator(".mos-bulk-status")).toHaveText("Unconnected");
  await expect(bulk).not.toContainText("unresolved");
  const layout = await bulk.evaluate((section) => {
    const heading = section.querySelector("h2")!.getBoundingClientRect();
    const action = section.querySelector("button")!.getBoundingClientRect();
    return {
      height: section.getBoundingClientRect().height,
      headingY: heading.y + heading.height / 2,
      actionY: action.y + action.height / 2,
    };
  });
  expect(layout.height).toBeLessThan(58);
  expect(Math.abs(layout.headingY - layout.actionY)).toBeLessThan(2);

  await draw.click();
  await expect(page.getByTestId("status")).toContainText(
    "Drawing M1.B bulk connection",
  );
  await expect(page.getByTestId("terminal-M1-B")).toBeVisible();
});

// The dashed bulk route's ink following its MOS is the render contract's
// ("paints a MOS bulk route with its owning instance foreground").
test("keeps DMOS bulk hidden until drawing an explicit bulk route", async ({
  page,
}) => {
  await page.goto("/editor");
  await placeComponent(page, "ndmos", { x: 360, y: 220 });
  await placeComponent(page, "resistor", { x: 560, y: 220 });
  await expect(page.getByTestId("terminal-M1-B")).toHaveCount(0);

  await page.getByTestId("hit-M1").click();
  await openSelectionShelf(page);
  await page.getByTestId("draw-bulk-connection").click();

  await expect(page.getByTestId("status")).toContainText(
    "Drawing M1.B bulk connection",
  );
  await expect(page.getByTestId("terminal-M1-B")).toBeVisible();
  await page.getByTestId("terminal-R1-1").click();
  await page.keyboard.press("Escape");

  const bulkRoute = page.locator(
    '[data-layer="routes"] [data-object-id="route-ui-1"]',
  );
  await expect(bulkRoute).toHaveCount(1);
  await expect(bulkRoute).toHaveAttribute(
    "data-route-presentation",
    "bulk-dashed",
  );

  await page
    .getByTestId("schematic-canvas")
    .click({ position: { x: 50, y: 50 } });
  const bulkHit = page.getByTestId("route-hit-route-ui-1");
  const bulkSegmentPoint = await bulkHit.evaluate((element) => {
    const polyline = element as SVGPolylineElement;
    const first = polyline.points.getItem(0);
    const second = polyline.points.getItem(1);
    const point = polyline.ownerSVGElement!.createSVGPoint();
    point.x = (first.x + second.x) / 2;
    point.y = (first.y + second.y) / 2;
    const screen = point.matrixTransform(polyline.getScreenCTM()!);
    return { x: screen.x, y: screen.y };
  });
  await page.mouse.click(bulkSegmentPoint.x, bulkSegmentPoint.y);
  await revealPropertiesShelf(page);
  await expect(page.getByTestId("selection-shelf")).toContainText("Bulk · M1");
  await expect(page.getByLabel("MOS bulk route actions")).toContainText(
    "Follows M1 line color",
  );
  await expect(page.getByLabel("Route actions", { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByText("Electrical route", { exact: true })).toHaveCount(
    0,
  );
});
