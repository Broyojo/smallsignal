// How Wires look: colour, line style and direction arrows through Route
// property code, one Wire or several.

import {
  parseSavedProject,
  exportedProject,
  downloadBytes,
  editComponentPropertyCode,
  expectStatus,
  openProjectFile,
} from "./editor-fixtures";
import { expect, test } from "@playwright/test";
import {
  placeComponent,
  openSelectionShelf,
  readComponentCode,
} from "./manual-editor-fixtures.js";
import { clickRoute, routeInk, drawWire } from "./canvas-fixtures.js";

test("styles a wire's colour, line and arrow through property code, with undo, export, reload and Auto, and names it globally in one step", async ({
  page,
}) => {
  await page.goto("/editor");
  await placeComponent(page, "resistor", { x: 340, y: 220 });
  await placeComponent(page, "resistor", { x: 660, y: 220 });
  await drawWire(page, "R1-2", "R2-1");
  await clickRoute(page, "route-ui-1");
  await openSelectionShelf(page);
  const dash = () => routeInk(page, "route-ui-1", "stroke-dasharray");
  const stroke = () => routeInk(page, "route-ui-1", "stroke");
  expect((await readComponentCode(page)).appearance).toEqual({
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
  await expect.poll(dash).toBe("6 4");
  await expect.poll(stroke).toBe("#dc2626");
  const arrow = page.locator(
    '[data-layer="routes"] [data-role="route-direction-arrow"]',
  );
  await expect(arrow).toHaveAttribute("data-arrow-position", "end");
  await expect(arrow).toHaveAttribute("fill", "#dc2626");
  await editComponentPropertyCode(page, (code) => {
    code.appearance.lineStyle = "dotted";
  });
  await expect.poll(dash).toBe("2 3");
  await page.getByTestId("draw-tool-undo").click();
  expect((await readComponentCode(page)).appearance.lineStyle).toBe("dashed");
  await expect.poll(dash).toBe("6 4");
  await page.getByTestId("draw-tool-redo").click();
  expect((await readComponentCode(page)).appearance.lineStyle).toBe("dotted");
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
  await openProjectFile(page, saved, "styled-wire.icproj.json");
  await clickRoute(page, "route-ui-1");
  await openSelectionShelf(page);
  expect((await readComponentCode(page)).appearance.lineStyle).toBe("dotted");
  await expect.poll(stroke).toBe("#dc2626");
  await editComponentPropertyCode(page, (code) => {
    code.appearance = { lineStyle: "solid", directionArrow: "middle" };
  });
  await expect.poll(dash).toBeNull();
  await expect(arrow).toHaveAttribute("data-arrow-position", "middle");
  await expect(arrow).toHaveAttribute("pointer-events", "none");
  // Auto restores the Razavi default ink, and no arrow clears the marker.
  await editComponentPropertyCode(page, (code) => {
    code.color = "auto";
    code.appearance.directionArrow = "none";
  });
  await expect.poll(stroke).toBe("#000");
  await expect(arrow).toHaveCount(0);
  expect((await readComponentCode(page)).color).toBe("auto");

  // A new name and global scope in one JSON edit land as one global name
  // claim in one revision, and one Undo takes both back.
  const revision = Number(await page.getByTestId("revision").textContent());
  await editComponentPropertyCode(page, (code) => {
    code.name = "SIGNAL";
    code.net.scope = "global";
  });
  await expect(page.getByTestId("revision")).toHaveText(String(revision + 1));
  expect(
    (await exportedProject(page)).documents[0].connectivityEvidence,
  ).toContainEqual(
    expect.objectContaining({
      kind: "name-claim",
      name: "SIGNAL",
      scope: "global",
      owner: { kind: "net-label", annotationId: "net-label-route-ui-1" },
    }),
  );
  await page.getByTestId("draw-tool-undo").click();
  expect(await readComponentCode(page)).toMatchObject({
    name: "",
    net: { scope: "local" },
  });
});

test("Shift-click gathers wires, and one color change restyles all of them", async ({
  page,
}) => {
  await page.goto("/editor");
  await placeComponent(page, "resistor", { x: 280, y: 180 });
  await placeComponent(page, "resistor", { x: 480, y: 180 });
  await placeComponent(page, "resistor", { x: 680, y: 180 });
  await drawWire(page, "R1-2", "R2-1");
  await drawWire(page, "R2-2", "R3-1");
  const first = page.getByTestId("route-hit-route-ui-1");
  const second = page.getByTestId("route-hit-route-ui-2");

  await clickRoute(page, "route-ui-1");
  await page.keyboard.down("Shift");
  await clickRoute(page, "route-ui-2");
  await page.keyboard.up("Shift");
  await expectStatus(page, "Added wire route-ui-2 to the selection");
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
