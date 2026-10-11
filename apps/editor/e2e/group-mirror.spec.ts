import { expect, test, type Page } from "@playwright/test";
import {
  createEmptyProject,
  createRoutePath,
  routeBends,
  type CircuitProject,
} from "@icm/model";

import { exportedProject, openProject } from "./editor-fixtures";

async function open(page: Page, project: CircuitProject): Promise<void> {
  await openProject(page, project, "group-mirror.icproj.json");
  await expect(page.getByTestId("status")).toContainText(
    "group-mirror.icproj.json",
  );
}

async function savedDocument(page: Page) {
  return (await exportedProject(page)).documents[0];
}

/** The on-screen midpoint of one wire leg; a thin polyline's CSS box misses. */
async function wireLegPoint(page: Page, routeId: string, leg: number) {
  const route = page.getByTestId(`route-hit-${routeId}`);
  await expect(route).toBeAttached();
  return route.evaluate((element, index) => {
    const line = element as SVGPolylineElement;
    const first = line.points.getItem(index);
    const second = line.points.getItem(index + 1);
    const screen = new DOMPoint(
      (first.x + second.x) / 2,
      (first.y + second.y) / 2,
    ).matrixTransform(line.getScreenCTM()!);
    return { x: screen.x, y: screen.y };
  }, leg);
}

test("a free wire mirrors from its context menu; one held by an unselected part says why it stays", async ({
  page,
}) => {
  const project = createEmptyProject("wire-mirror", "Wire mirror");
  const document = project.documents[0]!;
  document.instances.push({
    id: "R1",
    symbolId: "resistor",
    reference: "R1",
    netlist: { parameters: { value: "1k" } },
    placement: { position: { x: 200, y: 460 }, rotation: 0, mirror: "none" },
  });
  document.nets.push(
    { id: "net-w", terminals: [] },
    { id: "net-held", terminals: [{ instanceId: "R1", pinName: "1" }] },
  );
  document.junctions.push(
    { id: "J1", netId: "net-w", position: { x: 200, y: 200 } },
    { id: "J2", netId: "net-w", position: { x: 320, y: 280 } },
    { id: "J3", netId: "net-held", position: { x: 300, y: 380 } },
  );
  document.routes.push(
    // An L: right along the top, then down.
    createRoutePath({
      id: "wire",
      netId: "net-w",
      start: { kind: "junction", junctionId: "J1" },
      end: { kind: "junction", junctionId: "J2" },
      bends: [{ x: 320, y: 200 }],
      modes: ["manual", "manual"],
    }),
    // Up from the resistor's top pin, then right to a loose end.
    createRoutePath({
      id: "held",
      netId: "net-held",
      start: { kind: "terminal", instanceId: "R1", pinName: "1" },
      end: { kind: "junction", junctionId: "J3" },
      bends: [{ x: 200, y: 380 }],
      modes: ["manual", "manual"],
    }),
  );
  await open(page, project);
  const initial = await savedDocument(page);
  const mirrorFromMenu = async (routeId: string, leg: number) => {
    const point = await wireLegPoint(page, routeId, leg);
    await page.mouse.click(point.x, point.y, { button: "right" });
    await page
      .getByTestId("canvas-context-menu")
      .getByRole("menuitem", { name: "Mirror left/right (Shift+R)" })
      .click();
  };

  await mirrorFromMenu("wire", 0);
  await expect(page.getByTestId("status")).toContainText(
    "Flipped the selection left to right",
  );
  const mirrored = await savedDocument(page);
  const position = (id: string) =>
    mirrored.junctions.find((junction: { id: string }) => junction.id === id)
      .position;
  // About the wire's own centre line, x = 260: left along the top, then down.
  expect(position("J1")).toEqual({ x: 320, y: 200 });
  expect(position("J2")).toEqual({ x: 200, y: 280 });
  const wire = mirrored.routes.find(
    (route: { id: string }) => route.id === "wire",
  );
  expect(routeBends(wire)).toEqual([{ x: 200, y: 200 }]);
  expect(wire.start).toEqual({ kind: "junction", junctionId: "J1" });
  expect(mirrored.nets).toEqual(initial.nets);
  // Mirroring again puts it back exactly.
  await page.keyboard.press("Shift+R");
  expect((await savedDocument(page)).junctions).toEqual(initial.junctions);

  await mirrorFromMenu("held", 1);
  await expect(page.getByTestId("status")).toContainText(
    "Nothing here can mirror",
  );
  const after = await savedDocument(page);
  expect(after.routes).toEqual(initial.routes);
  expect(after.junctions).toEqual(initial.junctions);
});
