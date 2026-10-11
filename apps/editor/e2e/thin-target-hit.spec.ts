import { expect, test, type Page } from "@playwright/test";

import { createEmptyProject, type SchematicDocument } from "@icm/model";
import { builtInSymbols } from "@icm/symbols";

import {
  awaitEditorReady,
  clickDrawTool,
  downloadBytes,
} from "./editor-fixtures";

async function importInstances(
  page: Page,
  instances: SchematicDocument["instances"],
  configureDocument?: (document: SchematicDocument) => void,
) {
  const project = createEmptyProject("analog-hit-bounds", "Analog hit bounds");
  project.documents[0]!.instances = instances;
  configureDocument?.(project.documents[0]!);
  await page.goto("/editor");
  await awaitEditorReady(page);
  await page.getByTestId("project-file").setInputFiles({
    name: "analog-hit-bounds.icproj.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await expect(page.getByTestId(`hit-${instances[0]!.id}`)).toBeVisible();
}

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

test("Analog Block hit boxes closely enclose browser-rendered artwork", async ({
  page,
}) => {
  const blocks = builtInSymbols.filter(
    (symbol) =>
      /^(?:opamp|voltage-amplifier|comparator|differential-transconductance)(?:-|$)/u.test(
        symbol.id,
      ) || ["transconductance", "adc", "dac"].includes(symbol.id),
  );
  expect(blocks).toHaveLength(35);
  const instances: SchematicDocument["instances"] = blocks.map(
    (symbol, index) => ({
      id: `U${index + 1}`,
      symbolId: symbol.id,
      placement: {
        position: {
          x: 100 + (index % 6) * 140,
          y: 100 + Math.floor(index / 6) * 120,
        },
        rotation: 0,
        mirror: "none",
      },
    }),
  );
  // A rotated and a mirrored copy, numbered after the catalogue above.
  instances.push(
    {
      id: `U${blocks.length + 1}`,
      symbolId: "opamp-differential",
      placement: { position: { x: 800, y: 460 }, rotation: 90, mirror: "none" },
    },
    {
      id: `U${blocks.length + 2}`,
      symbolId: "opamp-differential",
      placement: {
        position: { x: 100, y: 580 },
        rotation: 0,
        mirror: "horizontal",
      },
    },
  );
  await importInstances(page, instances);

  // Read SVG geometry independently of the editor's bounds calculation. The
  // outer group includes the renderer's placement transform and upright text.
  const measurements = await page.getByTestId("schematic-canvas").evaluate(
    (canvas, ids) =>
      ids.map((id) => {
        const artworkElement = canvas.querySelector<SVGGraphicsElement>(
          `[data-layer="symbols"] [data-object-id="${id}"]`,
        )!;
        const hitElement = canvas.querySelector<SVGGraphicsElement>(
          `[data-testid="hit-${id}"]`,
        )!;
        const artwork = artworkElement.getBoundingClientRect();
        const hit = hitElement.getBoundingClientRect();
        const matrix = artworkElement.getScreenCTM()!;
        const scale = Math.hypot(matrix.a, matrix.b);
        return {
          id,
          margins: [
            artwork.x - hit.x,
            artwork.y - hit.y,
            hit.x + hit.width - artwork.x - artwork.width,
            hit.y + hit.height - artwork.y - artwork.height,
          ].map((margin) => margin / scale),
        };
      }),
    instances.map((instance) => instance.id),
  );
  for (const { id, margins } of measurements) {
    for (const margin of margins) {
      expect(
        margin,
        `${id}: artwork must be inside hit box`,
      ).toBeGreaterThanOrEqual(-0.01);
      // getBBox excludes stroke; the small margin contains the miter tips.
      expect(margin, `${id}: no source-crop whitespace`).toBeLessThanOrEqual(
        4.01,
      );
    }
  }
});

test("FD Amp blank space does not capture clicks; body and pins remain usable", async ({
  page,
}) => {
  await importInstances(page, [
    {
      id: "U1",
      symbolId: "opamp-differential",
      placement: { position: { x: 200, y: 200 }, rotation: 0, mirror: "none" },
    },
  ]);
  // A one-symbol import auto-fits tightly. Leave room for the whole drag so
  // this checks object movement rather than edge-triggered canvas scrolling.
  for (let step = 0; step < 3; step += 1)
    await page.getByRole("button", { name: "Zoom out" }).click();
  const hit = page.getByTestId("hit-U1");
  const drag = async (
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
  ) => {
    const from = await screenPoint(page, fromX, fromY);
    const to = await screenPoint(page, toX, toY);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();
  };
  // This point is inside the old rectangular hit box but well above the
  // triangle edge and output leads.
  const blank = await screenPoint(page, 215, 175);
  await page.mouse.click(blank.x, blank.y);
  await expect(hit).not.toHaveClass(/selected/);

  // Right-to-left crossing of the old viewBox's blank strip selects nothing.
  await drag(242, 170, 236, 230);
  await expect(hit).not.toHaveClass(/selected/);
  // A left-to-right window enclosing the actual body and pins is sufficient.
  await drag(155, 165, 235, 235);
  await expect(hit).toHaveClass(/selected/);

  await drag(190, 200, 290, 260);
  await expect(hit).toHaveAttribute("transform", /^translate\(300 260\)/u);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(hit).toHaveAttribute("transform", /^translate\(200 200\)/u);

  await page.keyboard.press("Escape");
  await clickDrawTool(page, "wire");
  await page.getByTestId("terminal-U1-IN+").click();
  const end = await screenPoint(page, 100, 190);
  await page.mouse.dblclick(end.x, end.y);
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-canvas-hit-kind="route"]')).toHaveCount(1);
});

test("enlarged Analog Block triangles leave clear space around internal letters in canvas and SVG", async ({
  page,
}) => {
  await importInstances(
    page,
    [
      "opamp-lettered",
      "opamp-differential-lettered",
      "opamp-differential-crossed-lettered-inputs-swapped",
      "voltage-amplifier-lettered",
    ].map((symbolId, index) => ({
      id: `U${index + 1}`,
      symbolId,
      placement: {
        position: {
          x: 150 + (index % 2) * 200,
          y: 150 + Math.floor(index / 2) * 160,
        },
        rotation: 0,
        mirror: "none",
      },
    })),
  );
  const svg = (await downloadBytes(page, "File", "Export SVG")).toString(
    "utf8",
  );
  // Use actual font bounds in both surfaces: symbol-space stroke checks alone
  // cannot tell whether the browser's letter fits between the polarity rows.
  const surfaces = await page.evaluate((source) => {
    const exported = document.createElement("div");
    exported.innerHTML = source;
    exported.style.cssText =
      "position:fixed;left:0;top:0;width:800px;opacity:0;pointer-events:none";
    document.body.append(exported);
    const measure = (root: Element) =>
      [
        ...root.querySelectorAll<SVGGElement>(
          "[data-object-id][data-symbol-id]",
        ),
      ].map((group) => {
        const text = group.querySelector<SVGTextElement>(
          '[data-role="formula-text"]',
        )!;
        const letter = text.getBBox();
        const marks = [
          ...group.querySelectorAll<SVGLineElement>(
            'line[stroke-linecap="round"]',
          ),
        ];
        return {
          id: group.getAttribute("data-object-id"),
          gaps: marks.map((mark) => {
            const box = mark.getBBox();
            const gap = Math.hypot(
              Math.max(
                0,
                box.x - (letter.x + letter.width),
                letter.x - (box.x + box.width),
              ),
              Math.max(
                0,
                box.y - (letter.y + letter.height),
                letter.y - (box.y + box.height),
              ),
            );
            return gap - Number(mark.getAttribute("stroke-width")) / 2;
          }),
        };
      });
    const result = [
      measure(document.querySelector('[data-layer="symbols"]')!),
      measure(exported),
    ];
    exported.remove();
    return result;
  }, svg);
  for (const surface of surfaces) {
    expect(surface).toHaveLength(4);
    for (const { id, gaps } of surface)
      for (const gap of gaps)
        // Font bounding boxes vary by platform. Require real clearance,
        // not an arbitrary one-unit margin that rejects non-overlapping glyphs.
        expect(gap, `${id} letter/polarity clearance`).toBeGreaterThan(0);
  }
});
