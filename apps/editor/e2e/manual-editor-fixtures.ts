import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  exportedProject,
  placeComponentAt,
  readComponentPropertyCode,
  revealPropertiesShelf,
} from "./editor-fixtures.js";

export async function placeComponent(
  page: Page,
  symbolId: string,
  position: { x: number; y: number },
): Promise<void> {
  await revealPropertiesShelf(page);
  await placeComponentAt(page, symbolId, position);
}

export async function openSelectionShelf(page: Page): Promise<void> {
  await revealPropertiesShelf(page);
  const shelf = page.getByTestId("selection-shelf");
  await expect(shelf).toBeVisible();
  if ((await shelf.getAttribute("aria-expanded")) !== "true") {
    await shelf.click();
  }
}

/**
 * Open the editor on one placed part, click its hit target when one is named,
 * and open its Properties shelf.
 */
export async function openPlacedProperties(
  page: Page,
  symbolId: string,
  position: { x: number; y: number },
  hitTestId?: string,
): Promise<void> {
  await page.goto("/editor");
  await placeComponent(page, symbolId, position);
  if (hitTestId) await page.getByTestId(hitTestId).click();
  await openSelectionShelf(page);
}

/** The selected component's property code, parsed. */
export async function readComponentCode(page: Page): Promise<any> {
  return JSON.parse(await readComponentPropertyCode(page));
}

/** The first document of the Project File > Export Project File… writes. */
export async function exportedDocument(page: Page): Promise<any> {
  return (await exportedProject(page)).documents[0];
}
