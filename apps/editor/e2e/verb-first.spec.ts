import { expect, test, type Page } from "@playwright/test";

import { chooseComponent } from "./editor-fixtures";

async function placeComponent(
  page: Page,
  symbolId: string,
  position: { x: number; y: number },
): Promise<void> {
  await chooseComponent(page, symbolId);
  await page.getByTestId("schematic-canvas").click({ position });
  await page.keyboard.press("Escape");
}

function instances(page: Page) {
  return page.locator('[data-canvas-hit-kind="instance"]');
}

test("C before selection picks up one copy and only subsequent clicks place it", async ({
  page,
}) => {
  await page.goto("/editor");
  await placeComponent(page, "resistor", { x: 340, y: 220 });
  const canvas = page.getByTestId("schematic-canvas");
  await canvas.click({ position: { x: 700, y: 500 } });
  const original = page.getByTestId("hit-R1");
  const origin = (await original.boundingBox())!;
  const revision = await page.getByTestId("revision").textContent();
  const ghost = page.getByTestId("copy-placement-preview");

  await page.keyboard.press("c");
  await expect(page.getByTestId("status")).toContainText("Copy: click a part");
  await expect(ghost).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("revision")).toHaveText(revision!);
  await page.keyboard.press("c");
  await original.click();
  await expect(ghost).toBeVisible();
  // The pickup click must not leave an overlapping copy on the source.
  await expect(page.getByTestId("instance-count")).toHaveText("1");
  await expect(page.getByTestId("revision")).toHaveText(revision!);
  const first = (await ghost.boundingBox())!;
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 560, box.y + 350);
  const moved = (await ghost.boundingBox())!;
  expect(moved.x).not.toBe(first.x);
  expect(moved.y).not.toBe(first.y);
  expect(await original.boundingBox()).toEqual(origin);
  await canvas.click({ position: { x: 560, y: 350 } });
  await expect(page.getByTestId("instance-count")).toHaveText("2");
  await canvas.click({ position: { x: 650, y: 440 } });
  await expect(page.getByTestId("instance-count")).toHaveText("3");
  await page.keyboard.press("Escape");
  await expect(ghost).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.getByTestId("instance-count")).toHaveText("2");
});

// Delete, M and R pressed with nothing selected arm their verb, and the next
// press on the canvas goes to it (editor-command, pointer-down-router); this
// is the armed verb's real clicks and the Escape that disarms it.
test("Delete, M and R pressed first arm their verb for the next clicks until Escape", async ({
  page,
}) => {
  await page.goto("/editor");
  await placeComponent(page, "resistor", { x: 280, y: 220 });
  await placeComponent(page, "resistor", { x: 460, y: 220 });
  const canvas = page.getByTestId("schematic-canvas");
  const status = page.getByTestId("status");
  const clickPart = async () => {
    const box = (await instances(page).first().boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    return box;
  };
  // Click empty canvas so nothing is selected before pressing the verb key.
  const arm = async (key: string, prompt: string) => {
    await canvas.click({ position: { x: 150, y: 420 } });
    await page.keyboard.press(key);
    await expect(status).toContainText(prompt);
  };

  // Delete repeats until Escape.
  await arm("Delete", "Delete: click");
  await clickPart();
  await expect(instances(page)).toHaveCount(1);
  await expect(status).toContainText("click another");
  await clickPart();
  await expect(instances(page)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(status).toContainText("Cancelled");
  await placeComponent(page, "resistor", { x: 300, y: 250 });
  await clickPart();
  await expect(instances(page)).toHaveCount(1);

  // M: the next click picks the part up, the one after places it.
  await arm("m", "Move: click");
  const before = await clickPart();
  await expect(status).toContainText("Move: move the");
  await page.mouse.move(before.x + 160, before.y + before.height / 2);
  await page.mouse.click(before.x + 160, before.y + before.height / 2);
  const moved = (await instances(page).first().boundingBox())!;
  expect(moved.x).toBeGreaterThan(before.x + 80);

  // R turns the clicked part; Escape must actually stop the armed rotate
  // (the historical gap).
  await arm("r", "Rotate: click");
  await clickPart();
  await expect(status).toContainText("Rotated");
  await expect(
    page.locator('[data-layer="symbols"] [data-object-id] > g').first(),
  ).toHaveAttribute("transform", /rotate\(90\)/u);
  const turned = (await instances(page).first().boundingBox())!;
  await page.keyboard.press("Escape");
  await expect(status).toContainText("Cancelled");
  await clickPart();
  const settled = (await instances(page).first().boundingBox())!;
  expect(Math.abs(settled.width - turned.width)).toBeLessThan(2);
});
