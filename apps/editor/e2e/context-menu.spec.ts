import { createEmptyProject } from "@icm/model";
import {
  chooseComponent,
  clickDrawTool,
  placeText,
  clickCommand,
  editDocumentStyleCode,
  openMenu,
  openProject,
} from "./editor-fixtures";
import { expect, test, type Page } from "@playwright/test";

async function captureImageClipboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.clipboard, "write", {
      configurable: true,
      value: async (items: ClipboardItem[]) => {
        if ((window as unknown as { denyClipboard?: boolean }).denyClipboard)
          throw new DOMException("Denied", "NotAllowedError");
        const item = items[0]!;
        const mime = item.types[0]!;
        const blob = await item.getType(mime);
        (
          window as unknown as {
            copiedImage: { mime: string; bytes: number[] };
          }
        ).copiedImage = {
          mime,
          bytes: Array.from(new Uint8Array(await blob.arrayBuffer())),
        };
      },
    });
  });
}

async function placeComponent(
  page: Page,
  symbolId: string,
  position: { x: number; y: number },
): Promise<void> {
  await chooseComponent(page, symbolId);
  await page.getByTestId("schematic-canvas").click({ position });
  await page.keyboard.press("Escape");
}

test("right-click on a device only offers direct selection actions", async ({
  page,
}) => {
  await page.goto("/editor");
  await placeComponent(page, "inductor", { x: 360, y: 240 });
  const instance = page.locator('[data-canvas-hit-kind="instance"]').first();
  await instance.click({ button: "right" });
  const menu = page.getByTestId("canvas-context-menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveText([
    "Edit Component Definition (E)",
    "Properties (Q)",
    "Copy (C)",
    "Rotate 90° (R)",
    "Mirror left/right (Shift+R)",
    "Mirror top/bottom (Ctrl+R)",
    "Delete",
  ]);

  await menu.getByRole("menuitem", { name: "Rotate 90° (R)" }).click();
  await expect(
    page.locator('[data-layer="symbols"] [data-object-id] > g').first(),
  ).toHaveAttribute("transform", /rotate\(90\)/u);

  await instance.click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Copy (C)" }).click();
  await expect(menu).toHaveCount(0);
  await page.keyboard.press("v");
  await page
    .getByTestId("schematic-canvas")
    .click({ position: { x: 520, y: 300 } });
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-canvas-hit-kind="instance"]')).toHaveCount(
    2,
  );
});

test("drafting shapes, text and device labels join device selection from either order and share its context menu", async ({
  page,
}) => {
  await page.goto("/editor");
  await placeComponent(page, "resistor", { x: 300, y: 220 });
  await clickDrawTool(page, "rectangle");
  const canvas = page.getByTestId("schematic-canvas");
  await canvas.click({ position: { x: 420, y: 180 } });
  await canvas.click({ position: { x: 540, y: 280 } });
  await page.keyboard.press("Escape");

  const instance = page.locator('[data-canvas-hit-kind="instance"]').first();
  const rectangle = page.getByTestId(/^drafting-hit-rectangle-/);
  const menu = page.getByTestId("canvas-context-menu");
  const expectSharedMenu = async () => {
    await expect(menu).toBeVisible();
    await expect(menu).not.toContainText("Swap device");
    await expect(menu.getByRole("menuitem", { name: "Delete" })).toBeEnabled();
  };

  // Shape first, then Shift+device — the order that used to drop the shape:
  // the outside-press deselect ran before the additive click could compose.
  await canvas.click({ position: { x: 480, y: 180 } });
  await expect(rectangle).toHaveClass(/selected/);
  await instance.click({ modifiers: ["Shift"] });
  await expect(instance).toHaveClass(/selected/);
  await expect(rectangle).toHaveClass(/selected/);

  // Right-clicking the DEVICE member must not shed the shape either: the
  // press acts on the pair, so the shared command surface opens over both.
  // (Shapes do not participate in edge alignment — that boundary is #384's,
  // not this test's — so the mixed menu is asserted, not an Align action.)
  await instance.click({ button: "right" });
  await expectSharedMenu();
  await expect(rectangle).toHaveClass(/selected/);
  await expect(instance).toHaveClass(/selected/);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  // A plain press on empty canvas keeps its meaning: the shape deselects.
  await canvas.click({ position: { x: 640, y: 400 } });
  await expect(rectangle).not.toHaveClass(/selected/);

  // The reverse order composes too. A shape is a stroke-only hit, so the
  // additive click aims at its edge, not the locator's center.
  await instance.click();
  await expect(instance).toHaveClass(/selected/);
  await canvas.click({ position: { x: 480, y: 180 }, modifiers: ["Shift"] });
  await expect(instance).toHaveClass(/selected/);
  await expect(rectangle).toHaveClass(/selected/);

  // The device's own label joins the same way and opens the same menu.
  const annotation = page
    .locator('[data-canvas-hit-kind="annotation"]')
    .first();
  await instance.click();
  await annotation.click({ modifiers: ["Shift"], force: true });
  await expect(instance).toHaveClass(/selected/);
  await expect(annotation).toHaveClass(/selected/);
  await annotation.click({ button: "right", force: true });
  await expectSharedMenu();
  await page.keyboard.press("Escape");

  // Right-clicking an already-selected text keeps the mixed selection and
  // opens the same command surface, here with edge alignment.
  await placeText(page, { x: 450, y: 400 });
  await page.getByRole("textbox", { name: "Canvas text editor" }).fill("BIAS");
  await page.getByRole("button", { name: "Apply text changes" }).click();
  const text = page.getByTestId(/^drafting-hit-note-/);
  await instance.click();
  await text.click({ modifiers: ["Shift"] });
  await expect(instance).toHaveClass(/selected/);
  await expect(text).toHaveClass(/selected/);
  await text.click({ button: "right" });
  await expect(menu).toContainText("Align");
  await expect(menu).not.toContainText("Swap device");
  await page.getByTestId("context-align-left").click();
  await expect(page.getByTestId("status")).toContainText(
    "Aligned 2 selected objects",
  );

  // Pressing the text member drags the whole mixed selection as one body,
  // and one Undo puts both back.
  const instanceBefore = (await instance.boundingBox())!;
  const textBefore = (await text.boundingBox())!;
  const grab = {
    x: textBefore.x + textBefore.width / 2,
    y: textBefore.y + textBefore.height / 2,
  };
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x + 80, grab.y + 60, { steps: 4 });
  await page.mouse.up();
  const instanceAfter = (await instance.boundingBox())!;
  const textAfter = (await text.boundingBox())!;
  // Smart Snap may hold either axis; the contract is one shared translation.
  const shift = {
    x: instanceAfter.x - instanceBefore.x,
    y: instanceAfter.y - instanceBefore.y,
  };
  expect(Math.hypot(shift.x, shift.y)).toBeGreaterThan(0);
  expect(textAfter.x - textBefore.x).toBeCloseTo(shift.x, 0);
  expect(textAfter.y - textBefore.y).toBeCloseTo(shift.y, 0);
  await expect(instance).toHaveClass(/selected/);
  await expect(text).toHaveClass(/selected/);
  await page.keyboard.press("ControlOrMeta+Z");
  expect((await instance.boundingBox())!.x).toBeCloseTo(instanceBefore.x, 0);
  expect((await text.boundingBox())!.x).toBeCloseTo(textBefore.x, 0);
});

// Grid 10 is the strict case: y 325 lies off it, so a stray grid snap shows.
// Text alignment never reads the annotation grid.
test("bottom alignment lines up drawn text bottoms off the grid, a repeat is a no-op, and Undo/Redo reverse it", async ({
  page,
}) => {
  const project = createEmptyProject("align-labels", "Align labels");
  const positions = [
    { x: 175, y: 322 },
    { x: 295, y: 325 },
    { x: 400, y: 323 },
  ];
  project.documents[0]!.drafting = {
    objects: positions.map((position, index) => ({
      id: `label-${index + 1}`,
      kind: "text",
      anchor: { kind: "free", position },
      content: {
        runs: [
          { kind: "text", value: "X" },
          {
            kind: "span",
            style: "subscript",
            children: [{ kind: "text", value: String(index + 1) }],
          },
        ],
      },
      alignment: "middle",
      rotation: 0,
      typographyToken: "label",
      zIndex: 0,
      locked: false,
    })),
  };
  await openProject(page, project);
  const labels = page.locator('[data-testid^="drafting-hit-label-"]');
  await expect(labels).toHaveCount(3);
  await editDocumentStyleCode(page, (code) => {
    code.canvas.annotationGrid = 10;
  });
  const labelRects = () =>
    labels.evaluateAll((elements) =>
      elements.map((element) => {
        const bounds = (element as SVGGraphicsElement).getBBox();
        return { x: bounds.x, y: bounds.y, bottom: bounds.y + bounds.height };
      }),
    );
  const before = await labelRects();
  for (let index = 0; index < 3; index += 1)
    await labels.nth(index).click({ modifiers: index === 0 ? [] : ["Shift"] });
  const alignBottom = async () => {
    await labels.last().click({ button: "right" });
    await page.getByTestId("context-align-bottom").click();
  };
  await alignBottom();
  await expect(page.getByTestId("status")).toContainText(
    "Aligned 3 selected objects",
  );
  const after = await labelRects();
  expect(after.map((rect) => rect.x)).toEqual(before.map((rect) => rect.x));
  const bottoms = await page
    .locator('[data-layer="drafting"] [data-kind="draft-text"]')
    .evaluateAll((elements) =>
      elements.map((element) => {
        const bounds = (element as SVGGraphicsElement).getBBox();
        return bounds.y + bounds.height;
      }),
    );
  expect(Math.max(...bottoms) - Math.min(...bottoms)).toBeLessThan(0.01);

  // A second alignment is a true no-op; Undo still reverses the first one.
  await alignBottom();
  await expect(page.getByTestId("status")).toContainText(
    "Selection is already aligned",
  );
  await page.keyboard.press("ControlOrMeta+z");
  expect(await labelRects()).toEqual(before);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  expect(await labelRects()).toEqual(after);
});

test("visual clipboard copies a mixed selection as its formal SVG and a lone Wire as a transparent PNG, reports a denied clipboard, and never touches history", async ({
  page,
}) => {
  await captureImageClipboard(page);
  await page.goto("/editor");
  await placeComponent(page, "resistor", { x: 280, y: 220 });
  await placeComponent(page, "capacitor", { x: 540, y: 320 });
  await placeText(page);
  await page.getByRole("textbox", { name: "Canvas text editor" }).fill("BIAS");
  await page.getByRole("button", { name: "Apply text changes" }).click();
  const resistor = page.locator('[data-canvas-hit-kind="instance"]').first();
  const text = page.locator('[data-canvas-hit-kind="drafting"]').first();
  await resistor.click();
  await text.click({ modifiers: ["Shift"] });
  const canvas = page.getByTestId("schematic-canvas");
  const before = await canvas.locator('[data-layer="formal"]').innerHTML();
  await text.click({ button: "right" });
  await expect(page.getByTestId("canvas-context-menu")).not.toContainText(
    "Copy as SVG",
  );
  await page.keyboard.press("Escape");
  const copyImage = async (format: "SVG" | "PNG") => {
    const editMenu = await openMenu(page, "Edit");
    await editMenu
      .getByRole("button", {
        name: `Copy selection as ${format}`,
        exact: true,
      })
      .click();
    await expect(page.getByTestId("status")).toHaveText(
      `Copied selection as ${format}`,
    );
    return page.evaluate(
      () =>
        (
          window as unknown as {
            copiedImage: { mime: string; bytes: number[] };
          }
        ).copiedImage,
    );
  };
  const copied = await copyImage("SVG");
  const svg = Buffer.from(copied.bytes).toString("utf8");
  expect(copied.mime).toBe("image/svg+xml");
  expect(svg).toContain('data-symbol-id="resistor"');
  expect(svg).not.toContain('data-symbol-id="capacitor"');
  expect(svg).toContain("BIAS");
  expect(svg).not.toMatch(
    /hit-target|selection-halo|flightline|editor-overlay/,
  );
  expect(await canvas.locator('[data-layer="formal"]').innerHTML()).toBe(
    before,
  );
  await expect(resistor).toHaveClass(/selected/);
  await expect(text).toHaveClass(/selected/);
  // Empty-canvas right-click preserves the same mixed selection.
  await canvas.click({ button: "right", position: { x: 650, y: 450 } });
  await expect(page.getByTestId("canvas-context-menu")).not.toContainText(
    "Copy as PNG",
  );
  await expect(resistor).toHaveClass(/selected/);
  await expect(text).toHaveClass(/selected/);
  await page.keyboard.press("Escape");

  // A lone Wire rasterizes on a transparent background.
  await clickDrawTool(page, "wire");
  await canvas.click({ position: { x: 300, y: 480 } });
  await canvas.dblclick({ position: { x: 500, y: 480 } });
  await page.keyboard.press("Escape");
  const wire = page.locator('[data-canvas-hit-kind="route"]').first();
  await expect(wire).toHaveCount(1);
  const midpoint = await wire.evaluate((element) => {
    const line = element as SVGPolylineElement;
    const from = line.points.getItem(0);
    const to = line.points.getItem(1);
    const point = new DOMPoint(
      (from.x + to.x) / 2,
      (from.y + to.y) / 2,
    ).matrixTransform(line.getScreenCTM()!);
    return { x: point.x, y: point.y };
  });
  await page.mouse.click(midpoint.x, midpoint.y, { button: "right" });
  await page.keyboard.press("Escape");
  const raster = await copyImage("PNG");
  const png = await page.evaluate(async (bytes) => {
    const bitmap = await createImageBitmap(
      new Blob([new Uint8Array(bytes)], { type: "image/png" }),
    );
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const result = {
      width: bitmap.width,
      height: bitmap.height,
      cornerAlpha: pixels[3],
      hasInk: pixels.some((value, index) => index % 4 === 3 && value > 0),
    };
    bitmap.close();
    canvas.width = canvas.height = 0;
    return result;
  }, raster.bytes);
  expect(raster.mime).toBe("image/png");
  expect(png.width).toBeGreaterThan(png.height);
  expect(png.cornerAlpha).toBe(0);
  expect(png.hasInk).toBe(true);

  // A denied clipboard says so and never falls back to a download.
  const downloads: string[] = [];
  page.on("download", (download) =>
    downloads.push(download.suggestedFilename()),
  );
  await page.evaluate(() => {
    (window as unknown as { denyClipboard: boolean }).denyClipboard = true;
  });
  await (
    await openMenu(page, "Edit")
  )
    .getByRole("button", { name: "Copy selection as PNG", exact: true })
    .click();
  await expect(page.getByTestId("status")).toContainText(
    "Clipboard access was denied",
  );
  expect(downloads).toEqual([]);
  // Copying images recorded nothing: one Undo removes the wire.
  await page.keyboard.press("ControlOrMeta+Z");
  await expect(wire).toHaveCount(0);
});

test("Netlist keeps format selection in the project panel while File keeps drawing exports", async ({
  page,
}) => {
  await page.goto("/editor");
  await placeComponent(page, "resistor", { x: 300, y: 220 });
  await placeComponent(page, "capacitor", { x: 550, y: 320 });
  await page.locator('[data-canvas-hit-kind="instance"]').first().click();
  const menu = await openMenu(page, "File");
  await expect(
    menu.getByRole("button", { name: "Export SVG", exact: true }),
  ).toBeHidden();
  // The File menu's contents are file-command-menu.test.tsx's; the copy
  // commands live in neither menu.
  const netlistMenu = await openMenu(page, "Netlist");
  await expect(
    netlistMenu.getByRole("button", {
      name: "Copy SPICE netlist",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    netlistMenu.getByRole("button", {
      name: "Copy Spectre netlist",
      exact: true,
    }),
  ).toHaveCount(0);
  if (
    (await page
      .getByTestId("netlist-panel-toggle")
      .getAttribute("aria-pressed")) !== "true"
  )
    await page.getByTestId("netlist-panel-toggle").click();
  const projectPanel = page.getByRole("region", {
    name: "Live netlist",
    exact: true,
  });
  await expect(projectPanel.getByLabel("Netlist format")).toBeVisible();
  await openMenu(page, "File");
  await menu.getByRole("button", { name: "Export", exact: true }).click();
  await expect(
    menu.getByRole("button", { name: "Export SVG", exact: true }),
  ).toBeVisible();
  const viewBox = await page
    .getByTestId("schematic-canvas")
    .getAttribute("viewBox");
  await menu
    .getByRole("button", { name: "Export", exact: true })
    .press("ArrowRight");
  await expect(
    menu.getByRole("button", { name: "Export Project File…", exact: true }),
  ).toBeFocused();
  expect(
    await page.getByTestId("schematic-canvas").getAttribute("viewBox"),
  ).toBe(viewBox);
  await menu
    .getByRole("button", { name: "Export Project File…", exact: true })
    .press("ArrowLeft");
  await expect(
    menu.getByRole("button", { name: "Export", exact: true }),
  ).toBeFocused();
  await expect(
    menu.getByRole("button", { name: "Export SVG", exact: true }),
  ).toBeHidden();
  const download = page.waitForEvent("download");
  await clickCommand(page, "File", "Export SVG");
  const stream = await (await download).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const svg = Buffer.concat(chunks).toString("utf8");
  expect(svg).toContain('data-symbol-id="resistor"');
  expect(svg).toContain('data-symbol-id="capacitor"');
  // The command done, the header's menu closes.
  await expect(page.getByTestId("project-menu")).not.toHaveAttribute("open");
});
