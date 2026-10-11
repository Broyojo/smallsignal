// Turning and mirroring parts, marquee selections and the labels a part
// carries.

import { exportedProject, setComponentCodeField } from "./editor-fixtures";
import type { SchematicDocument } from "@icm/model";
import { expect, test } from "@playwright/test";
import {
  placeComponent,
  openSelectionShelf,
} from "./manual-editor-fixtures.js";

test("Ctrl+R mirrors a selected component instead of refreshing", async ({
  page,
}) => {
  await page.goto("/editor");
  await placeComponent(page, "nmos", { x: 340, y: 220 });
  await page.getByTestId("hit-M1").click();
  await page.keyboard.press("Control+r");
  const saved = await exportedProject(page);
  expect(saved.documents[0].instances[0].placement).toMatchObject({
    rotation: 0,
    mirror: "vertical",
  });
});

test("turns and flips a marquee selection as one body, not three parts in place", async ({
  page,
}) => {
  await page.goto("/editor");
  const canvas = page.getByTestId("schematic-canvas");

  await placeComponent(page, "resistor", { x: 220, y: 240 });
  await placeComponent(page, "capacitor", { x: 340, y: 240 });
  await placeComponent(page, "diode", { x: 460, y: 240 });

  const centres = async () =>
    page
      .locator('[data-layer="symbols"] [data-object-id]')
      .evaluateAll((elements) =>
        elements
          .map((element) => {
            const box = (element as SVGGraphicsElement).getBBox();
            return {
              id: element.getAttribute("data-object-id") ?? "",
              x: box.x + box.width / 2,
              y: box.y + box.height / 2,
            };
          })
          .sort((left, right) => left.x - right.x || left.y - right.y),
      );
  const spread = (points: { x: number; y: number }[]) => ({
    x:
      Math.max(...points.map((point) => point.x)) -
      Math.min(...points.map((point) => point.x)),
    y:
      Math.max(...points.map((point) => point.y)) -
      Math.min(...points.map((point) => point.y)),
  });

  const before = await centres();
  expect(before).toHaveLength(3);
  // The three sit in a row, so the row's width dwarfs its height.
  expect(spread(before).x).toBeGreaterThan(100);

  const bounds = (await canvas.boundingBox())!;
  await page.mouse.move(bounds.x + 160, bounds.y + 180);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 540, bounds.y + 310, { steps: 12 });
  await page.mouse.up();
  await expect(page.getByTestId("status")).toContainText("Selected");

  // Flipping left to right reverses the row. Flipping each part about its own
  // centre would have left the order exactly as it was.
  await page.keyboard.press("Shift+R");
  await expect(page.getByTestId("status")).toContainText("as one group");
  expect((await centres()).map((item) => item.id)).toEqual(
    before.map((item) => item.id).reverse(),
  );

  // One 90-degree turn stands the row up: the arrangement itself rotates rather
  // than each symbol spinning where it stands.
  await page.keyboard.press("r");
  const turned = spread(await centres());
  expect(turned.x).toBeLessThan(20);
  expect(turned.y).toBeGreaterThan(100);
});

test("swaps a comparator's + and - without turning the body over", async ({
  page,
}) => {
  await page.goto("/editor");
  const canvas = page.getByTestId("schematic-canvas");
  await placeComponent(page, "comparator", { x: 400, y: 300 });
  await canvas.click({ position: { x: 400, y: 300 } });
  await openSelectionShelf(page);

  const body = page.locator('[data-layer="symbols"] [data-object-id]').first();
  const readBody = () =>
    body.evaluate((element) => ({
      transform: element.getAttribute("transform") ?? "",
      paths: Array.from(element.querySelectorAll("path")).map(
        (path) => path.getAttribute("d") ?? "",
      ),
      // The + is the only vertical stroke among the polarity marks.
      plusMarkY: Array.from(element.querySelectorAll("line"))
        .filter((line) => line.getAttribute("x1") === line.getAttribute("x2"))
        .map(
          (line) =>
            (Number(line.getAttribute("y1")) +
              Number(line.getAttribute("y2"))) /
            2,
        ),
    }));

  const before = await readBody();
  expect(before.plusMarkY).toHaveLength(1);
  expect(before.plusMarkY[0]!).toBeGreaterThan(0);

  await setComponentCodeField(page, "appearance.inputsSwapped", true);
  await expect
    .poll(async () => (await readBody()).plusMarkY)
    .toEqual([-before.plusMarkY[0]!]);

  const after = await readBody();
  // The + crossed to the other input.
  expect(after.plusMarkY[0]!).toBe(-before.plusMarkY[0]!);
  // Everything that is not a polarity mark held still. A reflection would
  // have turned the triangle and the transfer-characteristic glyph over with
  // the marks, and hung a scale() on the body.
  expect(after.paths).toEqual(before.paths);
  expect(after.transform).toBe(before.transform);
  expect(after.transform).not.toContain("scale");
});

test("Properties mirror buttons carry the MOS name and value with the part, and undo restores them", async ({
  page,
}) => {
  await page.goto("/editor");
  await placeComponent(page, "nmos", { x: 340, y: 220 });
  const initial = (await exportedProject(page)).documents[0];
  const labels = (document: SchematicDocument) =>
    document.annotations.filter(
      (annotation) =>
        annotation.anchor.kind === "object" &&
        annotation.anchor.objectId === "M1",
    );
  expect(labels(initial).length).toBeGreaterThan(0);
  await page.getByTestId("hit-M1").click();
  await page.keyboard.press("q");
  await expect(page.getByTestId("selection-shelf")).toBeVisible();
  const editor = page.getByTestId("component-property-code-editor");

  await editor.getByRole("button", { name: "Mirror top to bottom" }).click();
  const flipped = (await exportedProject(page)).documents[0];
  expect(flipped.instances[0].placement.mirror).toBe("vertical");
  expect(labels(flipped)).not.toEqual(labels(initial));
  await editor.getByRole("button", { name: "Mirror top to bottom" }).click();
  expect((await exportedProject(page)).documents[0].annotations).toEqual(
    initial.annotations,
  );

  await editor.getByRole("button", { name: "Mirror left to right" }).click();
  const mirrored = (await exportedProject(page)).documents[0];
  expect(mirrored.instances[0].placement.mirror).toBe("horizontal");
  expect(labels(mirrored).map((label: { id: string }) => label.id)).toEqual(
    labels(initial).map((label) => label.id),
  );
  expect(labels(mirrored)).not.toEqual(labels(initial));
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+z");
  expect((await exportedProject(page)).documents[0].annotations).toEqual(
    initial.annotations,
  );
});
