import { expect, test, type Page } from "@playwright/test";

import {
  awaitEditorReady,
  editDocumentStyleCode,
  readDocumentStyleCode,
  openEditor,
} from "./editor-fixtures";

/** Dispatch one wheel event with a chosen device signature. */
async function wheel(
  page: Page,
  signature: { deltaY: number; deltaX?: number; wheelDeltaY?: number },
): Promise<void> {
  await page.getByTestId("schematic-canvas").evaluate((element, init) => {
    const bounds = element.getBoundingClientRect();
    const event = new WheelEvent("wheel", {
      clientX: bounds.left + bounds.width * 0.3,
      clientY: bounds.top + bounds.height * 0.3,
      deltaX: init.deltaX ?? 0,
      deltaY: init.deltaY,
      bubbles: true,
      cancelable: true,
    });
    if (init.wheelDeltaY !== undefined) {
      Object.defineProperty(event, "wheelDeltaY", { value: init.wheelDeltaY });
    }
    element.dispatchEvent(event);
  }, signature);
}

const width = async (page: Page): Promise<number> =>
  Number(
    (await page.getByTestId("schematic-canvas").getAttribute("viewBox"))!.split(
      " ",
    )[2],
  );

test("arrow keys pan by one screen-space step, a wheel zooms and a trackpad pans, the setting overrides both, and a framed narrow view keeps full-speed pan and zoom range", async ({
  page,
}) => {
  await openEditor(page);
  const canvas = page.getByTestId("schematic-canvas");
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  await canvas.click({
    position: { x: bounds!.width - 12, y: bounds!.height - 12 },
  });
  await expect(canvas).toHaveCSS("outline-style", "none");

  const readViewBox = async () =>
    (await canvas.getAttribute("viewBox"))!.split(" ").map(Number) as [
      number,
      number,
      number,
      number,
    ];
  // Screen pixels per document unit for a camera.
  const visualScale = (view: number[]) =>
    Math.min(bounds!.width / view[2]!, bounds!.height / view[3]!);
  const scrollBehavior = async () =>
    JSON.parse(await readDocumentStyleCode(page)).canvas.scrollBehavior;
  const setScrollBehavior = (behavior: "zoom" | "pan") =>
    editDocumentStyleCode(page, (code) => {
      code.canvas.scrollBehavior = behavior;
    });
  const initial = await readViewBox();
  await page.keyboard.press("ArrowRight");
  await expect.poll(readViewBox).not.toEqual(initial);
  const right = await readViewBox();
  expect(right[2]).toBe(initial[2]);
  expect(right[3]).toBe(initial[3]);
  const initialScale = visualScale(initial);
  expect((right[0] - initial[0]) * initialScale).toBeCloseTo(48, 1);

  await page.keyboard.press("ArrowLeft");
  await expect.poll(readViewBox).toEqual(initial);
  await page.keyboard.press("ArrowDown");
  await expect.poll(readViewBox).not.toEqual(initial);
  const down = await readViewBox();
  expect((down[1] - initial[1]) * initialScale).toBeCloseTo(48, 1);
  await page.keyboard.press("ArrowUp");
  await expect.poll(readViewBox).toEqual(initial);

  expect(await scrollBehavior()).toBe("auto");

  // A detent-quantized signature zooms even though its deltaY is tiny —
  // the case that made a slowly turned mouse wheel pan. Scrolling up
  // zooms in, so the camera narrows.
  const beforeWheel = await width(page);
  await wheel(page, { deltaY: -4, wheelDeltaY: 120 });
  await expect.poll(() => width(page)).toBeLessThan(beforeWheel);

  // The trackpad's 3:1 ratio pans instead, leaving the zoom untouched.
  const afterWheel = await width(page);
  await wheel(page, { deltaY: 40, wheelDeltaY: -120 });
  await expect.poll(() => width(page)).toBe(afterWheel);

  // An explicit choice wins over any evidence: the same trackpad
  // signature now zooms.
  await setScrollBehavior("zoom");
  await wheel(page, { deltaY: -40, wheelDeltaY: 120 });
  await expect.poll(() => width(page)).toBeLessThan(afterWheel);

  // And a mouse detent pans once the person says the device is a surface.
  await setScrollBehavior("pan");
  const beforePan = await width(page);
  await wheel(page, { deltaY: -4, wheelDeltaY: 120 });
  await expect.poll(() => width(page)).toBe(beforePan);

  // The choice survives a reload.
  await page.reload();
  await awaitEditorReady(page);
  expect(await scrollBehavior()).toBe("pan");

  // A framed narrow view keeps full-speed pan and the visual zoom range.
  const beforeFrame = await readViewBox();
  const centerX = bounds!.x + bounds!.width / 2;
  const centerY = bounds!.y + bounds!.height / 2;
  await page.mouse.move(centerX - 30, centerY - 160);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(centerX + 30, centerY + 160, { steps: 6 });
  await page.mouse.up({ button: "right" });
  await expect.poll(readViewBox).not.toEqual(beforeFrame);
  const framed = await readViewBox();
  expect(framed[2] / framed[3]).toBeLessThan(0.5);

  await page.mouse.move(centerX, centerY);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(centerX + 120, centerY, { steps: 6 });
  await page.mouse.up({ button: "middle" });
  await expect.poll(readViewBox).not.toEqual(framed);
  const panned = await readViewBox();
  const framedScale = visualScale(framed);
  expect(Math.abs(panned[0] - framed[0]) * framedScale).toBeCloseTo(120, 0);

  await setScrollBehavior("zoom");
  await canvas.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    for (let index = 0; index < 80; index += 1) {
      element.dispatchEvent(
        new WheelEvent("wheel", {
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
          deltaY: -120,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
  });
  const maximumVisualScale = Math.min(bounds!.width / 120, bounds!.height / 80);
  await expect
    .poll(async () => visualScale(await readViewBox()))
    .toBeCloseTo(maximumVisualScale, 1);
});
