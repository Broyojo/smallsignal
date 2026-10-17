import { expect, test, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

import {
  awaitEditorReady,
  closeProjectTools,
  openProjectFile,
  setComponentParameter,
} from "./editor-fixtures.js";

// The Small-Signal panel as a person uses it: open a drawing, open the
// panel, read the status, the formulas and the numbers.
//
// Runs against the e2e build by default, or against a deployed site with a
// base path: ICM_E2E_BASE_URL=https://broyojo.com/smallsignal.

const deployed = process.env.ICM_E2E_BASE_URL?.replace(/\/+$/u, "");

// A deployed site's service worker would answer requests before page.route.
test.use({ serviceWorkers: "block" });

const fixture = (path: string) =>
  readFileSync(new URL(`../../../${path}`, import.meta.url));
const FIXTURES = {
  csWired: "packages/small-signal/test-fixtures/cs-vdd-pin-wired.icproj.json",
  csOpen: "packages/small-signal/test-fixtures/cs-vdd-pin-open.icproj.json",
  csSource: "apps/editor/src/examples/simulation-common-source.icproj.json",
  diffPair:
    "apps/editor/src/examples/current-mirror-loaded-differential-pair.icproj.json",
  ota: "apps/editor/src/examples/five-transistor-ota-sky130.icproj.json",
  rc: "apps/editor/src/examples/simulation-rc.icproj.json",
  rlc: "apps/editor/src/examples/simulation-rlc.icproj.json",
} as const;

/**
 * Console errors, uncaught exceptions and failed requests (by URL, since the
 * console only says "Failed to load resource"), checked after every scenario.
 */
let consoleErrors: string[] = [];
let allowedErrors: RegExp[] = [];

test.beforeEach(async ({ page }) => {
  consoleErrors = [];
  allowedErrors = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    // Reported with its URL by the response listener below.
    if (/^Failed to load resource/u.test(message.text())) return;
    consoleErrors.push(message.text());
  });
  page.on("response", (response) => {
    if (response.status() >= 400)
      consoleErrors.push(
        `HTTP ${response.status()} ${response.request().method()} ${response.url()}`,
      );
  });
  page.on("pageerror", (error) => consoleErrors.push(String(error)));
});

// A known issue can be waived explicitly for one run, e.g. against a site
// that has it: ICM_E2E_ALLOW_ERRORS='tokenzhang-favicon'.
const waived = process.env.ICM_E2E_ALLOW_ERRORS
  ? [new RegExp(process.env.ICM_E2E_ALLOW_ERRORS, "u")]
  : [];

test.afterEach(async ({ page }, testInfo) => {
  await page.screenshot({
    path: `test-results/small-signal/${testInfo.title.replace(/\W+/gu, "-")}${deployed ? "-deployed" : ""}.png`,
  });
  expect(
    consoleErrors.filter(
      (text) =>
        ![...allowedErrors, ...waived].some((pattern) => pattern.test(text)),
    ),
  ).toEqual([]);
});

async function openEditor(page: Page): Promise<void> {
  // The deployed site serves the editor at its base path's root.
  await page.goto(deployed ? `${deployed}/` : "/editor");
  await awaitEditorReady(page);
}

/** Open a project file the way File > Import Project File does, then the panel. */
async function analyze(page: Page, path: string): Promise<Locator> {
  await openEditor(page);
  await openProjectFile(page, fixture(path), path.split("/").pop());
  return openPanel(page);
}

async function openPanel(page: Page): Promise<Locator> {
  const toggle = page.getByTestId("small-signal-toggle");
  if ((await toggle.getAttribute("aria-pressed")) !== "true")
    await toggle.click();
  const panel = page.getByTestId("small-signal-panel");
  await expect(panel).toBeVisible();
  return panel;
}

const card = (panel: Locator, name: string) =>
  panel.getByRole("region", { name, exact: true });

/** The number a card's header shows, e.g. -4.191 or 9.804 (kΩ). */
async function cardValue(panel: Locator, name: string): Promise<number> {
  const text = (await card(panel, name).locator("header strong").innerText())
    .replace(/−/gu, "-")
    .trim();
  const match = /^(-?[\d.]+(?:e[+-]?\d+)?)\s*([pnµmkMG]?)/u.exec(text);
  if (!match) throw new Error(`no number in "${text}"`);
  const scale: Record<string, number> = {
    p: 1e-12,
    n: 1e-9,
    µ: 1e-6,
    m: 1e-3,
    "": 1,
    k: 1e3,
    M: 1e6,
    G: 1e9,
  };
  return Number(match[1]) * scale[match[2] ?? ""]!;
}

/** A card's main formula: a typeset image, never a placeholder or raw TeX. */
async function formula(panel: Locator, name: string): Promise<string> {
  const section = card(panel, name);
  const image = section.locator("img.small-signal-formula").first();
  await expect(image).toBeVisible({ timeout: 15_000 });
  await expect(section.locator(".small-signal-formula-pending")).toHaveCount(0);
  // Raw TeX is never what a person sees.
  await expect(section.locator("code.small-signal-latex-source")).toHaveCount(
    0,
  );
  return (await image.getAttribute("alt")) ?? "";
}

/** gm and ro as the Bias point card prints them for one transistor. */
async function biasLine(panel: Locator, device: string) {
  const line = card(panel, "Bias point")
    .locator("li")
    .filter({ has: panel.page().locator("b", { hasText: device }) });
  await expect(line).toHaveCount(1);
  const text = await line.innerText();
  const quantity = (symbol: RegExp) => {
    const match = symbol.exec(text);
    if (!match) throw new Error(`no ${symbol} in "${text}"`);
    const scale: Record<string, number> = {
      n: 1e-9,
      µ: 1e-6,
      m: 1e-3,
      "": 1,
      k: 1e3,
      M: 1e6,
    };
    return Number(match[1]) * scale[match[2] ?? ""]!;
  };
  return {
    region: await line.locator(".small-signal-region").innerText(),
    gm: quantity(/gm\s*([\d.]+)\s*([nµmkM]?)S/u),
    ro: quantity(/ro\s*([\d.]+)\s*([nµmkM]?)Ω/u),
  };
}

const parallel = (a: number, b: number) => (a * b) / (a + b);

test("common-source drawn with a VDD Pin: −gm(ro ∥ R1), saturated, follows the supply", async ({
  page,
}) => {
  const panel = await analyze(page, FIXTURES.csWired);
  await expect(panel.locator(".small-signal-alert.is-ok")).toHaveText(
    "M1 is in saturation.",
  );
  await expect.poll(() => cardValue(panel, "Gain")).toBeCloseTo(-4.19, 2);
  expect(await formula(panel, "Gain")).toContain("\\parallel R_{1}");
  await expect(
    card(panel, "Output impedance").locator("header strong"),
  ).toHaveText(/kΩ/u);
  const m1 = await biasLine(panel, "M1");
  expect(m1.region).toBe("saturation");
  // The number agrees with the bias it was linearized around (4 digits shown).
  expect(await cardValue(panel, "Gain")).toBeCloseTo(
    -m1.gm * parallel(m1.ro, 10e3),
    2,
  );

  // A higher supply raises V_DS, so I_D and gm grow (level 1: β(1+λV_DS)).
  await panel.locator("details.small-signal-options > summary").click();
  await panel.getByLabel("Supply voltage").fill("3.3");
  await expect.poll(() => cardValue(panel, "Gain")).toBeLessThan(-4.2);
  await expect(panel.locator(".small-signal-alert.is-ok")).toHaveText(
    "M1 is in saturation.",
  );
  const at3v3 = await biasLine(panel, "M1");
  expect(at3v3.region).toBe("saturation");
  expect(at3v3.gm).toBeGreaterThan(m1.gm);
  expect(await cardValue(panel, "Gain")).toBeCloseTo(
    -at3v3.gm * parallel(at3v3.ro, 10e3),
    2,
  );
});

test("a pin that only looks connected blocks the analysis", async ({
  page,
}) => {
  const panel = await analyze(page, FIXTURES.csOpen);
  await expect(panel.locator(".small-signal-alert.is-error")).toContainText(
    "R1.1 is not connected",
  );
  await expect(card(panel, "Gain")).toHaveCount(0);
  await expect(panel.locator("img.small-signal-formula")).toHaveCount(0);
  const outputs = await panel
    .getByLabel("Output")
    .locator("option")
    .allInnerTexts();
  expect(outputs.filter((name) => /^nc\d+$/u.test(name))).toEqual([]);
});

test("common-source with VDD as a real source: −gm(ro ∥ RD)", async ({
  page,
}) => {
  const panel = await analyze(page, FIXTURES.csSource);
  await expect(panel.locator(".small-signal-alert.is-ok")).toHaveText(
    "M1 is in saturation.",
  );
  expect(await formula(panel, "Gain")).toContain("\\parallel R_{D}");
  expect((await biasLine(panel, "M1")).region).toBe("saturation");
});

test("textbook diff pair: Pins as inputs, hand analysis, then real bias values", async ({
  page,
}) => {
  const panel = await analyze(page, FIXTURES.diffPair);
  const inputs = await panel
    .getByLabel("Input")
    .locator("option")
    .allInnerTexts();
  expect(inputs).toEqual(expect.arrayContaining(["Vin1", "Vin2", "Vb"]));
  const outputs = await panel
    .getByLabel("Output")
    .locator("option")
    .allInnerTexts();
  expect(outputs.filter((name) => /^nc\d+$/u.test(name))).toEqual([]);
  await expect(panel.locator(".small-signal-alert.is-info")).toContainText(
    "Hand analysis",
  );
  await formula(panel, "Gain");
  for (const pin of ["Vin1", "Vin2", "Vb"])
    await expect(panel.getByLabel(`${pin} DC voltage`)).toBeVisible();

  // Level-1 defaults (W = L = 1u): Vb = 0.6 V gives a 1 µA tail; the pair
  // and the PMOS mirror then sit about 0.07 V and 0.1 V above threshold.
  await panel.getByLabel("Vin1 DC voltage").fill("0.9");
  await panel.getByLabel("Vin2 DC voltage").fill("0.9");
  await panel.getByLabel("Vb DC voltage").fill("0.6");
  await expect(panel.locator(".small-signal-alert.is-info")).toHaveCount(0);
  await expect(card(panel, "Bias point")).toBeVisible();
  const regions: Record<string, string> = {};
  for (const device of ["M1", "M2", "M3", "M4", "M5"])
    regions[device] = (await biasLine(panel, device)).region;
  test.info().annotations.push({
    type: "regions",
    description: JSON.stringify(regions),
  });
  expect(Object.values(regions)).toEqual(Array(5).fill("saturation"));
  await expect(panel.locator(".small-signal-alert.is-ok")).toHaveText(
    "All transistors are in saturation.",
  );
  expect(Number.isFinite(await cardValue(panel, "Gain"))).toBe(true);
});

test("textbook diff pair reads like hand analysis: differential, matched, gm(ro ∥ ro)", async ({
  page,
}) => {
  const panel = await analyze(page, FIXTURES.diffPair);
  // The drawn pair is the default input, as a differential drive.
  await expect(panel.getByLabel("Input")).toHaveValue(/^diff:/u);
  await expect(panel.getByLabel("Input").locator("option:checked")).toHaveText(
    "Vin1 − Vin2",
  );
  // Only the real pairs: the mirror and the diff pair, never the tail.
  const chips = panel.getByLabel("Matched pairs").getByRole("button");
  await expect(chips).toHaveText(["M1 = M2", "M3 = M4"]);
  const gain = await formula(panel, "Gain");
  expect(gain).toContain("\\approx");
  expect(gain).toContain("g_{m3,4}");
  expect(gain).toContain("r_{o1,2} \\parallel r_{o3,4}");
  await expect(card(panel, "Gain")).toContainText("assuming");
  await expect(panel.locator(".small-signal-alert.is-warning")).toHaveCount(0);

  // Treating M3 and M4 separately gives back their own symbols.
  await chips.filter({ hasText: "M3 = M4" }).click();
  await expect
    .poll(async () => formula(panel, "Gain"))
    .not.toContain("g_{m3,4}");
});

test("5T OTA with a real bias: saturated, matched, gm(ro ∥ ro)/(1 + CL(…)s)", async ({
  page,
}) => {
  const panel = await analyze(page, FIXTURES.ota);
  await expect(panel.locator(".small-signal-alert.is-ok")).toHaveText(
    "All transistors are in saturation.",
  );
  const chips = panel.getByLabel("Matched pairs").getByRole("button");
  await expect(chips).toHaveCount(2);
  const gain = await formula(panel, "Gain");
  expect(gain).toContain("g_{m1,2}");
  expect(gain).toContain("r_{o1,2} \\parallel r_{o3,4}");
  const value = Math.abs(await cardValue(panel, "Gain"));
  expect(value).toBeGreaterThan(100);
  expect(value).toBeLessThan(5000);
});

test("RC filter: 1/(1 + R1 C1 s) with its pole", async ({ page }) => {
  const panel = await analyze(page, FIXTURES.rc);
  expect(await formula(panel, "Gain")).toContain(
    "\\frac{1}{1 + R_{1} C_{1} s}",
  );
  await expect(card(panel, "Gain")).toContainText("Pole");
});

test("RLC filter: the 2nd-order form with its poles", async ({ page }) => {
  const panel = await analyze(page, FIXTURES.rlc);
  expect(await formula(panel, "Gain")).toContain(
    "\\frac{1}{1 + R_{1} C_{1} s + C_{1} L_{1} s^{2}}",
  );
  // A complex-conjugate pair (the label reads "Pole" for the pair: a known
  // display issue, reported).
  await expect(card(panel, "Gain")).toContainText(
    /Poles? -[\d.]+ k ± j[\d.]+ kHz/u,
  );
});

test("a page left behind by a deploy offers a reload instead of raw TeX", async ({
  page,
}) => {
  // The typesetter is whatever chunk the formula cache imports lazily;
  // answer it 404 as a deploy that replaced it would.
  const retired = new Set<string>();
  await page.route(/\/assets\/[^/]+\.js(\?.*)?$/u, async (route) => {
    const url = new URL(route.request().url());
    const name = url.pathname.split("/").pop()!;
    if (retired.has(name)) return route.fulfill({ status: 404, body: "" });
    const response = await route.fetch();
    const body = await response.text();
    if (body.includes("FORMULA_FONT_UNAVAILABLE"))
      for (const match of body.matchAll(
        /import\(\s*["'`]\.\/([^"'`]+\.js)["'`]\s*\)/gu,
      ))
        retired.add(match[1]!);
    return route.fulfill({ response, body });
  });
  allowedErrors = [
    /^HTTP 404 (GET|HEAD) .*\/assets\/[^/]+\.js/u,
    /Failed to fetch dynamically imported module/u,
  ];
  const panel = await analyze(page, FIXTURES.csWired);
  await expect(
    page.getByRole("button", { name: "Reload to update" }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(panel.locator("img.small-signal-formula")).toHaveCount(0);
  expect(retired.size).toBeGreaterThan(0);
  // The renderer failed, not the formula: never claim it is too long.
  await expect(
    panel.getByText("Too long to display as an equation."),
  ).toHaveCount(0);
});

test("editing R1 re-solves: −gm(ro ∥ 20k)", async ({ page }) => {
  let panel = await analyze(page, FIXTURES.csWired);
  await expect.poll(() => cardValue(panel, "Gain")).toBeCloseTo(-4.19, 2);

  // Properties share the right-hand side with the panel: close it, edit R1
  // as a person would, and reopen.
  await page.getByTestId("small-signal-toggle").click();
  await closeProjectTools(page);
  await page.getByTestId("hit-r1").click();
  const shelf = page.getByTestId("selection-shelf");
  if ((await shelf.getAttribute("aria-expanded")) !== "true")
    await shelf.click();
  await setComponentParameter(page, "value", "20k");

  panel = await openPanel(page);
  await expect(panel.locator(".small-signal-alert.is-ok")).toHaveText(
    "M1 is in saturation.",
  );
  await expect.poll(() => cardValue(panel, "Gain")).toBeLessThan(-7);
  const m1 = await biasLine(panel, "M1");
  expect(await cardValue(panel, "Gain")).toBeCloseTo(
    -m1.gm * parallel(m1.ro, 20e3),
    2,
  );
  expect(await formula(panel, "Gain")).toContain("\\parallel R_{1}");
});
