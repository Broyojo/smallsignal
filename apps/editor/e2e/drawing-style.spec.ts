// How Wires look: colour, line style and direction arrows through Route
// property code, one Wire or several.

import {
  parseSavedProject,
  exportedProject,
  clickDrawTool,
  downloadBytes,
  editComponentPropertyCode,
  readComponentPropertyCode,
} from "./editor-fixtures";
import { expect, test } from "@playwright/test";
import {} from "@icm/model";
import {
  placeComponent,
  openSelectionShelf,
} from "./manual-editor-fixtures.js";
import { clickRoute, routeInk } from "./canvas-fixtures.js";

test("styles a wire's colour, line and arrow through property code, with undo, export, reload and Auto", async ({
  page,
}) => {
  await page.goto("/editor");
  await placeComponent(page, "resistor", { x: 340, y: 220 });
  await placeComponent(page, "resistor", { x: 660, y: 220 });
  await clickDrawTool(page, "wire");
  await page.getByTestId("terminal-R1-2").click();
  await page.getByTestId("terminal-R2-1").click();
  await page.keyboard.press("Escape");
  await clickRoute(page, "route-ui-1");
  await openSelectionShelf(page);
  expect(JSON.parse(await readComponentPropertyCode(page)).appearance).toEqual({
    lineStyle: "solid",
    directionArrow: "none",
  });
  await editComponentPropertyCode(page, (code) => {
    code.color = [220, 38, 38];
    code.appearance = {
      lineStyle: "dashed",
      directionArrow: "end",
    };
  });
  await expect
    .poll(() => routeInk(page, "route-ui-1", "stroke-dasharray"))
    .toBe("6 4");
  await expect
    .poll(() => routeInk(page, "route-ui-1", "stroke"))
    .toBe("#dc2626");
  const arrow = page.locator(
    '[data-layer="routes"] [data-role="route-direction-arrow"]',
  );
  await expect(arrow).toHaveAttribute("data-arrow-position", "end");
  await expect(arrow).toHaveAttribute("fill", "#dc2626");
  await editComponentPropertyCode(page, (code) => {
    code.appearance.lineStyle = "dotted";
  });
  await expect
    .poll(() => routeInk(page, "route-ui-1", "stroke-dasharray"))
    .toBe("2 3");
  await page.getByTestId("draw-tool-undo").click();
  expect(
    JSON.parse(await readComponentPropertyCode(page)).appearance.lineStyle,
  ).toBe("dashed");
  await expect
    .poll(() => routeInk(page, "route-ui-1", "stroke-dasharray"))
    .toBe("6 4");
  await page.getByTestId("draw-tool-redo").click();
  expect(
    JSON.parse(await readComponentPropertyCode(page)).appearance.lineStyle,
  ).toBe("dotted");
  const saved = await downloadBytes(page, "File", "Export Project File…");
  expect(
    parseSavedProject(saved.toString("utf8")).documents[0].routes[0]
      .styleOverride,
  ).toEqual({
    lineStyle: "dotted",
    color: "#dc2626",
    arrow: "end",
  });
  const svg = (await downloadBytes(page, "File", "Export SVG")).toString(
    "utf8",
  );
  // Export must reproduce the authored world geometry regardless of the
  // toolbar/sidebar dimensions used to place it on screen.
  const liveRoute = page.locator(
    '[data-layer="routes"] polyline[data-object-id="route-ui-1"]',
  );
  const points = await liveRoute.getAttribute("points");
  const ink = await page
    .locator('[data-layer="routes"] [data-role="conductor-ink"]')
    .first()
    .getAttribute("d");
  expect(points).toBeTruthy();
  expect(ink).toBeTruthy();
  const exported = await page.evaluate((source) => {
    const svg = new DOMParser().parseFromString(source, "image/svg+xml");
    return {
      points: svg
        .querySelector('polyline[data-object-id="route-ui-1"]')
        ?.getAttribute("points"),
      ink: svg.querySelector('[data-role="conductor-ink"]')?.getAttribute("d"),
      dash: svg
        .querySelector('[data-role="conductor-ink"]')
        ?.getAttribute("stroke-dasharray"),
    };
  }, svg);
  expect(exported).toEqual({ points, ink, dash: "2 3" });
  expect(svg).toContain('data-role="route-direction-arrow"');
  await page.getByTestId("project-file").setInputFiles({
    name: "styled-wire.icproj.json",
    mimeType: "application/json",
    buffer: saved,
  });
  await clickRoute(page, "route-ui-1");
  await openSelectionShelf(page);
  expect(
    JSON.parse(await readComponentPropertyCode(page)).appearance.lineStyle,
  ).toBe("dotted");
  await expect
    .poll(() => routeInk(page, "route-ui-1", "stroke"))
    .toBe("#dc2626");
  await editComponentPropertyCode(page, (code) => {
    code.appearance = { lineStyle: "solid", directionArrow: "middle" };
  });
  await expect
    .poll(() => routeInk(page, "route-ui-1", "stroke-dasharray"))
    .toBeNull();
  await expect(arrow).toHaveAttribute("data-arrow-position", "middle");
  await expect(arrow).toHaveAttribute("pointer-events", "none");
  // Auto restores the Razavi default ink, and no arrow clears the marker.
  await editComponentPropertyCode(page, (code) => {
    code.color = "auto";
    code.appearance.directionArrow = "none";
  });
  await expect.poll(() => routeInk(page, "route-ui-1", "stroke")).toBe("#000");
  await expect(arrow).toHaveCount(0);
  expect(JSON.parse(await readComponentPropertyCode(page)).color).toBe("auto");
});

test("Shift-click gathers wires, and one color change restyles all of them", async ({
  page,
}) => {
  await page.goto("/editor");
  await placeComponent(page, "resistor", { x: 280, y: 180 });
  await placeComponent(page, "resistor", { x: 480, y: 180 });
  await placeComponent(page, "resistor", { x: 680, y: 180 });
  for (const [from, to] of [
    ["R1-2", "R2-1"],
    ["R2-2", "R3-1"],
  ]) {
    await clickDrawTool(page, "wire");
    await page.getByTestId(`terminal-${from}`).click();
    await page.getByTestId(`terminal-${to}`).click();
    await page.keyboard.press("Escape");
  }
  const first = page.getByTestId("route-hit-route-ui-1");
  const second = page.getByTestId("route-hit-route-ui-2");

  await clickRoute(page, "route-ui-1");
  await page.keyboard.down("Shift");
  await clickRoute(page, "route-ui-2");
  await page.keyboard.up("Shift");
  await expect(page.getByTestId("status")).toContainText(
    "Added wire route-ui-2 to the selection",
  );
  await expect(first).toHaveClass(/selected/);
  await expect(second).toHaveClass(/selected/);

  await openSelectionShelf(page);
  await expect(page.getByTestId("route-batch-note")).toContainText(
    "2 wires selected",
  );
  await editComponentPropertyCode(page, (code) => {
    code.color = [220, 38, 38];
  });
  await expect
    .poll(async () =>
      (await exportedProject(page)).documents[0].routes.map(
        (route: { styleOverride?: { color?: string } }) =>
          route.styleOverride?.color,
      ),
    )
    .toEqual(["#dc2626", "#dc2626"]);

  // Shift-clicking a selected wire takes it back out.
  await page.keyboard.down("Shift");
  await clickRoute(page, "route-ui-1");
  await page.keyboard.up("Shift");
  await expect(first).not.toHaveClass(/selected/);
  await expect(second).toHaveClass(/selected/);
});
