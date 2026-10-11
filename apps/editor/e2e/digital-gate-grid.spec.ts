import { expect, test, type Page } from "@playwright/test";
import { createEmptyProject } from "@icm/model";
import { serializeProject } from "@icm/project-protocol";

import { awaitEditorReady } from "./editor-fixtures.js";

const gateIds = [
  "xnor-gate",
  "xor-gate",
  "or-gate",
  "nor-gate",
  "inverter",
  "buffer",
  "and-gate",
  "nand-gate",
];

async function screenPoint(page: Page, x: number, y: number) {
  return page.getByTestId("schematic-canvas").evaluate(
    (element, point) => {
      const screen = new DOMPoint(point.x, point.y).matrixTransform(
        (element as SVGSVGElement).getScreenCTM()!,
      );
      return { x: screen.x, y: screen.y };
    },
    { x, y },
  );
}

// Every gate's left-anchored outline and pin joins are razavi-catalog's
// ("left-anchored digital gates"); a turned and mirrored NAND keeping its
// named pins is endpoint.test's, and Routes following a transformed part
// are routing.test's. This is the canvas hit box around the painted gates.
test("digital gates fit their hit boxes to the painted body, not the empty strip beside it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 820 });
  const project = createEmptyProject("digital-grid", "Digital grid");
  project.documents[0]!.instances = gateIds.map((symbolId, index) => ({
    id: `U${index + 1}`,
    symbolId,
    placement: {
      position: { x: 200, y: 80 + index * 60 },
      rotation: 0,
      mirror: "none",
    },
  }));
  await page.goto("/editor");
  await awaitEditorReady(page);
  await page.getByTestId("project-file").setInputFiles({
    name: "digital-grid.icproj.json",
    mimeType: "application/json",
    // Written as a current Project file, so the editor opens it instead of
    // announcing a schema upgrade.
    buffer: Buffer.from(serializeProject(project)),
  });
  await expect(page.getByTestId("status")).toContainText(
    "Opened digital-grid.icproj.json",
  );

  const margins = await page
    .getByTestId("schematic-canvas")
    .evaluate((canvas) =>
      [
        ...canvas.querySelectorAll<SVGGElement>(
          '[data-layer="symbols"] [data-object-id]',
        ),
      ].flatMap((group) => {
        const box = group.getBBox();
        const hit = canvas
          .querySelector<SVGGraphicsElement>(
            `[data-testid="hit-${group.dataset.objectId}"]`,
          )!
          .getBBox();
        return [
          box.x - hit.x,
          box.y - hit.y,
          hit.x + hit.width - box.x - box.width,
          hit.y + hit.height - box.y - box.height,
        ];
      }),
    );
  expect(margins).toHaveLength(32);
  for (const margin of margins) {
    expect(margin).toBeGreaterThanOrEqual(-0.01);
    // Control-polygon bounds add at most a small fraction beyond the
    // painted path plus the editor's four-unit stroke padding.
    expect(margin).toBeLessThan(4.2);
  }

  // The old source viewBox used to capture clicks in this empty left strip.
  const blank = await screenPoint(page, 160, 320);
  await page.mouse.click(blank.x, blank.y);
  await expect(page.getByTestId("hit-U5")).not.toHaveClass(/selected/);
});
