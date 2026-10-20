import { expect, test, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

import { awaitEditorReady, openProjectFile } from "./editor-fixtures.js";

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
  csCurrentLoad:
    "packages/small-signal/test-fixtures/cs-current-source-load.icproj.json",
  csSource: "apps/editor/src/examples/simulation-common-source.icproj.json",
  diffPair:
    "apps/editor/src/examples/current-mirror-loaded-differential-pair.icproj.json",
  ota: "apps/editor/src/examples/five-transistor-ota-sky130.icproj.json",
  rc: "apps/editor/src/examples/simulation-rc.icproj.json",
  rlc: "apps/editor/src/examples/simulation-rlc.icproj.json",
  bjtOpAmp: "packages/small-signal/test-fixtures/bjt-op-amp.icproj.json",
  twoStage:
    "packages/small-signal/test-fixtures/two-stage-miller-ota.icproj.json",
  inverter:
    "packages/small-signal/test-fixtures/cmos-inverter-triode.icproj.json",
  fullyDifferential:
    "apps/editor/src/examples/fully-differential-two-stage-op-amp.icproj.json",
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

/** A card's main formula: typeset, never a placeholder or raw TeX. */
async function formula(panel: Locator, name: string): Promise<string> {
  const section = card(panel, name);
  const image = section.locator(".small-signal-formula").first();
  await expect(image).toBeVisible({ timeout: 15_000 });
  await expect(section.locator(".small-signal-formula-pending")).toHaveCount(0);
  // Raw TeX is never what a person sees.
  await expect(section.locator("code.small-signal-latex-source")).toHaveCount(
    0,
  );
  return (await image.getAttribute("data-tex")) ?? "";
}

/** gm and ro as the Bias point card prints them for one transistor. */
async function biasLine(panel: Locator, device: string) {
  const row = card(panel, "Bias point").locator(`tr[data-device="${device}"]`);
  await expect(row).toHaveCount(1);
  // One snapshot of the row, so every number comes from the same solve.
  const cells = await row.evaluate((tr) => {
    const text = (name: string) =>
      tr.querySelector(`td[data-quantity="${name}"]`)?.textContent ?? "";
    return {
      id: text("id"),
      gm: text("gm"),
      ro: text("ro"),
      // The region column only appears when some transistor is not saturated.
      region:
        tr.querySelector(".small-signal-region")?.textContent ?? "saturation",
    };
  });
  const scale: Record<string, number> = {
    n: 1e-9,
    µ: 1e-6,
    m: 1e-3,
    "": 1,
    k: 1e3,
    M: 1e6,
  };
  const quantity = (name: "id" | "gm" | "ro", unit: string) => {
    const text = cells[name];
    if (name === "ro" && text.includes("∞")) return Infinity;
    const match = new RegExp(`([\\d.]+)\\s*([nµmkM]?)${unit}`, "u").exec(text);
    if (!match) throw new Error(`no ${name} in "${text}"`);
    return Number(match[1]) * scale[match[2] ?? ""]!;
  };
  return {
    region: cells.region,
    id: quantity("id", "A"),
    gm: quantity("gm", "S"),
    ro: quantity("ro", "Ω"),
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
  await panel.getByText("Options", { exact: true }).click();
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
  await expect(panel.locator(".small-signal-formula")).toHaveCount(0);
  const outputs = await panel
    .getByLabel("Output", { exact: true })
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
    .getByLabel("Input", { exact: true })
    .locator("option")
    .allInnerTexts();
  expect(inputs).toEqual(expect.arrayContaining(["Vin1", "Vin2", "Vb"]));
  const outputs = await panel
    .getByLabel("Output", { exact: true })
    .locator("option")
    .allInnerTexts();
  expect(outputs.filter((name) => /^nc\d+$/u.test(name))).toEqual([]);
  await expect(panel.locator(".small-signal-alert.is-info")).toContainText(
    "Hand analysis",
  );
  await formula(panel, "Gain");
  // The missing values lead the panel, in Bias point.
  const dc = (pin: string) =>
    card(panel, "Bias point").getByLabel(`${pin} DC`, { exact: true });
  for (const pin of ["Vin1", "Vin2", "Vb"]) await expect(dc(pin)).toBeVisible();

  // Level-1 defaults (W = L = 1u): Vb = 0.6 V gives a 1 µA tail; the pair
  // and the PMOS mirror then sit about 0.07 V and 0.1 V above threshold.
  for (const [pin, volts] of [
    ["Vin1", "0.9"],
    ["Vin2", "0.9"],
    ["Vb", "0.6"],
  ] as const) {
    await dc(pin).fill(volts);
    await dc(pin).press("Enter");
  }
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
  await expect(panel.getByLabel("Input", { exact: true })).toHaveValue(
    /^diff:/u,
  );
  await expect(
    panel.getByLabel("Input", { exact: true }).locator("option:checked"),
  ).toHaveText("Vin1 − Vin2");
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
  const mirror = chips.filter({ hasText: "M3 = M4" });
  await mirror.click();
  await expect(mirror).toHaveAttribute("aria-pressed", "false");
  await expect
    .poll(async () => formula(panel, "Gain"))
    .not.toContain("g_{m3,4}");
});

test("differential output: a drawn Vout1/Vout2 is read across, and any two nets can be", async ({
  page,
}) => {
  const panel = await analyze(page, FIXTURES.fullyDifferential);
  const output = panel.getByLabel("Output", { exact: true });
  // A differential input drives the drawn output pair by default.
  await expect(output.locator("option:checked")).toHaveText("Vout1 − Vout2");
  const across = /^\\frac\{v_\{\w*1\} - v_\{\w*2\}\}\{/u;
  await expect.poll(() => formula(panel, "Gain")).toMatch(across);
  const plus = panel.getByLabel("Output +", { exact: true });
  const minus = panel.getByLabel("Output −", { exact: true });
  await expect(plus).toHaveValue("Vout1");
  await expect(minus).toHaveValue("Vout2");

  // One side alone: the + and − pickers go.
  await output.selectOption("Vout1");
  await expect(minus).toHaveCount(0);
  await expect
    .poll(() => formula(panel, "Gain"))
    .toMatch(/^\\frac\{v_\{\w*1\}\}\{/u);

  // Any two nets: the difference entry, then either side.
  await output.selectOption({ label: "Difference of two nets…" });
  await expect(plus).toHaveValue("Vout1");
  await minus.selectOption("Vout2");
  await expect(output.locator("option:checked")).toHaveText("Vout1 − Vout2");
  await expect.poll(() => formula(panel, "Gain")).toMatch(across);
  // Ground on the minus side is the single-ended output again.
  await minus.selectOption({ label: "ground" });
  await expect(minus).toHaveCount(0);
  await expect(output).toHaveValue("Vout1");
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
  // Named: the hand limit, with its true error.
  await expect(card(panel, "Gain").locator('[data-approx="named"]')).toHaveText(
    /^ro ≫ R, 1\/gm, within (<0\.1|\d\.\d+)%$/u,
  );
  const value = Math.abs(await cardValue(panel, "Gain"));
  expect(value).toBeGreaterThan(100);
  expect(value).toBeLessThan(5000);
  // Smallest terms finds the same form, unnamed.
  await panel.getByText("Options", { exact: true }).click();
  await panel
    .getByLabel("Approximation", { exact: true })
    .selectOption("terms");
  await expect(
    card(panel, "Gain").locator('[data-approx="named"]'),
  ).toHaveCount(0);
  expect(await formula(panel, "Gain")).toContain(
    "r_{o1,2} \\parallel r_{o3,4}",
  );
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
  await expect(panel.locator(".small-signal-formula")).toHaveCount(0);
  expect(retired.size).toBeGreaterThan(0);
  // The renderer failed, not the formula: never claim it is too long.
  await expect(
    panel.getByText("Too long to display as an equation."),
  ).toHaveCount(0);
});

test("editing R1 in its menu re-solves: −gm(ro ∥ 20k), the panel stays", async ({
  page,
}) => {
  const panel = await analyze(page, FIXTURES.csWired);
  await expect.poll(() => cardValue(panel, "Gain")).toBeCloseTo(-4.19, 2);

  // A double-click opens the part's menu, not Properties: the panel stays.
  await page.getByTestId("hit-r1").dblclick();
  const menu = page.getByTestId("small-signal-device-menu");
  await expect(menu).toHaveAccessibleName("R1");
  await expect(panel).toBeVisible();
  const value = menu.getByRole("textbox", { name: "R1 Value" });
  await expect(value).toHaveValue("10k");
  // Not a number: refused, and the drawing keeps 10k.
  await value.fill("k10");
  await value.press("Enter");
  await expect(value).toHaveAttribute("aria-invalid", "true");
  await value.fill("20k");
  await value.press("Enter");

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
  // One edit of the drawing: undo takes it back.
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => cardValue(panel, "Gain")).toBeCloseTo(-4.19, 2);

  // A transistor's menu has its size; the bias point, its DC values.
  await page.getByTestId("hit-m1").click();
  await expect(menu.getByRole("textbox", { name: "M1 W" })).toBeVisible();
  await expect(menu.getByRole("textbox", { name: "M1 L" })).toBeVisible();
  // Label, field, unit on one row each, units or not (W, L and M have
  // none), and the fields drawn as the panel draws its own.
  for (const name of ["W", "L", "M"]) {
    const field = menu.getByRole("textbox", { name: `M1 ${name}` });
    const label = field.locator("xpath=../span[1]");
    const [a, b] = [await label.boundingBox(), await field.boundingBox()];
    expect(a!.y + a!.height / 2).toBeCloseTo(b!.y + b!.height / 2, 0);
    expect(a!.x + a!.width).toBeLessThan(b!.x);
  }
  expect(
    await menu
      .getByRole("textbox", { name: "M1 W" })
      .evaluate((input) => getComputedStyle(input).borderTopStyle),
  ).toBe("solid");
  await page.keyboard.press("Escape");
  const dc = card(panel, "Bias point").getByRole("group", {
    name: "DC values",
  });
  await expect(dc.getByRole("textbox")).not.toHaveCount(0);
  // More properties: Properties take the dock.
  await page.getByTestId("hit-r1").click();
  await menu.getByRole("button", { name: "More properties" }).click();
  await expect(panel).toBeHidden();
});

test("model parameters are editable: the bias follows the square law", async ({
  page,
}) => {
  const panel = await analyze(page, FIXTURES.csWired);
  await expect.poll(() => cardValue(panel, "Gain")).toBeCloseTo(-4.19, 2);
  const base = await biasLine(panel, "M1");
  // Saturated level 1: gm / I_D = 2 / V_ov, whatever KP and λ are.
  const overdrive = (line: { id: number; gm: number }) =>
    (2 * line.id) / line.gm;

  const models = panel.locator("details.small-signal-options", {
    has: page.locator("summary", { hasText: /^Models/u }),
  });
  await models.locator(":scope > summary").click();
  await expect(models.locator(":scope > summary")).toHaveText("Models");
  const kp = panel.getByLabel("NMOS KP");
  await expect(kp).toHaveAttribute("placeholder", "200u");

  // Twice µCox: more current at the same overdrive.
  await kp.fill("400u");
  await expect(models.locator(":scope > summary")).toHaveText(
    "Models (edited)",
  );
  await expect.poll(() => cardValue(panel, "Gain")).toBeLessThan(-4.3);
  const strong = await biasLine(panel, "M1");
  expect(strong.id).toBeGreaterThan(base.id);
  expect(overdrive(strong)).toBeCloseTo(overdrive(base), 2);

  // 0.1 V lower threshold: exactly 0.1 V more overdrive.
  await kp.fill("");
  await panel.getByLabel("NMOS VTO").fill("0.4");
  await expect
    .poll(async () => overdrive(await biasLine(panel, "M1")))
    .toBeCloseTo(overdrive(base) + 0.1, 2);

  // λ = 0: no channel-length modulation, so r_o is infinite and A = −gm R1.
  await panel.getByLabel("NMOS VTO").fill("");
  await panel.getByLabel("NMOS LAMBDA").fill("0");
  await expect
    .poll(async () => (await biasLine(panel, "M1")).ro)
    .toBe(Infinity);
  const ideal = await biasLine(panel, "M1");
  expect(await cardValue(panel, "Gain")).toBeCloseTo(-ideal.gm * 10e3, 2);

  // An unreadable value is marked and ignored; Reset restores the defaults.
  await panel.getByLabel("NMOS LAMBDA").fill("abc");
  await expect(panel.getByLabel("NMOS LAMBDA")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect.poll(() => cardValue(panel, "Gain")).toBeCloseTo(-4.19, 2);
  await panel.getByLabel("NMOS LAMBDA").fill("0");
  await panel.getByRole("button", { name: "Reset to defaults" }).click();
  await expect(models.locator(":scope > summary")).toHaveText("Models");
  await expect.poll(() => cardValue(panel, "Gain")).toBeCloseTo(-4.19, 2);
});

test("device capacitances from Models add a pole, and neglecting C_gd moves it and removes the zero", async ({
  page,
}) => {
  const panel = await analyze(page, FIXTURES.csWired);
  await expect.poll(() => cardValue(panel, "Gain")).toBeCloseTo(-4.19, 2);
  const gain = card(panel, "Gain");
  // No charge parameters, no capacitances: a flat gain.
  await expect(gain.getByText(/^Poles? /u)).toHaveCount(0);

  await panel.getByText(/^Models/u).click();
  const nmos = panel.locator("fieldset.small-signal-model", {
    has: page.locator("legend", { hasText: "NMOS" }),
  });
  const caps = nmos.locator("details.small-signal-model-caps");
  await caps.locator("summary").click();
  await expect(panel.getByLabel("NMOS TOX")).toHaveAttribute(
    "placeholder",
    "0",
  );
  await panel.getByLabel("NMOS TOX").fill("20n");
  await panel.getByLabel("NMOS CGDO").fill("3e-10");
  await panel.getByLabel("NMOS CBD").fill("10f");
  await expect(caps.locator("summary")).toHaveText("Capacitances (3 set)");
  // The output node's C_gd + C_db: one pole, and the Miller zero g_m/C_gd.
  await expect(gain.locator("small").getByText(/^Pole /u)).toBeVisible();
  await expect.poll(() => formula(panel, "Gain")).toContain("C_{gd1}");
  expect(await formula(panel, "Gain")).toContain("C_{db1}");

  // Assumptions: the Caps cell neglects C_gd alone.
  const section = await assumptions(panel);
  const cell = section.locator("details.small-signal-caps").filter({
    has: page.getByLabel("M1 caps", { exact: true }),
  });
  await expect(cell.locator("summary")).toHaveText("none");
  await cell.locator("summary").click();
  await neglect(section, "M1 cgd").check();
  await expect(cell.locator("summary")).toHaveText("Cgd");
  await expect.poll(() => formula(panel, "Gain")).not.toContain("C_{gd1}");
  const table = gain.getByRole("table", { name: "Full model and assumed" });
  // The pole moves (C_db alone) with its Δ, the zero goes.
  const pole = table.locator('tr[data-root="pole"]');
  await expect(pole).toHaveCount(1);
  await expect(pole.locator('td[data-quantity="assumed"]')).not.toHaveText(
    "removed",
  );
  await expect(pole.locator('td[data-quantity="delta"]')).toHaveText(/%$/u);
  const zero = table.locator('tr[data-root="zero"]');
  await expect(zero.locator('td[data-quantity="assumed"]')).toHaveText(
    "removed",
  );
  await page.screenshot({
    path: test.info().outputPath("device-caps-assumptions.png"),
    fullPage: false,
  });
});

test("stored model values: malformed ones are dropped, every edit shows, Reset clears all", async ({
  page,
}) => {
  // A PMOS override from another circuit, next to a malformed NMOS entry.
  await page.addInitScript(() => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.setItem(
      "smallsignal.models",
      JSON.stringify({ nmos: { KP: 1, VTO: "0.4" }, pmos: { VTO: "-0.3" } }),
    );
  });
  const panel = await analyze(page, FIXTURES.csWired);
  const summary = panel.getByText(/^Models/u);
  await expect(summary).toHaveText("Models (edited)");
  await summary.click();
  await expect(panel.getByLabel("NMOS KP")).toHaveValue("");
  await expect(panel.getByLabel("NMOS VTO")).toHaveValue("0.4");
  // Not in this circuit, but edited: shown rather than applied unseen.
  await expect(panel.getByLabel("PMOS VTO")).toHaveValue("-0.3");

  await panel.getByRole("button", { name: "Reset to defaults" }).click();
  await expect(summary).toHaveText("Models");
  await expect(panel.getByLabel("PMOS VTO")).toHaveCount(0);
  await expect(panel.getByLabel("NMOS VTO")).toHaveValue("");
  expect(
    await page.evaluate(() => localStorage.getItem("smallsignal.models")),
  ).toBe("{}");
});

test("stored model edits stay reachable in a circuit without transistors", async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.setItem(
      "smallsignal.models",
      JSON.stringify({ nmos: { KP: "300u" } }),
    );
  });
  const panel = await analyze(page, FIXTURES.rc);
  const summary = panel.getByText(/^Models/u);
  await expect(summary).toHaveText("Models (edited)");
  await summary.click();
  await expect(panel.getByLabel("NMOS KP")).toHaveValue("300u");
  await panel.getByRole("button", { name: "Reset to defaults" }).click();
  await expect(panel.getByText(/^Models/u)).toHaveCount(0);
});

/** "3.88 nV/√Hz" or "18.7 µV rms" as a number in base units. */
function engineering(text: string): number {
  const match = /(-?[\d.]+(?:e[+-]?\d+)?)\s*([fpnµmkMG]?)[VA]/u.exec(text);
  if (!match) throw new Error(`no number in "${text}"`);
  const scale: Record<string, number> = {
    f: 1e-15,
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

test("noise: the input-referred PSD is 4kT(γ/gm + 1/(gm² R1)), and the band rms follows", async ({
  page,
}) => {
  const panel = await analyze(page, FIXTURES.csWired);
  await expect.poll(() => cardValue(panel, "Gain")).toBeCloseTo(-4.19, 2);
  const { gm } = await biasLine(panel, "M1");
  await panel.getByText("Noise", { exact: true }).click();
  const noise = panel.locator("details.small-signal-noise");
  const image = noise.locator(".small-signal-formula").first();
  await expect(image).toBeVisible({ timeout: 15_000 });
  const alt = (await image.getAttribute("data-tex")) ?? "";
  // Typeset from intact TeX: a lost backslash (\f, \a) shows up here.
  expect(alt).toMatch(
    /^\\frac\{\\overline\{v_\{n,in\}\^\{2\}\}\}\{\\Delta f\} = 4kT/u,
  );
  expect(
    await image.evaluate((span) => span.querySelector("svg")?.clientWidth),
  ).toBeGreaterThan(0);
  expect(alt).toContain("g_{m1}");
  // The channel noise factor as a symbol, with its value said once.
  expect(alt).toContain("\\frac{\\gamma}{g_{m1}}");
  await expect(noise).toContainText("γ = 2/3, the long-channel value.");

  // ngspice's constants, at its default 27 °C.
  const kT = 1.38064852e-23 * 300.15;
  const expected = Math.sqrt(4 * kT * (2 / (3 * gm) + 1 / (gm * gm * 10e3)));
  const density = engineering(
    await noise
      .getByRole("table", { name: "Noise density" })
      .locator('td[data-quantity="input"]')
      .first()
      .innerText(),
  );
  expect(Math.abs(density / expected - 1)).toBeLessThan(2e-3);
  await expect(
    noise.getByRole("table", { name: "Noise sources" }),
  ).toContainText("M1 thermal");

  // No capacitors: the input noise is white, so rms = density·√Δf.
  await noise.getByLabel("Noise band").fill("1, 10meg");
  const rms = noise.locator('td[data-quantity="input-rms"]');
  await expect(rms).toBeVisible();
  const expectedRms = density * Math.sqrt(10e6 - 1);
  expect(
    Math.abs(engineering(await rms.innerText()) / expectedRms - 1),
  ).toBeLessThan(2e-3);
});

test("noise: flicker set in Models shows up in the densities and sources", async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.setItem(
      "smallsignal.models",
      JSON.stringify({ nmos: { KF: "1e-26" } }),
    );
  });
  const panel = await analyze(page, FIXTURES.csWired);
  await expect.poll(() => cardValue(panel, "Gain")).toBeCloseTo(-4.19, 2);
  await panel.getByText("Noise", { exact: true }).click();
  const noise = panel.locator("details.small-signal-noise");
  await expect(noise).toContainText(
    "Thermal and shot noise. Flicker is in the numbers below.",
    { timeout: 15_000 },
  );
  await expect(
    noise.getByRole("table", { name: "Noise sources" }),
  ).toContainText("M1 flicker");
  // Without KF the same circuit has no flicker at all.
  await panel.getByText(/^Models/u).click();
  await panel.getByRole("button", { name: "Reset to defaults" }).click();
  await expect(
    noise.getByRole("table", { name: "Noise sources" }),
  ).not.toContainText("flicker");
});

test("distortion: square-law CS with λ = 0 has HD2 = A/(4 V_ov) and no HD3", async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.setItem(
      "smallsignal.models",
      JSON.stringify({ nmos: { LAMBDA: "0" } }),
    );
  });
  const panel = await analyze(page, FIXTURES.csWired);
  await expect(panel.locator(".small-signal-alert.is-ok")).toHaveText(
    "M1 is in saturation.",
  );
  const { id, gm, ro } = await biasLine(panel, "M1");
  expect(ro).toBe(Infinity);
  const overdrive = (2 * id) / gm;

  await panel.getByText("Distortion", { exact: true }).click();
  const section = panel.locator("details.small-signal-distortion");
  await expect(
    section
      .getByRole("group", { name: "Nonlinear devices" })
      .getByRole("button"),
  ).toHaveText(["M1"]);
  const percent = async (row: string) => {
    const text = await section
      .locator(`tr[data-quantity="${row}"] td`)
      .first()
      .innerText();
    return Number(text.replace("%", "")) / 100;
  };
  const hd2 = section.locator('tr[data-quantity="hd2"]');
  await expect(hd2).toBeVisible({ timeout: 15_000 });
  // 10 mV by default; 4 significant digits shown, V_ov from 4-digit I and gm.
  expect(
    Math.abs((await percent("hd2")) / (0.01 / (4 * overdrive)) - 1),
  ).toBeLessThan(3e-3);
  expect(await percent("hd3")).toBeLessThan(1e-9);
  // a₃ = 0, so the third-order intercept is infinite, not missing.
  await expect(
    section.locator('tr[data-quantity="iip3"] td').first(),
  ).toHaveText("∞");
  // The output swing the numbers assume: |a₁|·A = gm·R1·A with λ = 0.
  const swing = engineering(
    await section.locator('tr[data-quantity="output"] td').first().innerText(),
  );
  expect(Math.abs(swing / (gm * 10e3 * 0.01) - 1)).toBeLessThan(2e-3);
  // a₃ is exactly zero for a square law with a resistor load.
  const images = section.locator(".small-signal-formula");
  await expect(images.first()).toBeVisible();
  const alts = await images.evaluateAll((all) =>
    all.map((img) => img.getAttribute("data-tex") ?? ""),
  );
  expect(alts.some((alt) => /^a_\{3\} = 0$/u.test(alt))).toBe(true);
  // a₂ in the square law's terms, as hand analysis writes it.
  expect(alts).toContain("a_{2} = -\\frac{g_{m1} R_{1}}{2 V_{OD1}}");
  await section.getByText("Device coefficients", { exact: true }).click();
  const vod = section
    .getByRole("table", { name: "Device coefficients" })
    .locator("tr")
    .first();
  expect(
    Math.abs(
      engineering(await vod.locator("td").first().innerText()) / overdrive - 1,
    ),
  ).toBeLessThan(3e-3);

  // An unreadable amplitude solves nothing rather than use the default.
  await section.getByLabel("Distortion amplitude").fill("abc");
  await expect(section).toContainText("Enter an amplitude above 0.");
  await expect(section.locator('tr[data-quantity="hd2"]')).toHaveCount(0);

  // HD2 grows linearly with the amplitude.
  await section.getByLabel("Distortion amplitude").fill("20m");
  await expect
    .poll(async () => (await percent("hd2")) / (0.02 / (4 * overdrive)))
    .toBeCloseTo(1, 2);

  // With no device expanded there is nothing to compute.
  await section.getByRole("button", { name: "M1" }).click();
  await expect(section).toContainText("Pick a device to expand.");
});

test("a wide exact formula scrolls inside the panel instead of being cut off", async ({
  page,
}) => {
  const panel = await analyze(page, FIXTURES.csWired);
  await panel.getByText("Distortion", { exact: true }).click();
  const section = panel.locator("details.small-signal-distortion");
  await expect(section.locator('tr[data-quantity="hd2"]')).toBeVisible({
    timeout: 15_000,
  });
  // Every section and exact form in the panel, nested ones included.
  await panel.evaluate((element) => {
    for (const details of element.querySelectorAll("details"))
      details.open = true;
  });
  const scrollers = panel.locator(".small-signal-formula-scroll");
  await expect(scrollers.first()).toBeVisible();
  await expect(panel.locator(".small-signal-formula-pending")).toHaveCount(0, {
    timeout: 15_000,
  });
  const boxes = await scrollers.evaluateAll((all) =>
    all.map((box) => {
      const before = box.scrollLeft;
      box.scrollLeft = box.scrollWidth;
      const moved = box.scrollLeft > before;
      box.scrollLeft = before;
      return {
        right: box.getBoundingClientRect().right,
        overflows: box.scrollWidth > box.clientWidth,
        moved,
      };
    }),
  );
  const panelRight = await panel.evaluate(
    (element) => element.getBoundingClientRect().right,
  );
  // Every box ends inside the panel; the ones wider than it scroll.
  for (const box of boxes) {
    expect(box.right).toBeLessThanOrEqual(panelRight + 0.5);
    expect(box.moved).toBe(box.overflows);
  }
  expect(boxes.some((box) => box.overflows)).toBe(true);
});

test("a 25-BJT op-amp: the bias point and the numbers, without formulas", async ({
  page,
}) => {
  const panel = await analyze(page, FIXTURES.bjtOpAmp);
  const started = Date.now();
  // At the default 1 kHz, past the 10.61 Hz dominant pole: |A| = 730
  // (68,823 at DC, as ngspice-47), Zout 104 Ω.
  await expect
    .poll(() => cardValue(panel, "Gain"), { timeout: 30_000 })
    .toBeCloseTo(730, -1);
  const seconds = (Date.now() - started) / 1000;
  expect(seconds).toBeLessThan(20);
  expect(await cardValue(panel, "Output impedance")).toBeCloseTo(104, -1);
  await expect(card(panel, "Gain")).toContainText(/Pole [−-]10\.61 Hz/u);
  // Said once, on the first card; no formula anywhere.
  await expect(
    panel.getByText("Formula too large to derive. Try a smaller block."),
  ).toHaveCount(1);
  await expect(
    card(panel, "Gain").getByText("Formula too large to derive.", {
      exact: false,
    }),
  ).toHaveCount(1);
  await expect(panel.locator(".small-signal-formula")).toHaveCount(0);
  await expect(
    card(panel, "Bias point").locator("tr[data-device]"),
  ).toHaveCount(25);

  // Noise: the densities, and the closed form named as too large, briefly.
  const noise = panel.locator("details.small-signal-noise");
  await noise.locator("summary", { hasText: "Noise" }).click();
  await expect(noise).toContainText("nV/√Hz", { timeout: 30_000 });
  await expect(noise).toContainText("Too large for the exact closed form.");
  await expect(noise).not.toContainText("simplify the circuit");

  // With Noise open, a new request waits for the main solve's budget
  // status: one noise solve, numeric only, never an exact one beside it.
  await page.evaluate(() => {
    const sent: string[] = [];
    (window as unknown as { solves: string[] }).solves = sent;
    const post = Worker.prototype.postMessage as (
      this: Worker,
      ...args: unknown[]
    ) => void;
    Worker.prototype.postMessage = function (this: Worker, ...args: unknown[]) {
      const request = (args[0] as { request?: unknown }).request;
      if (typeof request === "string") sent.push(request);
      post.apply(this, args);
    } as Worker["postMessage"];
  });
  await panel.getByText("Options", { exact: true }).click();
  await panel.getByLabel("Frequencies").fill("10k");
  // 10.61 Hz × 68,823 / 10 kHz.
  await expect
    .poll(() => cardValue(panel, "Gain"), { timeout: 30_000 })
    .toBeCloseTo(73, -1);
  await expect(noise).toContainText("nV/√Hz", { timeout: 30_000 });
  const noiseSolves = await page.evaluate(() =>
    (window as unknown as { solves: string[] }).solves
      .map((text) => JSON.parse(text) as { noise?: boolean; maxTerms?: number })
      .filter((request) => request.noise)
      .map((request) => request.maxTerms ?? null),
  );
  expect(noiseSolves).toEqual([1]);
});

/** The Assumptions section, open. */
async function assumptions(panel: Locator): Promise<Locator> {
  const section = panel.locator("details.small-signal-assumptions-section");
  const summary = section.locator(":scope > summary");
  await expect(summary).toBeVisible();
  if ((await section.getAttribute("open")) === null) await summary.click();
  return section;
}

const neglect = (section: Locator, name: string) =>
  section.getByRole("checkbox", { name, exact: true });

test("assumptions: r_o neglected on M1 gives −gm R1 and its distance from the full model, kept across a reload", async ({
  page,
}) => {
  let panel = await analyze(page, FIXTURES.csWired);
  await expect.poll(() => cardValue(panel, "Gain")).toBeCloseTo(-4.19, 2);
  const m1 = await biasLine(panel, "M1");
  let section = await assumptions(panel);
  // NMOS as a type, M1 itself, and R1 to take open or shorted.
  await expect(section.locator("tr[data-row]")).toHaveCount(3);
  await neglect(section, "M1 ro").check();
  await expect(section.locator(":scope > summary")).toHaveText(
    "Assumptions (on)",
  );
  await expect
    .poll(() => formula(panel, "Gain"))
    .toMatch(/ = -g_\{m1\} R_\{1\}$/u);
  const gain = card(panel, "Gain");
  // gm R1 against gm (ro ∥ R1): R1 / ro = 10k / 500k. Exact for the
  // assumed model, so "=", with what the assumption costs.
  await expect(gain.getByText(/from full model$/u)).toHaveText(
    "Assumed model, 2.0% from full model",
  );
  await expect(gain.locator("details.small-signal-exact > summary")).toHaveText(
    "Exact for these assumptions",
  );
  // The header stays the full model; the table has both, from one solve.
  expect(await cardValue(panel, "Gain")).toBeCloseTo(
    -m1.gm * parallel(m1.ro, 10e3),
    2,
  );
  const values = await gain
    .getByRole("table", { name: "Full model and assumed" })
    .locator("tbody tr")
    .evaluate((tr) =>
      ["full", "assumed", "delta"].map(
        (name) =>
          tr.querySelector(`td[data-quantity="${name}"]`)?.textContent ?? "",
      ),
    );
  expect(Number(values[0])).toBeCloseTo(-m1.gm * parallel(m1.ro, 10e3), 2);
  expect(Number(values[1])).toBeCloseTo(-m1.gm * 10e3, 2);
  expect(values[2]).toBe("2.0%");

  // Distortion's forms are the assumed model's too: r_o's v_DS terms go.
  await panel.getByText("Distortion", { exact: true }).click();
  const distortion = panel.locator("details.small-signal-distortion");
  await expect(distortion.locator('tr[data-quantity="hd2"]')).toBeVisible({
    timeout: 15_000,
  });
  await expect(distortion).toContainText("from full model");
  // Inside the closed Device coefficients disclosure.
  await expect(
    distortion.locator('table[aria-label="Device coefficients"]'),
  ).toContainText("neglected");

  // Kept for this circuit across a reload.
  await page.reload();
  await awaitEditorReady(page);
  panel = await openPanel(page);
  await expect
    .poll(() => formula(panel, "Gain"))
    .toMatch(/ = -g_\{m1\} R_\{1\}$/u);
  section = await assumptions(panel);
  await expect(neglect(section, "M1 ro")).toBeChecked();

  // Reset gives the full model's form back.
  await section.getByRole("button", { name: "Reset", exact: true }).click();
  await expect.poll(() => formula(panel, "Gain")).toContain("\\parallel R_{1}");
  await expect(section.locator(":scope > summary")).toHaveText("Assumptions");
  expect(
    await page.evaluate(() => localStorage.getItem("smallsignal.assumptions")),
  ).toBe("{}");
});

test("assumptions: All NMOS on the 5T OTA neglects every NMOS r_o and keeps the pair matched", async ({
  page,
}) => {
  const panel = await analyze(page, FIXTURES.ota);
  await expect(panel.locator(".small-signal-alert.is-ok")).toHaveText(
    "All transistors are in saturation.",
  );
  const section = await assumptions(panel);
  // A matched pair is one row: its members share every setting.
  await expect(section.locator('tr[data-row="M1=M2"]')).toHaveCount(1);
  await expect(section.locator('tr[data-row="M1"]')).toHaveCount(0);
  await neglect(section, "All NMOS ro").check();
  for (const row of ["M1 = M2 ro", "M5 ro", "M6 ro"])
    await expect(neglect(section, row)).toBeChecked();
  await expect(neglect(section, "All PMOS ro")).not.toBeChecked();
  await expect.poll(() => formula(panel, "Gain")).not.toContain("r_{o1,2}");
  const gain = await formula(panel, "Gain");
  expect(gain).toContain("g_{m1,2}");
  expect(gain).toContain("r_{o3,4}");
  await expect(
    panel.getByLabel("Matched pairs").getByRole("button", { name: "M1 = M2" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(panel.locator(".small-signal-alert.is-warning")).toHaveCount(0);
  await expect(card(panel, "Gain")).toContainText("% from full model");
  // The pole moves: the assumed one beside the full model's.
  await expect(
    card(panel, "Gain").getByRole("table", { name: "Full model and assumed" }),
  ).toContainText("Pole");
  // A type's default holds in every circuit.
  expect(
    await page.evaluate(() =>
      localStorage.getItem("smallsignal.assumptionDefaults"),
    ),
  ).toBe(JSON.stringify({ nmos: ["ro"] }));

  // One NMOS kept: the type row is mixed.
  await neglect(section, "M5 ro").uncheck();
  await expect
    .poll(() =>
      neglect(section, "All NMOS ro").evaluate(
        (input: HTMLInputElement) => input.indeterminate,
      ),
    )
    .toBe(true);
});

test("assumptions: triode cannot be imposed on a saturated M1, its own region changes nothing", async ({
  page,
}) => {
  const panel = await analyze(page, FIXTURES.csWired);
  await expect(panel.locator(".small-signal-alert.is-ok")).toHaveText(
    "M1 is in saturation.",
  );
  const before = await formula(panel, "Gain");
  const section = await assumptions(panel);
  const region = section.getByLabel("M1 region", { exact: true });
  await region.selectOption("triode");
  await expect(panel.locator(".small-signal-alert.is-warning")).toHaveText(
    "M1 is saturated, cannot assume triode",
  );
  // Refused: the bias's model and numbers stay.
  expect(await cardValue(panel, "Gain")).toBeCloseTo(-4.19, 2);
  expect(await formula(panel, "Gain")).toBe(before);
  await region.selectOption("saturation");
  await expect(panel.locator(".small-signal-alert.is-ok")).toHaveText(
    "M1 is in saturation.",
  );
});

const deviceMenu = (page: Page) => page.getByTestId("small-signal-device-menu");

test("device menu: a click on M1 neglects r_o there, and the card and the table agree", async ({
  page,
}) => {
  const panel = await analyze(page, FIXTURES.csWired);
  await formula(panel, "Gain");
  await page.getByTestId("hit-m1").click();
  const menu = deviceMenu(page);
  await expect(menu).toBeVisible();
  await expect(menu).toHaveAccessibleName("M1");
  // The part stays selected, its row too.
  await expect(page.getByTestId("hit-m1")).toHaveClass(/\bselected\b/u);
  const ro = menu.getByRole("button", { name: "Neglect r_o", exact: true });
  await expect(ro).toHaveAttribute("aria-pressed", "false");
  await ro.click();
  await expect(ro).toHaveAttribute("aria-pressed", "true");
  // Applied at once: the card's form, its cost, and the same choice in the
  // table.
  await expect
    .poll(() => formula(panel, "Gain"))
    .toMatch(/ = -g_\{m1\} R_\{1\}$/u);
  await expect(
    card(panel, "Gain")
      .getByText(/from full model$/u)
      .first(),
  ).toHaveText("Assumed model, 2.0% from full model");
  await expect(menu.locator("[data-cost]")).toHaveText(
    "Gain 2.0% from full model",
  );
  const section = await assumptions(panel);
  await expect(neglect(section, "M1 ro")).toBeChecked();
  // A badge marks the part on the canvas.
  const badge = page.locator('[data-small-signal-badge="M1"]');
  await expect(badge).toHaveText("≈");
  await expect(badge).toHaveAccessibleName("M1: r_o neglected");
  // Esc closes the menu and keeps the selection.
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(page.getByTestId("hit-m1")).toHaveClass(/\bselected\b/u);
  // The table's change shows in the menu, opened from the badge.
  await neglect(section, "M1 ro").uncheck();
  await expect(badge).toHaveCount(0);
  await neglect(section, "M1 leakage").check();
  await page.locator('[data-small-signal-badge="M1"]').click();
  await expect(
    menu.getByRole("button", { name: "Neglect leakage", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(ro).toHaveAttribute("aria-pressed", "false");
  // From the keyboard: the row's name opens the menu with focus in it, and
  // Esc gives focus back.
  await page.keyboard.press("Escape");
  const name = section.getByRole("button", { name: "M1", exact: true });
  await name.focus();
  await page.keyboard.press("Enter");
  await expect(menu).toBeVisible();
  // Focus lands on the first value, not on Close.
  await expect(menu.getByRole("textbox", { name: "M1 W" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(name).toBeFocused();
});

test("device menu: saturation on the triode inverter gives −(g_m1 + g_m2)(r_o1 ∥ r_o2) at its bias", async ({
  page,
}) => {
  const panel = await analyze(page, FIXTURES.inverter);
  await expect.poll(() => cardValue(panel, "Gain")).toBeCloseTo(-0.4508, 3);
  await page.getByTestId("hit-M1").click();
  const menu = deviceMenu(page);
  await expect(menu.locator(".small-signal-region")).toHaveText("triode");
  // In triode M1's channel is R_on: no r_o to neglect.
  await expect(
    menu.getByRole("button", { name: "Neglect r_o", exact: true }),
  ).toHaveCount(0);
  await menu.getByRole("radio", { name: "Saturation", exact: true }).click();
  await expect(
    menu.getByRole("radio", { name: "Saturation", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(menu).toContainText("M1 bias says triode");
  await expect(panel.locator(".small-signal-alert.is-warning")).toHaveText(
    "M1 bias says triode",
  );
  const gain = card(panel, "Gain");
  await expect(gain.locator("[data-region-note]")).toHaveText(
    "M1 assumed saturated",
  );
  // The textbook form, with its parallel resistance.
  await expect
    .poll(() => formula(panel, "Gain"))
    .toContain(
      "-\\left(g_{m1} + g_{m2}\\right) \\left(r_{o1} \\parallel r_{o2}\\right)",
    );
  expect(await formula(panel, "Gain")).not.toContain("R_{on1}");
  // The header stays the full model's; the assumed value is the saturated
  // hand form with the bias table's (assumed) g_m and r_o.
  expect(await cardValue(panel, "Gain")).toBeCloseTo(-0.4508, 3);
  const bias = card(panel, "Bias point");
  await expect(
    bias.locator('tr[data-device="M1"] [data-quantity="region"]'),
  ).toHaveText(/^saturation\s*assumed, bias triode$/u);
  const m1 = await biasLine(panel, "M1");
  const m2 = await biasLine(panel, "M2");
  expect(m1.region).toBe("saturation");
  const assumed = Number(
    (
      await gain
        .getByRole("table", { name: "Full model and assumed" })
        .locator('tbody tr td[data-quantity="assumed"]')
        .first()
        .innerText()
    ).replace(/−/gu, "-"),
  );
  expect(assumed / (-(m1.gm + m2.gm) * parallel(m1.ro, m2.ro))).toBeCloseTo(
    1,
    2,
  );
  // r_o is now M1's to neglect, and the badge says what was imposed.
  await expect(
    menu.getByRole("button", { name: "Neglect r_o", exact: true }),
  ).toBeVisible();
  const badge = page.locator('[data-small-signal-badge="M1"]');
  await expect(badge).toHaveText("sat");
  await expect(badge).toHaveClass(/\bis-warn\b/u);
  // Auto gives the bias's model back.
  await menu.getByRole("radio", { name: "Auto", exact: true }).click();
  await expect.poll(() => formula(panel, "Gain")).toContain("R_{on1}");
  await expect(badge).toHaveCount(0);
});

test("device menu: dragging a part moves it with no menu, a press elsewhere closes one", async ({
  page,
}) => {
  const panel = await analyze(page, FIXTURES.csWired);
  await formula(panel, "Gain");
  const m1 = page.getByTestId("hit-m1");
  const start = await m1.boundingBox();
  if (!start) throw new Error("M1 is not on the canvas");
  // A drag moves the part and opens nothing.
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    start.x + start.width / 2 + 60,
    start.y + start.height / 2,
    { steps: 6 },
  );
  await page.mouse.up();
  await expect
    .poll(async () => (await m1.boundingBox())?.x ?? start.x)
    .toBeGreaterThan(start.x + 20);
  await expect(deviceMenu(page)).toHaveCount(0);
  await expect(m1).toHaveClass(/\bselected\b/u);
  // Undo puts it back, as for any move.
  await page.keyboard.press("ControlOrMeta+z");
  await expect
    .poll(async () => (await m1.boundingBox())?.x ?? 0)
    .toBeCloseTo(start.x, 0);
  // A plain click opens the menu; a resistor opens its own, with its
  // value; a press on the empty canvas closes it and clears the selection
  // as before.
  await m1.click();
  await expect(deviceMenu(page)).toHaveAccessibleName("M1");
  await page.getByTestId("hit-r1").click();
  await expect(deviceMenu(page)).toHaveAccessibleName("R1");
  await expect(page.getByTestId("hit-r1")).toHaveClass(/\bselected\b/u);
  await m1.click();
  await expect(deviceMenu(page)).toBeVisible();
  const canvas = page.getByTestId("schematic-canvas");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("no canvas");
  await page.mouse.click(box.x + 20, box.y + box.height - 20);
  await expect(deviceMenu(page)).toHaveCount(0);
  await expect(m1).not.toHaveClass(/\bselected\b/u);
});

test("device menu: a narrow screen gets it as a sheet along the bottom", async ({
  page,
}) => {
  await page.setViewportSize({ width: 420, height: 860 });
  const panel = await analyze(page, FIXTURES.inverter);
  await formula(panel, "Gain");
  await page.getByTestId("hit-M1").click();
  const menu = deviceMenu(page);
  await expect(menu).toHaveClass(/\bis-sheet\b/u);
  const box = await menu.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(420);
  expect(box!.y + box!.height).toBeLessThanOrEqual(860);
});

test("assumptions: a part selected on the canvas is its row, and the row selects it", async ({
  page,
}) => {
  const panel = await analyze(page, FIXTURES.csWired);
  await formula(panel, "Gain");
  const section = await assumptions(panel);
  const m1 = section.locator('tr[data-row="M1"]');
  const r1 = section.locator('tr[data-row="R1"]');
  await expect(m1).not.toHaveClass(/\bis-selected\b/u);
  await page.getByTestId("hit-m1").click();
  await expect(m1).toHaveClass(/\bis-selected\b/u);
  await section.getByRole("button", { name: "R1", exact: true }).click();
  await expect(page.getByTestId("hit-r1")).toHaveClass(/\bselected\b/u);
  await expect(r1).toHaveClass(/\bis-selected\b/u);
  await expect(m1).not.toHaveClass(/\bis-selected\b/u);
});

test("assumptions: a term the gain cannot do without is kept, and said once", async ({
  page,
}) => {
  // An ideal current-source load: without r_o nothing sets the gain.
  const panel = await analyze(page, FIXTURES.csCurrentLoad);
  await panel.getByLabel("Input", { exact: true }).selectOption("V1");
  await expect(panel.locator(".small-signal-alert.is-ok")).toHaveText(
    "M1 is in saturation.",
  );
  const section = await assumptions(panel);
  await neglect(section, "M1 ro").check();
  const kept = "ro of M1 kept, gain is unbounded without it";
  await expect(panel.locator(".small-signal-alert.is-warning")).toContainText(
    kept,
  );
  await expect(panel.getByText(kept, { exact: true })).toHaveCount(1);
  expect(await formula(panel, "Gain")).toMatch(/-g_\{m1\} r_\{o1\}$/u);
});

test("named assumptions: the triode inverter's ≈ forms assume r_o2 → ∞, its channel is R_on", async ({
  page,
}) => {
  const panel = await analyze(page, FIXTURES.inverter);
  await expect(panel.getByLabel("Output", { exact: true })).toHaveValue("out");
  // −(g_m1 + g_m2)(R_on1 ∥ r_o2), M1's channel 885 Ω.
  await expect.poll(() => cardValue(panel, "Gain")).toBeCloseTo(-0.4508, 3);
  expect(await formula(panel, "Gain")).toContain(
    "= -\\left(g_{m2} + g_{m1}\\right) \\left(R_{on1} \\parallel r_{o2}\\right)",
  );
  for (const [name, form] of [
    ["Gain", "-R_{on1} \\left(g_{m2} + g_{m1}\\right)"],
    ["Output impedance", "R_{on1}"],
  ] as const) {
    const quantity = card(panel, name);
    const simpler = quantity.locator(".small-signal-simpler");
    await expect(simpler.locator(".small-signal-formula")).toHaveAttribute(
      "data-tex",
      `\\approx ${form}`,
    );
    const note = simpler.locator('[data-approx="named"]');
    await expect(note).toHaveText("ro2 → ∞, within 0.18%");
    await expect(note.locator("sub")).toHaveText("o2");
  }
  // The bias table's r_o column holds M1's channel R_on.
  const bias = card(panel, "Bias point");
  await expect(bias.locator("thead th").last()).toHaveText("ro, Ron");
  await expect(
    bias.locator('tr[data-device="M1"] [data-quantity="ron"]'),
  ).toHaveText(/^885(\.\d)? Ω$/u);
  await expect(
    bias.locator('tr[data-device="M2"] [data-quantity="ro"]'),
  ).toHaveText("500 kΩ");
  // R_on is no r_o: M1 has nothing in the r_o column to neglect.
  const section = await assumptions(panel);
  await expect(section.getByLabel("M1 ro", { exact: true })).toHaveCount(0);
  await expect(section.getByLabel("M2 ro", { exact: true })).toBeVisible();

  // Smallest terms instead: the same form here, said as before, and kept
  // for the next session.
  const options = panel.locator("details.small-signal-options", {
    has: page.locator(":scope > summary", { hasText: /^Options$/u }),
  });
  await options.locator(":scope > summary").click();
  const approx = panel.getByLabel("Approximation", { exact: true });
  await expect(approx).toHaveValue("named");
  await approx.selectOption("terms");
  const gain = card(panel, "Gain");
  await expect(gain.locator('[data-approx="named"]')).toHaveCount(0);
  await expect(gain.locator(".small-signal-simpler small")).toHaveText(
    "within 0.18% of exact",
  );
  expect(
    await page.evaluate(() => localStorage.getItem("smallsignal.approx")),
  ).toBe("terms");
  await page.reload();
  await awaitEditorReady(page);
  await openProjectFile(page, fixture(FIXTURES.inverter));
  const again = await openPanel(page);
  await again
    .locator("details.small-signal-options", {
      has: page.locator(":scope > summary", { hasText: /^Options$/u }),
    })
    .locator(":scope > summary")
    .click();
  await expect(again.getByLabel("Approximation", { exact: true })).toHaveValue(
    "terms",
  );
});

/** The Suggestions section, open. */
async function suggestions(panel: Locator): Promise<Locator> {
  const section = panel.locator("details.small-signal-suggestions");
  const summary = section.locator("summary");
  await expect(summary).toBeVisible();
  if ((await section.getAttribute("open")) === null) await summary.click();
  return section;
}

test("suggestions: the 5T OTA's r_o terms with their cost, applied in one click", async ({
  page,
}) => {
  const panel = await analyze(page, FIXTURES.ota);
  await expect(panel.locator(".small-signal-alert.is-ok")).toHaveText(
    "All transistors are in saturation.",
  );
  const section = await suggestions(panel);
  const rows = section.locator("tbody tr");
  await expect(rows.first()).toBeVisible({ timeout: 15_000 });
  // r_o rows, each with its own cost and the running total.
  const ro = rows.filter({ has: page.locator("th", { hasText: /^ro / }) });
  await expect(ro.first()).toBeVisible();
  await expect(ro.first().locator("td").nth(0)).toHaveText(/^[<\d.]+%$/u);
  const apply = ro.first().getByRole("button", { name: /^Apply ro / });
  const target = ((await apply.getAttribute("aria-label")) ?? "").replace(
    /^Apply ro /u,
    "",
  );
  await apply.click();

  // Written where the Assumptions table keeps it.
  const table = await assumptions(panel);
  await expect(table.locator("summary")).toHaveText("Assumptions (on)");
  const row = target.startsWith("all ")
    ? `All ${target.slice(4)} ro`
    : `${target} ro`;
  await expect(neglect(table, row)).toBeChecked();
  await expect(card(panel, "Gain")).toContainText("% from full model");
  // Re-suggested from the new assumptions: that row is gone.
  await expect(
    section.getByRole("button", { name: `Apply ro ${target}`, exact: true }),
  ).toHaveCount(0, { timeout: 15_000 });
  await expect(rows.first()).toBeVisible({ timeout: 15_000 });

  // Apply all: every kept row at once, within the threshold together.
  const before = await table.locator("input:checked").count();
  await section.getByRole("button", { name: "Apply all", exact: true }).click();
  await expect
    .poll(() => table.locator("input:checked").count())
    .toBeGreaterThan(before);
  await expect(card(panel, "Gain")).toContainText("% from full model");

  // Hand analysis has no bias point to measure against.
  await panel.getByText("Options", { exact: true }).click();
  await panel.getByText("Hand analysis (assume saturation)").click();
  await expect(section).toContainText("Suggestions need a bias point.");
});

test("suggestions: the 25-BJT op-amp, numeric over the term budget", async ({
  page,
}) => {
  const panel = await analyze(page, FIXTURES.bjtOpAmp);
  await expect
    .poll(() => cardValue(panel, "Gain"), { timeout: 30_000 })
    .toBeCloseTo(730, -1);
  const started = Date.now();
  const section = await suggestions(panel);
  await expect(section.locator("tbody tr").first()).toBeVisible({
    timeout: 60_000,
  });
  expect((Date.now() - started) / 1000).toBeLessThan(30);
  await expect(
    section.getByRole("button", { name: "Apply all", exact: true }),
  ).toBeVisible();
  await expect(section).not.toContainText("Checked");
});

test("assumptions: Miller on CC in a two-stage OTA, labeled with K, its cost measured, the RHP zero removed", async ({
  page,
}) => {
  let panel = await analyze(page, FIXTURES.twoStage);
  await expect(panel.locator(".small-signal-alert.is-ok")).toHaveText(
    "All transistors are in saturation.",
  );
  await expect(panel.getByLabel("Output", { exact: true })).toHaveValue("vout");
  let section = await assumptions(panel);
  // CC bridges the two stages' outputs; CL ends at ground: no Miller there.
  const cc = section.getByLabel("CC open or short", { exact: true });
  await expect(cc.locator('option[value="miller"]')).toHaveText("Miller");
  await expect(
    section
      .getByLabel("CL open or short", { exact: true })
      .locator('option[value="miller"]'),
  ).toHaveCount(0);
  await cc.selectOption("miller");
  await expect(section.locator(":scope > summary")).toHaveText(
    "Assumptions (on)",
  );
  const gain = card(panel, "Gain");
  // K = v(vout)/v(vo1) at DC = −g_m7 (r_o7 ∥ r_o8), a few hundred here.
  await expect(gain.locator(".small-signal-miller")).toHaveText(
    /^Miller CC, K = −\d{3}$/u,
  );
  await expect.poll(() => formula(panel, "Gain")).toContain("K_{CC}");
  // The hand limit on the split model; the split's own cost is the note's.
  await expect(gain.locator('[data-approx="named"]')).toHaveText(
    /^ro ≫ R, 1\/gm, [\d.,]+(%|×) from full model$/u,
  );
  // The split keeps the dominant pole and loses pole splitting: its cost.
  await expect(gain).toContainText(/(%|×) from full model/u);
  const table = gain.getByRole("table", { name: "Full model and assumed" });
  const zero = table.locator('tr[data-root="zero"]');
  await expect(zero).toHaveCount(1);
  await expect(zero.locator('td[data-quantity="full"]')).toHaveText(/^\d/u);
  await expect(zero.locator('td[data-quantity="assumed"]')).toHaveText(
    "removed",
  );
  const dominant = table.locator('tr[data-root="pole"]').first();
  await expect(dominant.locator('td[data-quantity="delta"]')).toHaveText(
    /^(<0\.1|\d(\.\d+)?)%$/u,
  );
  await gain.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("miller-panel.png") });
  await gain.screenshot({ path: test.info().outputPath("miller-card.png") });

  // Kept for this circuit across a reload, under the capacitor's own key.
  expect(
    await page.evaluate(() => localStorage.getItem("smallsignal.assumptions")),
  ).toContain('"miller":[null]');
  await page.reload();
  await awaitEditorReady(page);
  panel = await openPanel(page);
  section = await assumptions(panel);
  await expect(
    section.getByLabel("CC open or short", { exact: true }),
  ).toHaveValue("miller");
  await expect(card(panel, "Gain").locator(".small-signal-miller")).toHaveText(
    /^Miller CC, K = −\d{3}$/u,
  );

  // Open instead: the split ends, the label goes.
  await section
    .getByLabel("CC open or short", { exact: true })
    .selectOption("open");
  await expect(card(panel, "Gain").locator(".small-signal-miller")).toHaveCount(
    0,
  );
});

test("assumptions: Miller on a device's C_gd excludes neglecting it", async ({
  page,
}) => {
  const panel = await analyze(page, FIXTURES.csWired);
  await expect.poll(() => cardValue(panel, "Gain")).toBeCloseTo(-4.19, 2);
  await panel.getByText(/^Models/u).click();
  const nmos = panel.locator("fieldset.small-signal-model", {
    has: page.locator("legend", { hasText: "NMOS" }),
  });
  await nmos.locator("details.small-signal-model-caps > summary").click();
  await panel.getByLabel("NMOS TOX").fill("20n");
  await panel.getByLabel("NMOS CGDO").fill("3e-10");
  await expect.poll(() => formula(panel, "Gain")).toContain("C_{gd1}");
  const section = await assumptions(panel);
  const cell = section.locator("details.small-signal-caps").filter({
    has: page.getByLabel("M1 caps", { exact: true }),
  });
  await cell.locator("summary").click();
  // C_gs ends at ground (the source): only C_gd can be split.
  await expect(neglect(section, "M1 cgs Miller")).toHaveCount(0);
  const miller = neglect(section, "M1 cgd Miller");
  await miller.check();
  await expect(cell.locator("summary")).toHaveText("Miller Cgd");
  await expect(neglect(section, "M1 cgd")).not.toBeChecked();
  const gain = card(panel, "Gain");
  // K = −g_m (r_o ∥ R_1): the DC gain itself.
  await expect(gain.locator(".small-signal-miller")).toHaveText(
    /^Miller Cgd1, K = −4\.19$/u,
  );
  await expect.poll(() => formula(panel, "Gain")).toContain("K_{gd1}");
  // Neglecting C_gd ends its split.
  await neglect(section, "M1 cgd").check();
  await expect(miller).not.toBeChecked();
  await expect(cell.locator("summary")).toHaveText("Cgd");
  await expect(gain.locator(".small-signal-miller")).toHaveCount(0);
});

const bode = (panel: Locator, name: string) =>
  card(panel, name).getByTestId("small-signal-bode");

test("bode: the two-stage OTA's gain plot marks its poles and zero, and the crosshair reads the card's value at 1 kHz", async ({
  page,
}) => {
  const panel = await analyze(page, FIXTURES.twoStage);
  await formula(panel, "Gain");
  const plot = bode(panel, "Gain");
  await expect(plot).toBeVisible();
  // The full model's two poles and its right half-plane zero.
  await expect(plot.locator('[data-root="pole"]')).toHaveCount(2);
  const zero = plot.locator('[data-root="zero"]');
  await expect(zero).toHaveCount(1);
  await expect(zero).toHaveClass(/\bis-rhp\b/u);
  await expect(plot.locator(".small-signal-bode-legend")).toHaveText(
    /Full model\s*≈ form/u,
  );
  // At the 1k tick the readout is the card's own number, in dB.
  await plot.scrollIntoViewIfNeeded();
  const tick = plot.locator("text", { hasText: /^1k$/u });
  const at = await tick.boundingBox();
  // The 1.1 kHz pole is pixels away: Alt reads there without landing on it.
  await page.keyboard.down("Alt");
  await page.mouse.move(at!.x + at!.width / 2, at!.y - 60);
  const readout = plot.getByTestId("small-signal-bode-readout");
  await expect(readout.locator("strong")).toHaveText("1 kHz");
  const db = Number(
    (
      await readout
        .locator('tr[data-curve="full"] [data-quantity="magnitude"]')
        .innerText()
    )
      .replace("−", "-")
      .replace(" dB", ""),
  );
  const gain = await cardValue(panel, "Gain");
  expect(Math.abs(db - 20 * Math.log10(Math.abs(gain)))).toBeLessThan(0.06);
  // Released, it lands on the pole again at once.
  await page.keyboard.up("Alt");
  await expect(readout.locator("strong")).toHaveAttribute(
    "data-snapped",
    "pole",
  );
  await page.mouse.move(5, 5);
  await expect(readout).toHaveCount(0);
  // Zin looks into a gate: nothing to plot.
  await expect(bode(panel, "Input impedance")).toHaveCount(0);
  await expect(bode(panel, "Output impedance")).toBeVisible();
});

test("bode: near a pole, the unity-gain or the −3 dB point the crosshair lands on it and names it", async ({
  page,
}) => {
  const panel = await analyze(page, FIXTURES.twoStage);
  await formula(panel, "Gain");
  const plot = bode(panel, "Gain");
  await plot.scrollIntoViewIfNeeded();
  const readout = plot.getByTestId("small-signal-bode-readout");
  const full = (quantity: string) =>
    readout
      .locator(`tr[data-curve="full"] [data-quantity="${quantity}"]`)
      .innerText()
      .then((text) => Number(text.replace("−", "-").replace(/ dB|°/u, "")));
  // On the mark's x, at the magnitude panel's middle: in the panel's
  // narrow plot the −3 dB point sits a pixel from the dominant pole, unity
  // gain as near the second pole, so each is read where it is drawn (the
  // nearest target wins).
  const near = async (target: Locator, dx = 0) => {
    const box = (await target.boundingBox())!;
    const frame = (await plot
      .locator(".small-signal-bode-frame")
      .first()
      .boundingBox())!;
    await page.mouse.move(
      box.x + box.width / 2 + dx,
      frame.y + frame.height / 2,
    );
  };
  // DC: the plot's left edge.
  const frame = (await plot
    .locator(".small-signal-bode-frame")
    .first()
    .boundingBox())!;
  await page.mouse.move(frame.x + 1, frame.y + frame.height / 2);
  const dc = await full("magnitude");
  const dcPhase = await full("phase");

  const pole = plot.locator('[data-root="pole"]').first();
  await near(pole);
  await expect(readout.locator("strong")).toHaveAttribute(
    "data-snapped",
    "pole",
  );
  await expect(readout.locator("strong")).toHaveText(/^Pole /u);
  // A few px off, the crosshair still lands on a marked point there.
  await near(pole, 5);
  await expect(readout.locator("strong")).toHaveAttribute(
    "data-snapped",
    /^(pole|bandwidth)$/u,
  );

  await near(plot.locator('[data-crossing="bandwidth"]'));
  await expect(readout.locator("strong")).toHaveText(/^−3 dB /u);
  expect(Math.abs((await full("magnitude")) - (dc - 3.01))).toBeLessThan(0.06);

  await near(plot.locator('[data-crossing="unity"]'));
  await expect(readout.locator("strong")).toHaveText(/^Unity gain /u);
  expect(Math.abs(await full("magnitude"))).toBeLessThan(0.06);
  // Phase margin: 180° less the phase lost since DC.
  const margin = Number(
    (await readout.locator('[data-quantity="phase-margin"]').innerText())
      .replace("Phase margin ", "")
      .replace("−", "-")
      .replace("°", ""),
  );
  const lost = 180 * Math.round(dcPhase / 180) - (await full("phase"));
  expect(Math.abs(margin - (180 - lost))).toBeLessThan(0.11);

  // Alt reads freely, applied without moving: pressed over a landed
  // point it lets go, released it lands again.
  await near(pole);
  const strong = readout.locator("strong");
  await expect(strong).toHaveAttribute("data-snapped", "pole");
  await page.keyboard.down("Alt");
  await expect(strong).not.toHaveAttribute("data-snapped", /./u);
  await page.keyboard.up("Alt");
  await expect(strong).toHaveAttribute("data-snapped", "pole");
});

test("bode: a circuit without capacitors has no plot", async ({ page }) => {
  const panel = await analyze(page, FIXTURES.inverter);
  await formula(panel, "Gain");
  await expect(panel.getByTestId("small-signal-bode")).toHaveCount(0);
});

test("link: pointing at g_m1 rings M1 on the drawing, pointing at M1 marks its symbols, and a copy writes TeX", async ({
  page,
}) => {
  const panel = await analyze(page, FIXTURES.inverter);
  const tex = await formula(panel, "Gain");
  const symbol = card(panel, "Gain")
    .locator('.small-signal-formula [data-sym="g_{m1}"]')
    .first();
  // Between strokes too: the pointer at the symbol's centre, not its ink.
  // The card may still swap its formula in (the ≈ form arrives later):
  // measure again until the pointer rests on the shown one.
  const ring = page.locator('[data-small-signal-ring="M1"]');
  await expect(async () => {
    const box = await symbol.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await expect(ring).toBeVisible({ timeout: 1000 });
  }).toPass();
  const r = await ring.boundingBox();
  const hit = await page.getByTestId("hit-M1").boundingBox();
  expect(r!.x).toBeLessThanOrEqual(hit!.x);
  expect(r!.x + r!.width).toBeGreaterThanOrEqual(hit!.x + hit!.width);
  // The symbol itself is marked, the other device's are not.
  const highlight = page.locator("style[data-small-signal-highlight]");
  const marked = () => highlight.evaluate((style) => style.textContent ?? "");
  await expect.poll(marked).toMatch(/\[data-sym="g_\{m1\}"\]/u);
  expect(await marked()).not.toMatch(/g_\{m2\}/u);
  // From the drawing: M1 marks every symbol of M1.
  await page.getByTestId("hit-M1").hover();
  await expect(ring).toHaveCount(0);
  await expect.poll(marked).toMatch(/\[data-sym="R_\{on1\}"\]/u);
  expect(await marked()).toMatch(/\[data-sym="g_\{m1\}"\]/u);
  await page.mouse.move(5, 5);
  await expect(highlight).toHaveCount(0);
  // Copying a selection over the formula writes its TeX.
  const copied = await card(panel, "Gain").evaluate((section) => {
    let text = "";
    const listen = (event: ClipboardEvent) => {
      text = event.clipboardData?.getData("text/plain") ?? "";
    };
    window.addEventListener("copy", listen);
    const range = document.createRange();
    range.selectNodeContents(section);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand("copy");
    window.removeEventListener("copy", listen);
    selection.removeAllRanges();
    return text;
  });
  expect(copied).toContain(`$${tex}$`);
});

test("operating point: Show on drawing labels the node voltages and each transistor's region, kept across a reload", async ({
  page,
}) => {
  let panel = await analyze(page, FIXTURES.inverter);
  await formula(panel, "Gain");
  const toggle = card(panel, "Bias point").getByLabel("Show on drawing");
  await expect(toggle).not.toBeChecked();
  await expect(page.locator("[data-op-device]")).toHaveCount(0);
  await toggle.check();
  await expect(page.locator('[data-op-device="M1"]')).toHaveText("triode");
  await expect(page.locator('[data-op-device="M2"]')).toHaveText("sat");
  // Every label is a voltage of the bias the panel solved.
  const nets = page.locator("[data-op-node]");
  await expect(nets.first()).toBeVisible();
  for (const text of await nets.allInnerTexts())
    expect(text).toMatch(/^-?[\d.]+ [mµ]?V$/u);
  await expect(page.locator('[data-op-node="out"]')).toHaveText(/^[\d.]+ mV$/u);
  await page.reload();
  await awaitEditorReady(page);
  panel = await openPanel(page);
  await expect(
    card(panel, "Bias point").getByLabel("Show on drawing"),
  ).toBeChecked();
  await expect(page.locator('[data-op-device="M1"]')).toHaveText("triode");
  // Only while the panel is open.
  await page.getByTestId("small-signal-toggle").click();
  await expect(page.locator("[data-op-device]")).toHaveCount(0);
});

test("costs: twice the full model's value and more read as a multiple, never thousands of percent", async ({
  page,
}) => {
  const panel = await analyze(page, FIXTURES.twoStage);
  await formula(panel, "Gain");
  const section = await assumptions(panel);
  await neglect(section, "All NMOS ro").check();
  await section
    .getByLabel("CC open or short", { exact: true })
    .selectOption("miller");
  const note = card(panel, "Gain").locator('[data-approx="named"]');
  await expect(note).toHaveText(/^ro ≫ R, 1\/gm, \d+\.\d× from full model$/u);
  await expect(panel).not.toContainText(/\d{3,}% from full model/u);
  // Zout has no simpler form: its own form is exact for the assumed model.
  const zout = card(panel, "Output impedance");
  await expect(zout.locator('[data-approx="none"]')).toHaveText(
    "No simple form within 5.0%.",
  );
  await expect(zout.locator("[data-full-model-note]")).toHaveText(
    /^Assumed model, (junction leakage neglected, )?[\d.,]+(%|×) from full model$/u,
  );
});

test("bias table: at phone width it fits its card", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const panel = await analyze(page, FIXTURES.bjtOpAmp);
  const table = card(panel, "Bias point").locator("table");
  await expect(table.locator("tbody tr")).toHaveCount(25, { timeout: 30_000 });
  const fits = await table.evaluate(
    (element) => element.scrollWidth <= element.parentElement!.clientWidth,
  );
  expect(fits).toBe(true);
  // A device off its amplifying region still says so, under its name, and
  // to a screen reader too.
  await expect(
    table.locator('tr[data-device="Q15"] th .small-signal-region'),
  ).toBeVisible();
  await expect(
    table.getByRole("rowheader", { name: "Q15 cutoff", exact: true }),
  ).toBeVisible();
});

test("device menu: Esc closes it and leaves the editor's own cancel alone", async ({
  page,
}) => {
  const panel = await analyze(page, FIXTURES.inverter);
  await formula(panel, "Gain");
  await page.getByTestId("hit-M1").click();
  await expect(deviceMenu(page)).toBeVisible();
  const status = page.locator(".statusbar-left");
  const before = await status.innerText();
  await page.keyboard.press("Escape");
  await expect(deviceMenu(page)).toHaveCount(0);
  await expect(status).not.toContainText("Cancelled");
  expect(await status.innerText()).toBe(before);
});

test("guide: it is the empty panel, closes once for good, and ? brings it back", async ({
  page,
}) => {
  await openEditor(page);
  let panel = await openPanel(page);
  const guide = panel.getByTestId("small-signal-guide");
  await expect(guide).toBeVisible();
  await expect(guide.locator("li")).toHaveCount(5);
  await expect(guide).toContainText("Pick Input and Output.");
  await expect(guide.getByRole("button", { name: "5T OTA" })).toBeVisible();
  // With a circuit it stays on top until closed, and closed it stays.
  await openProjectFile(
    page,
    fixture(FIXTURES.inverter),
    "cmos-inverter-triode.icproj.json",
  );
  panel = await openPanel(page);
  await formula(panel, "Gain");
  await expect(guide).toBeVisible();
  await expect(guide.getByRole("button", { name: "5T OTA" })).toHaveCount(0);
  await guide.getByRole("button", { name: "Close guide" }).click();
  await expect(guide).toHaveCount(0);
  await page.reload();
  await awaitEditorReady(page);
  panel = await openPanel(page);
  await formula(panel, "Gain");
  await expect(panel.getByTestId("small-signal-guide")).toHaveCount(0);
  const help = panel.getByRole("button", { name: "How to use" });
  await help.click();
  await expect(panel.getByTestId("small-signal-guide")).toBeVisible();
  await expect(help).toHaveAttribute("aria-expanded", "true");
  await help.click();
  await expect(panel.getByTestId("small-signal-guide")).toHaveCount(0);
});
