import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";
import { preview, type PreviewServer } from "vite";

import { awaitEditorReady, openProjectFile } from "./editor-fixtures.js";
import {
  BROWSER_PERFORMANCE_COUNTS,
  createBrowserPerformanceProject,
} from "./performance-fixture.js";
import {
  createDenseCopyPerformanceProject,
  DENSE_COPY_COUNTS,
} from "../src/features/clipboard/test-support/dense-copy-fixture.js";

/**
 * Browser-side latency harness for the editor.
 *
 * This is measurement, not a contract: it records what a large Project costs
 * while dragging, panning and copying, and only fails on a gross regression.
 * Run it against a fresh production build:
 *
 *   pnpm build
 *   ICM_PERF=1 pnpm test:e2e:local apps/editor/e2e/performance.spec.ts
 *
 * It measures the built bundle through Vite's preview server rather than the
 * Playwright dev server: the development build is unminified, resolves every
 * `@icm/*` through the `development` condition, and React double-invokes under
 * StrictMode, which together inflate a large Project by more than an order of
 * magnitude and say nothing about what ships.
 *
 * It is skipped unless ICM_PERF is set, because a timing assertion on shared
 * CI runners is a flaky gate rather than a useful one. Absolutes are
 * deliberately loose: the 2026-09-02 audit already found that these numbers do
 * not transfer between machines, so the artifact it writes is the comparable
 * value, not the threshold. ICM_PERF_PROJECT=<path to .icproj.json> measures a
 * real Project instead of the generated fixtures.
 */
const enabled = Boolean(process.env.ICM_PERF);
const previewPort = 4175;
const projectPath = process.env.ICM_PERF_PROJECT;

let server: PreviewServer | undefined;
let origin = "";

interface Recorded {
  frames: number[];
  tasks: { start: number; duration: number }[];
  events: { kind: string; start: number }[];
  paints: { kind: "ghost" | "drop"; start: number; end: number }[];
}

/** Records every animation frame and long task, plus copy-ghost paints. */
function recordFrames() {
  const state: Recorded = { frames: [], tasks: [], events: [], paints: [] };
  (window as unknown as { __perf: Recorded }).__perf = state;
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries())
      state.tasks.push({ start: entry.startTime, duration: entry.duration });
  }).observe({ entryTypes: ["longtask"] });
  const tick = (time: number) => {
    state.frames.push(time);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  // The copy case observes the browser's commit directly: assertion polling
  // and bridge round trips are recorded separately in its other timings.
  for (const kind of ["keydown", "pointerdown"])
    window.addEventListener(
      kind,
      (event) => {
        const start = performance.now();
        state.events.push({ kind, start });
        const ghost = () =>
          document.querySelector('[data-testid="copy-placement-preview"]');
        const count = () =>
          document.querySelectorAll('[data-canvas-hit-kind="instance"]').length;
        const before = count();
        const paintKind =
          kind === "keydown" && (event as KeyboardEvent).key === "c"
            ? ("ghost" as const)
            : kind === "pointerdown" && ghost()
              ? ("drop" as const)
              : undefined;
        if (!paintKind) return;
        const observer = new MutationObserver(() => {
          if (!ghost() || (paintKind === "drop" && count() !== before + 1))
            return;
          observer.disconnect();
          requestAnimationFrame(() =>
            requestAnimationFrame(() =>
              state.paints.push({
                kind: paintKind,
                start,
                end: performance.now(),
              }),
            ),
          );
        });
        observer.observe(document, { childList: true, subtree: true });
      },
      true,
    );
}

const recorded = (page: Page) =>
  page.evaluate(() => (window as unknown as { __perf: Recorded }).__perf);

/** Resolves after the next two frames, at the time the second one ran. */
const painted = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<number>((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => resolve(performance.now())),
        ),
      ),
  );

function frameStats(state: Recorded, from: number, to: number) {
  const frames = state.frames.filter((time) => time >= from && time <= to);
  const gaps = frames
    .slice(1)
    .map((time, index) => time - frames[index]!)
    .sort((a, b) => a - b);
  const at = (fraction: number) =>
    gaps.length === 0
      ? 0
      : gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * fraction))]!;
  const tasks = state.tasks.filter(
    (task) => task.start >= from && task.start <= to,
  );
  return {
    durationMs: to - from,
    paintedFrames: frames.length,
    frameGapMedianMs: at(0.5),
    frameGapP95Ms: at(0.95),
    frameGapMaxMs: gaps.at(-1) ?? 0,
    // Anything past a 60 Hz budget plus slack is a visibly dropped frame.
    framesOver33Ms: gaps.filter((gap) => gap > 33).length,
    longTaskCount: tasks.length,
    longTaskMaxMs: Math.max(0, ...tasks.map((task) => task.duration)),
  };
}

async function openProject(page: Page, name: string, bytes: Buffer) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.addInitScript(recordFrames);
  await page.goto(`${origin}editor`);
  await openProjectFile(
    page,
    bytes,
    projectPath ? basename(projectPath) : name,
  );
  await awaitEditorReady(page);
  const netlist = page.getByTestId("netlist-panel-toggle");
  if ((await netlist.getAttribute("aria-pressed")) === "true")
    await netlist.click();
}

function writeReport(page: Page, name: string, report: object) {
  const full = {
    recordedAt: new Date().toISOString(),
    commit: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    dirty:
      execFileSync("git", ["status", "--porcelain"], {
        encoding: "utf8",
      }).trim().length > 0,
    builtIndexSha256: createHash("sha256")
      .update(readFileSync("apps/editor/dist/index.html"))
      .digest("hex"),
    browser: page.context().browser()?.version(),
    viewport: page.viewportSize(),
    ...report,
  };
  const dir = resolve(process.cwd(), "output/performance");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    resolve(
      dir,
      `${name}-${process.env.PROFILE_LABEL ?? "trial"}-${Date.now()}.json`,
    ),
    `${JSON.stringify(full, null, 2)}\n`,
  );
  process.stdout.write(`\n${name}\n${JSON.stringify(full, null, 2)}\n`);
}

test.describe("editor latency on a large Project", () => {
  test.skip(!enabled, "set ICM_PERF=1 to run the latency harness");

  test.beforeAll(async () => {
    server = await preview({
      root: resolve(process.cwd(), "apps/editor"),
      logLevel: "silent",
      preview: { host: "127.0.0.1", port: previewPort, strictPort: true },
    });
    origin =
      server.resolvedUrls?.local[0] ?? `http://127.0.0.1:${previewPort}/`;
  });

  test.afterAll(async () => {
    await server?.close();
  });

  // The identical physical mixed-selection trajectory for before/after
  // builds, then a pan from the same camera. Timing is evidence only; commit
  // and Undo are observable correctness gates.
  test("records mixed-selection drag and pan frame cost", async ({ page }) => {
    test.setTimeout(180_000);
    const project = createBrowserPerformanceProject();
    project.documents[0]!.drafting = {
      objects: Array.from({ length: 32 }, (_, index) => ({
        id: `perf-text-${index}`,
        kind: "text" as const,
        content: { runs: [{ kind: "text" as const, value: `note-${index}` }] },
        anchor: {
          kind: "free" as const,
          position: {
            x: 93 + (index % 20) * 80,
            y: 111 + Math.floor(index / 20) * 80,
          },
        },
        alignment: "start" as const,
        rotation: 0,
        locked: false,
        zIndex: 0,
      })),
    };
    const bytes = projectPath
      ? readFileSync(projectPath)
      : Buffer.from(JSON.stringify(project));
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openProject(page, "mixed-profile.icproj.json", bytes);
    // Let the import settle before measuring anything.
    await page.waitForTimeout(2000);
    const canvas = page.getByTestId("schematic-canvas");
    const drags: ReturnType<typeof frameStats>[] = [];
    for (let sample = 0; sample < 4; sample++) {
      await canvas.focus();
      await page.keyboard.press("Control+a");
      // Routes sit above Instances in the hit order: take an instance body
      // the topmost hit element resolves back to.
      const start = await page.evaluate(() => {
        const svg = document.querySelector(
          '[data-testid="schematic-canvas"]',
        ) as SVGSVGElement;
        for (const hit of document.querySelectorAll(
          '[data-canvas-hit-kind="instance"]',
        )) {
          const r = hit.getBoundingClientRect();
          for (const fx of [0.5, 0.25, 0.75])
            for (const fy of [0.5, 0.25, 0.75]) {
              const x = r.x + r.width * fx,
                y = r.y + r.height * fy;
              if (
                document
                  .elementFromPoint(x, y)
                  ?.closest("[data-canvas-hit-id]") === hit
              )
                return {
                  x,
                  y,
                  id: hit.getAttribute("data-canvas-hit-id")!,
                  scale: svg.getScreenCTM()!.a,
                };
            }
        }
        throw new Error("No unoccluded instance body for a real mixed drag");
      });
      const hit = page.getByTestId(`hit-${start.id}`);
      const before = (await hit.boundingBox())!;
      const moved = async () =>
        Math.round(((await hit.boundingBox())!.x - before.x) / start.scale);
      await page.keyboard.down("Alt");
      await page.mouse.move(start.x, start.y);
      const from = await page.evaluate(() => performance.now());
      await page.mouse.down();
      for (let step = 1; step <= 60; step++)
        await page.mouse.move(
          start.x + step * start.scale,
          start.y + (step * start.scale) / 3,
        );
      await page.locator(".schematic-canvas.semantic-move-preview").waitFor();
      await painted(page);
      await page.mouse.up();
      await page.keyboard.up("Alt");
      const to = await page.evaluate(() => performance.now());
      await expect.poll(moved).toBe(60);
      drags.push(frameStats(await recorded(page), from, to));
      await canvas.focus();
      await page.keyboard.press("Control+z");
      await expect.poll(moved).toBe(0);
      await page.waitForTimeout(1000);
    }

    // Pan from the same camera. A wheel over the sheet pans it.
    const box = (await canvas.boundingBox())!;
    const panStart = await page.evaluate(() => performance.now());
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let step = 0; step < 40; step += 1) await page.mouse.wheel(0, 40);
    const panEnd = await painted(page);
    const pan = frameStats(await recorded(page), panStart, panEnd);
    expect(errors).toEqual([]);
    writeReport(page, "mixed-profile", {
      source: projectPath ? basename(projectPath) : "generated fixture",
      fixture: { ...BROWSER_PERFORMANCE_COUNTS, draftText: 32 },
      trajectory:
        "Ctrl+A; Alt+physical body drag, 60 CDP pointer steps over (60,20) logical units; Undo between samples; then 40 wheel ticks",
      drags,
      pan,
      note: "Production build; cold first drag sample, remaining warm. Machine-dependent rAF frame intervals, not input latency. Compare only matched builds, inputs and machines.",
    });
    // A gross-regression ceiling only: the point is the recorded artifact.
    expect(pan.frameGapMaxMs).toBeLessThan(500);
  });

  test("records copy-to-ghost and drop-to-next-ghost on a dense Project", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const bytes = projectPath
      ? readFileSync(projectPath)
      : Buffer.from(JSON.stringify(createDenseCopyPerformanceProject()));
    await openProject(page, "copy-performance.icproj.json", bytes);
    const hits = page.locator('[data-canvas-hit-kind="instance"]');
    const originalCount = await hits.count();
    if (!projectPath) expect(originalCount).toBe(DENSE_COPY_COUNTS.instances);
    await page.waitForTimeout(1000);
    const samples = Number(process.env.ICM_PERF_COPY_SAMPLES ?? "5");
    if (!Number.isInteger(samples) || samples < 2)
      throw new Error("ICM_PERF_COPY_SAMPLES must include cold + warm samples");
    const measurements: Record<
      "ghostMs" | "dropMs" | "observedGhostMs" | "observedDropMs",
      number
    >[] = [];
    for (let sample = 0; sample < samples; sample++) {
      // Selection setup is outside measurement. At Fit scale these artificial
      // shorted tiles' Wire/flightline hit areas cover the bodies; the ordinary
      // copy gesture specs own physical hit-testing. Dispatch the existing
      // selection handler, then measure real keyboard and pointer input.
      await hits.first().dispatchEvent("click");
      await expect(hits.first()).toHaveClass(/selected/);
      await page.getByTestId("schematic-canvas").focus();
      const drop = await page.evaluate(() => {
        const r = document
          .querySelector('[data-testid="schematic-canvas"]')!
          .getBoundingClientRect();
        for (const fx of [0.85, 0.65, 0.45, 0.3, 0.1])
          for (const fy of [0.85, 0.75, 0.55, 0.1]) {
            const x = r.x + r.width * fx,
              y = r.y + r.height * fy;
            const el = document.elementFromPoint(x, y);
            if (
              el?.closest('[data-testid="schematic-canvas"]') &&
              !el.closest("[data-canvas-hit-kind]")
            )
              return { x, y };
          }
        throw new Error("No unoccluded drop point");
      });
      // The ghost is pointer-local; keyboard focus alone does not establish a
      // canvas pointer position after file import.
      await page.mouse.move(drop.x, drop.y);
      await painted(page);
      const start = await painted(page);
      await page.keyboard.press("c");
      await expect(page.getByTestId("copy-placement-preview")).toBeVisible();
      const ghost = await painted(page);
      await page.mouse.move(drop.x, drop.y);
      await painted(page);
      const beforeDrop = await painted(page);
      await page.mouse.click(drop.x, drop.y);
      await expect(hits).toHaveCount(originalCount + 1);
      await expect(page.getByTestId("copy-placement-preview")).toBeVisible();
      const end = await painted(page);
      const state = await recorded(page);
      const event = (kind: string, from: number) =>
        state.events.find((item) => item.kind === kind && item.start >= from)!
          .start;
      const paint = (kind: "ghost" | "drop", from: number) => {
        const item = state.paints.find(
          (candidate) => candidate.kind === kind && candidate.start >= from,
        )!;
        return item.end - item.start;
      };
      measurements.push({
        ghostMs: ghost - event("keydown", start),
        dropMs: end - event("pointerdown", beforeDrop),
        observedGhostMs: paint("ghost", start),
        observedDropMs: paint("drop", beforeDrop),
      });
      await page.keyboard.press("Escape");
      await page.keyboard.press("ControlOrMeta+z");
      await expect(hits).toHaveCount(originalCount);
    }
    expect(errors).toEqual([]);
    const warm = measurements.slice(1);
    const quantile = (key: keyof (typeof warm)[number], fraction: number) => {
      const sorted = warm.map((item) => item[key]).sort((a, b) => a - b);
      return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
    };
    writeReport(page, "editor-copy", {
      source: projectPath ? basename(projectPath) : DENSE_COPY_COUNTS,
      originalCount,
      measurements,
      summary: Object.fromEntries(
        (
          ["ghostMs", "dropMs", "observedGhostMs", "observedDropMs"] as const
        ).flatMap((key) => [
          [`${key}Median`, quantile(key, 0.5)],
          [`${key}P95`, quantile(key, 0.95)],
        ]),
      ),
      note: "Production build. Observed timings end at browser double-rAF after the ghost/instance DOM update; other timings also include assertion polling. Drop includes the next copy ghost. Undo restores object count each sample.",
    });
  });
});
