// Placing, moving and editing labels: instance and Net labels, the L shortcut,
// free text and the canvas text editor.

import { parseSavedProject } from "./editor-fixtures";
import { createRoutePath } from "@icm/model";
import { expect, test } from "@playwright/test";
import { createRoutingDemoProject } from "../src/demos/routing-demo.js";
import {
  revealPropertiesShelf,
  clickDrawTool,
  downloadBytes,
  editComponentPropertyCode,
  readComponentPropertyCode,
} from "./editor-fixtures.js";
import {
  placeComponent,
  openSelectionShelf,
} from "./manual-editor-fixtures.js";
import { clickRoute, selectRichTextOffsets } from "./canvas-fixtures.js";

test("Alt selects an attached label without its host, and the label then drags alone", async ({
  page,
}) => {
  await page.goto("/editor");
  await placeComponent(page, "resistor", { x: 320, y: 220 });

  // The placed component is initially selected and therefore owns an
  // overlapping drag. Alt cycles to the label once; subsequent drags remain
  // sticky to that explicit selection.
  const label = page.getByTestId("annotation-hit-instance-label-R1");
  await label.click({ modifiers: ["Alt"] });
  await expect(label).toHaveClass(/hit-target/u);
  await expect(label).toHaveClass(/selected/u);
  await revealPropertiesShelf(page);
  await expect(page.getByTestId("selection-shelf")).toContainText(
    "Annotation · instance-label",
  );
  const host = await page.getByTestId("hit-R1").boundingBox();
  const before = (await label.boundingBox())!;
  // Text uses the same one-gesture threshold as a component.
  await label.dragTo(page.getByTestId("schematic-canvas"), {
    targetPosition: { x: 470, y: 330 },
  });
  const after = (await label.boundingBox())!;
  expect(after.x).not.toBe(before.x);
  expect(after.y).not.toBe(before.y);
  expect(await page.getByTestId("hit-R1").boundingBox()).toEqual(host);
});

test("L labels a selected wire or snaps near an unselectable wire", async ({
  page,
}) => {
  await page.goto("/editor");
  await placeComponent(page, "resistor", { x: 280, y: 180 });
  await placeComponent(page, "resistor", { x: 480, y: 180 });
  await clickDrawTool(page, "wire");
  await page.getByTestId("terminal-R1-2").click();
  await page.getByTestId("terminal-R2-1").click();
  await page.keyboard.press("Escape");

  // The selection-first flow opens the same rich editor used after creation,
  // then remains a one-step commit after Apply.
  await clickRoute(page, "route-ui-1", 0.7, 0);
  await page.keyboard.press("l");
  const editor = page.getByTestId("net-label-editor");
  await expect(editor).toBeVisible();
  const editorBox = await editor.boundingBox();
  expect(editorBox?.width).toBeGreaterThan(250);
  expect(editorBox?.height).toBeGreaterThan(100);
  // The editor paints above every canvas hit target.
  expect(
    await editor.evaluate((element) => {
      const hitTargets = [
        ...(element
          .closest('[data-layer="editor-overlay"]')
          ?.querySelectorAll('[data-testid*="-hit-"]') ?? []),
      ];
      return (
        hitTargets.length > 0 &&
        hitTargets.every(
          (target) =>
            (target.compareDocumentPosition(element) &
              Node.DOCUMENT_POSITION_FOLLOWING) !==
            0,
        )
      );
    }),
  ).toBe(true);
  await expect(editor.getByRole("button", { name: "Italic" })).toBeVisible();
  const richEditor = editor.getByRole("textbox", {
    name: "Canvas text editor",
  });
  await richEditor.fill("SIGNAL");
  await selectRichTextOffsets(richEditor, 1, 6);
  await editor.getByRole("button", { name: "Subscript" }).click();
  await editor.getByRole("button", { name: "Apply text changes" }).click();
  const preview = page.getByTestId("net-label-placement-preview");
  await expect(preview).toHaveCount(0);
  await expect(page.locator('[data-layer="annotations"]')).toContainText(
    "SIGNAL",
  );
  await expect(
    page.locator(
      '[data-object-id="net-label-route-ui-1"] [data-text-run="subscript"]',
    ),
  ).toHaveCount(1);
  await expect(page.getByTestId("flightline")).toHaveCount(0);
  await page.keyboard.press("Delete");
  await expect(
    page.getByTestId("annotation-hit-net-label-route-ui-1"),
  ).toHaveCount(0);
  await expect(page.getByTestId("flightline")).toHaveCount(0);

  // Selection Filter must not disable an electrical creation target.
  await page.keyboard.press("Control+Shift+f");
  const filter = page.getByTestId("selection-filter-popover");
  await filter.getByRole("button", { name: "None" }).click();
  await filter.getByRole("button", { name: "Close" }).click();

  await page.keyboard.press("l");
  await richEditor.fill("VREF");
  await editor.getByRole("button", { name: "Apply text changes" }).click();
  await expect(preview).toContainText("VREF");
  const routePoint = await page
    .getByTestId("route-hit-route-ui-1")
    .evaluate((element) => {
      const polyline = element as SVGPolylineElement;
      const first = polyline.points.getItem(0);
      const second = polyline.points.getItem(1);
      const matrix = polyline.getScreenCTM();
      if (!first || !second || !matrix) return null;
      const point = new DOMPoint(
        first.x + (second.x - first.x) * 0.25,
        first.y + (second.y - first.y) * 0.25,
      ).matrixTransform(matrix);
      return { x: point.x, y: point.y };
    });
  if (!routePoint) throw new Error("Route is not measurable");
  await page.mouse.move(routePoint.x, routePoint.y + 9);
  // An SVG line has zero CSS width/height, so assert its rendered presence
  // rather than Playwright's box-based visibility heuristic.
  await expect(page.locator(".smart-snap-guide")).toHaveCount(1);
  await page.mouse.click(routePoint.x, routePoint.y + 9);
  await expect(preview).toHaveCount(0);
  await expect(page.locator('[data-layer="annotations"]')).toContainText(
    "VREF",
  );
  await expect(page.getByTestId("route-hit-route-ui-1")).not.toHaveClass(
    /selected/,
  );

  await page.keyboard.press("l");
  await richEditor.fill("CANCELLED");
  await richEditor.press("Escape");
  await expect(editor).toHaveCount(0);
  await expect(page.locator('[data-layer="annotations"]')).not.toContainText(
    "CANCELLED",
  );

  await page.keyboard.press("l");
  await richEditor.fill("");
  await editor.getByRole("button", { name: "Apply text changes" }).click();
  await expect(editor).toBeVisible();
  await expect(page.getByTestId("status")).toContainText(
    "name cannot be empty",
  );
  await richEditor.press("Escape");
});

test("canvas text editor cancels explicitly and commits on Escape or outside click", async ({
  page,
}) => {
  await page.goto("/editor");
  await placeComponent(page, "resistor", { x: 420, y: 280 });
  const rendered = page.locator('[data-object-id="instance-label-R1"]');

  await page.getByTestId("annotation-hit-instance-label-R1").dblclick();
  await page.keyboard.press("Control+a");
  await page.keyboard.type("RA");
  await page.getByRole("button", { name: "Cancel text changes" }).click();
  await expect(rendered).toContainText("R1");
  await expect(page.getByTestId("canvas-text-editor")).toHaveCount(0);
  await expect(page.getByTestId("revision")).toHaveText("1");

  await page.getByTestId("annotation-hit-instance-label-R1").dblclick();
  await page.keyboard.press("Control+a");
  await page.keyboard.type("RA");
  await page.keyboard.press("Escape");
  await expect(rendered).toContainText("RA");
  await expect(page.getByTestId("revision")).toHaveText("2");

  await page.getByTestId("annotation-hit-instance-label-R1").dblclick();
  await page.keyboard.press("Control+a");
  await page.keyboard.type("RB");
  await page
    .getByTestId("schematic-canvas")
    .click({ position: { x: 60, y: 60 } });
  await expect(rendered).toContainText("RB");
  await expect(page.getByTestId("revision")).toHaveText("3");
});

// A dragged Net Label turns free and keeps its Net (annotation-drag-model's
// "freely places a routed Net Label while retaining its Net binding"), a
// press on its text wins over the wire beneath (canvas-hit-resolver's
// "prefers visible annotation text over an overlapping conductor"), and its
// tether is label-tether's.
test("keeps the rich-text editor outside its target and shields canvas input", async ({
  page,
}) => {
  await page.goto("/editor");
  await placeComponent(page, "resistor", { x: 420, y: 280 });
  const label = page.getByTestId("annotation-hit-instance-label-R1");
  await label.dblclick();

  const overlay = page.getByTestId("canvas-text-editor");
  await expect(overlay).toBeVisible();
  const [labelBox, overlayBox, componentBox] = await Promise.all([
    label.boundingBox(),
    overlay.boundingBox(),
    page.getByTestId("hit-R1").boundingBox(),
  ]);
  if (!labelBox || !overlayBox || !componentBox) {
    throw new Error("Text editor geometry is not measurable");
  }
  expect(
    overlayBox.y + overlayBox.height <= labelBox.y ||
      overlayBox.y >= labelBox.y + labelBox.height,
  ).toBe(true);

  await page.mouse.move(
    overlayBox.x + overlayBox.width / 2,
    overlayBox.y + overlayBox.height - 4,
  );
  await page.mouse.down();
  await page.mouse.move(
    overlayBox.x + overlayBox.width / 2 + 16,
    overlayBox.y + overlayBox.height - 4,
  );
  await page.mouse.up();
  await expect(overlay).toBeVisible();
  await expect(page.getByTestId("revision")).toHaveText("1");
  expect(await page.getByTestId("hit-R1").boundingBox()).toEqual(componentBox);
});

test("deletes imported Net Labels with non-editor ids", async ({ page }) => {
  const project = createRoutingDemoProject();
  const document = project.documents[0]!;
  document.routes.push(
    createRoutePath({
      id: "route-imported-h",
      netId: "net-h",
      start: { kind: "terminal", instanceId: "A", pinName: "P" },
      end: { kind: "terminal", instanceId: "B", pinName: "P" },
      bends: [],
      modes: ["manual"],
    }),
  );
  document.annotations.push({
    id: "imported-label-horizontal",
    kind: "net-label",
    content: { runs: [{ kind: "text", value: "HORIZONTAL" }] },
    netId: "net-h",
    anchor: { kind: "free", position: { x: 300, y: 280 } },
    alignment: "middle",
    rotation: 0,
    locked: false,
  });
  await page.goto("/editor");
  await page.getByTestId("project-file").setInputFiles({
    name: "legacy-net-label.icproj.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });

  const importedLabel = page.getByTestId(
    "annotation-hit-imported-label-horizontal",
  );
  await importedLabel.click();
  await page.keyboard.press("Delete");
  await expect(importedLabel).toHaveCount(0);
  await page.keyboard.press("Control+z");
  await expect(importedLabel).toHaveCount(1);

  await clickRoute(page, "route-imported-h");
  await openSelectionShelf(page);
  await editComponentPropertyCode(page, (code) => {
    code.name = "";
  });
  await expect(
    page.getByTestId("annotation-hit-imported-label-horizontal"),
  ).toHaveCount(0);
  expect(
    (await readComponentPropertyCode(page)).match(/"name": ""/u),
  ).not.toBeNull();

  // The label was selected alongside the Route. Its deletion must not poison
  // the following atomic Wire deletion or leave a hidden electrical name.
  await page.keyboard.press("Delete");
  await expect(page.getByTestId("route-hit-route-imported-h")).toHaveCount(0);
  await expect(page.getByTestId("status")).toContainText(
    "Deleted wire route-imported-h",
  );
  await page.keyboard.press("Control+z");

  const savedWithoutLabel = await downloadBytes(
    page,
    "File",
    "Export Project File…",
  );
  const savedDocument = parseSavedProject(savedWithoutLabel.toString("utf8"))
    .documents[0];
  expect(savedDocument.annotations).toHaveLength(0);
  expect(savedDocument.connectivityEvidence).not.toContainEqual(
    expect.objectContaining({ kind: "name-claim", netId: "net-h" }),
  );
});

test("keeps a long right-aligned Port label readable while editing", async ({
  page,
}) => {
  await page.goto("/editor");
  const canvas = page.getByTestId("schematic-canvas");
  await page.getByTestId("shapes-chip-port").click();
  await canvas.click({ position: { x: 400, y: 250 } });
  await page.keyboard.press("Escape");

  await page.getByTestId("annotation-hit-instance-label-P1").dblclick();
  const editable = page.locator(".rich-text-editable");
  await expect(editable).toBeVisible();
  await editable.click();
  await page.keyboard.type("VinputDifferentialPositive");

  // The outer foreignObject follows the editor's measured height. The text
  // stays fully visible without turning the main editing surface into a
  // nested vertical scroller.
  const layout = await page
    .getByTestId("canvas-text-editor")
    .evaluate((element) => {
      const editable = element.querySelector<HTMLElement>(
        ".rich-text-editable",
      );
      const shell = element.querySelector<HTMLElement>(
        ".rich-text-editor-shell",
      );
      return {
        hidden: (editable?.scrollHeight ?? 0) - (editable?.clientHeight ?? 0),
        editableOverflowY: editable ? getComputedStyle(editable).overflowY : "",
        frameHeight: Number(element.getAttribute("height")),
        shellScrollHeight: shell?.scrollHeight ?? 0,
      };
    });
  expect(layout.hidden).toBeLessThanOrEqual(0);
  expect(layout.editableOverflowY).not.toBe("auto");
  expect(layout.editableOverflowY).not.toBe("scroll");
  expect(layout.frameHeight).toBeGreaterThanOrEqual(layout.shellScrollHeight);
});
