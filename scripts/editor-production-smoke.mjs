// Production smoke: serve the already-built editor through Vite's real
// preview server and inspect it in Chromium. --check is intentionally
// read-only; normal mode refreshes the committed report.
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";

const workspace = process.cwd();
const editorRoot = resolve(workspace, "apps/editor");
const editorDist = resolve(editorRoot, "dist");
const reportPath = resolve(
  workspace,
  "fixtures/editor-production-smoke/report.json",
);
const check = process.argv.includes("--check");

async function builtJavaScriptContains(needle) {
  const entries = await readdir(editorDist, { recursive: true });
  const scripts = entries.filter((entry) => entry.endsWith(".js"));
  const contents = await Promise.all(
    scripts.map((entry) => readFile(resolve(editorDist, entry), "utf8")),
  );
  return contents.some((content) => content.includes(needle));
}

// Whether a script the route preloads, and so every first visit downloads,
// contains the needle. Read from the built page, not from one loaded page,
// so code that loads later (the Netlist panel's editor) does not count.
async function routePreloadContains(html, route, needle) {
  const match = new RegExp(
    `const ${route}Resources = (\\[\\[.*?\\]\\]);`,
    "s",
  ).exec(html);
  if (!match) throw new Error(`No ${route} preload resources in index.html`);
  const scripts = JSON.parse(match[1])
    .filter(([rel]) => rel === "modulepreload")
    .map(([, href]) => href.replace(/^\/+/u, ""));
  const contents = await Promise.all(
    scripts.map((path) => readFile(resolve(editorDist, path), "utf8")),
  );
  return contents.some((content) => content.includes(needle));
}

async function loadedJavaScriptContains(page, needle) {
  const paths = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .map((entry) => new URL(entry.name).pathname)
      .filter((pathname) => pathname.endsWith(".js")),
  );
  const uniquePaths = [...new Set(paths)];
  const contents = await Promise.all(
    uniquePaths.map(async (pathname) => {
      const relativePath = pathname.replace(/^\/+/, "");
      return readFile(resolve(editorDist, relativePath), "utf8");
    }),
  );
  return contents.some((content) => content.includes(needle));
}

async function loadedJavaScriptPathContains(page, needle) {
  return page.evaluate(
    (expected) =>
      performance
        .getEntriesByType("resource")
        .some(
          (entry) =>
            new URL(entry.name).pathname.endsWith(".js") &&
            new URL(entry.name).pathname.includes(expected),
        ),
    needle,
  );
}

async function loadedStylesheetContains(page, needle) {
  const paths = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .map((entry) => new URL(entry.name).pathname)
      .filter((pathname) => pathname.endsWith(".css")),
  );
  const uniquePaths = [...new Set(paths)];
  const contents = await Promise.all(
    uniquePaths.map(async (pathname) => {
      const relativePath = pathname.replace(/^\/+/, "");
      return readFile(resolve(editorDist, relativePath), "utf8");
    }),
  );
  return contents.some((content) => content.includes(needle));
}

// Every loading screen a first /editor visit reveals, in order, on a fresh
// profile over a slow link where the route's chunks arrive over time. React
// keeps a revealed fallback for at least 300 ms, so each further stage costs
// that much (#1645).
async function editorLoadingScreensOf(browser, url) {
  const context = await browser.newContext({ serviceWorkers: "block" });
  try {
    const page = await context.newPage();
    await page.addInitScript(() => {
      const seen = (window.__icmLoadingScreens = []);
      new MutationObserver((records) => {
        for (const record of records)
          for (const node of record.addedNodes) {
            if (!(node instanceof Element)) continue;
            const screens = node.matches(".analytics-loading")
              ? [node]
              : node.querySelectorAll(".analytics-loading");
            for (const screen of screens) seen.push(screen.textContent ?? "");
          }
      }).observe(document, { childList: true, subtree: true });
    });
    const network = await context.newCDPSession(page);
    await network.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 40,
      downloadThroughput: 10_000_000 / 8,
      uploadThroughput: 5_000_000 / 8,
    });
    await page.goto(new URL("editor", url).href);
    await page.waitForSelector('[data-testid="schematic-canvas"]', {
      timeout: 30_000,
    });
    return await page.evaluate(() => window.__icmLoadingScreens);
  } finally {
    await context.close();
  }
}

async function main() {
  const expected = check
    ? JSON.parse(await readFile(reportPath, "utf8"))
    : null;
  const { preview } = await import("vite");
  let server;
  let browser;
  const consoleErrors = [];
  let mounted = false;
  let projectDataIsolation = "unchecked";
  let galleryEditorCodeLoaded = true;
  let editorCodeLoaded = false;
  let galleryEditorStylesLoaded = true;
  let editorStylesLoaded = false;
  let galleryPdfRuntimeLoaded = true;
  let editorPdfRuntimeLoaded = true;
  let editorLoadingScreens = [];
  let editorSimulationServiceLoaded = true;
  try {
    server = await preview({
      root: editorRoot,
      logLevel: "silent",
      preview: { host: "127.0.0.1", port: 4174, strictPort: true },
    });
    const url = server.resolvedUrls?.local[0] ?? "http://127.0.0.1:4174/";
    browser = await chromium.launch(
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : { channel: process.env.CI ? undefined : "chrome" },
    );
    editorLoadingScreens = await editorLoadingScreensOf(browser, url);
    const page = await browser.newPage();
    // This acceptance checks the hosted Gallery contract on a loopback server.
    // Ordinary loopback Examples have their own browser workflow.
    await page.addInitScript(() => {
      window.__icmLocalGalleryReplica = true;
    });
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => consoleErrors.push(error.message));
    // The production build serves two surfaces: the gallery feed at the
    // root and the full editor at /editor. Both must mount.
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="gallery-feed"]', {
      timeout: 10_000,
    });
    if (await loadedJavaScriptPathContains(page, "library-examples-"))
      throw new Error("Hosted Gallery loaded localhost examples");
    galleryEditorCodeLoaded = await loadedJavaScriptContains(
      page,
      "schematic-canvas",
    );
    galleryEditorStylesLoaded = await loadedStylesheetContains(
      page,
      ".schematic-canvas",
    );
    galleryPdfRuntimeLoaded = await loadedJavaScriptPathContains(
      page,
      "browser-pdf-",
    );
    if (
      await loadedJavaScriptContains(
        page,
        "Unrecognized extension value in extension set",
      )
    ) {
      throw new Error("Gallery loaded the code editor runtime eagerly");
    }
    await page.goto(new URL("editor", url).href, {
      waitUntil: "networkidle",
    });
    await page.waitForSelector('[data-testid="schematic-canvas"]', {
      timeout: 10_000,
    });
    // The service runtime loads when a simulation needs it, not with the
    // editor (#1645).
    editorSimulationServiceLoaded = await loadedJavaScriptContains(
      page,
      "This deployment does not advertise simulation capabilities",
    );
    editorCodeLoaded = await loadedJavaScriptContains(page, "schematic-canvas");
    editorStylesLoaded = await loadedStylesheetContains(
      page,
      ".schematic-canvas",
    );
    editorPdfRuntimeLoaded = await loadedJavaScriptPathContains(
      page,
      "browser-pdf-",
    );
    // Netlist is requested by the default editor workspace. Its CodeMirror
    // runtime must load here; only the Gallery keeps editor code deferred.
    await page.waitForSelector(
      '[aria-label="Netlist code"][contenteditable="true"]',
    );
    await page.getByTestId("examples-toggle").click();
    await page.getByTestId("examples-panel").waitFor();
    await page.waitForLoadState("networkidle");
    if (await loadedJavaScriptPathContains(page, "library-examples-"))
      throw new Error("Hosted Editor Gallery panel loaded localhost examples");
    await page.getByTestId("examples-toggle").click();
    // The first page installs the SW; a controlled navigation must actually
    // cache consumed JS bodies, not only the five install-time icons/shell.
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="schematic-canvas"]');
    const cachedEditorScript = await page.evaluate(async () => {
      const script = performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .find((url) => /\/assets\/App-[^/]+\.js$/.test(url));
      for (let attempt = 0; attempt < 50; attempt++) {
        // Inspect the stored request, including its Vary headers; a synthetic
        // Request here lacks the module request's Origin header.
        for (const name of await caches.keys()) {
          const cache = await caches.open(name);
          const key = (await cache.keys()).find(
            (request) => request.url === script,
          );
          if (key && (await cache.match(key))) return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return false;
    });
    if (!cachedEditorScript)
      throw new Error("Service worker did not cache the editor script");
    mounted = true;
    // Browser recovery is Project data and must never leak into the PWA
    // asset caches (Cache Storage) or the service-worker precache.
    projectDataIsolation = await page.evaluate(async () => {
      if (typeof caches === "undefined") return "caches-unavailable";
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        for (const request of await cache.keys()) {
          const response = await cache.match(request);
          if (!response) continue;
          // Build JS legitimately contains bundled examples and schema names.
          // Those are application code, not a user's recovery/project payload.
          const path = new URL(request.url).pathname;
          const type = response.headers.get("content-type") ?? "";
          if (
            path.startsWith("/assets/") &&
            /javascript|css|font|image/.test(type)
          )
            continue;
          if (path.startsWith("/api/"))
            return `api-data-in-cache:${request.url}`;
          const text = await response.text();
          if (
            text.includes('"topDocumentId"') ||
            text.includes('"schemaVersion"')
          ) {
            return `project-data-in-cache:${name}:${request.url}`;
          }
        }
      }
      return "clean";
    });
  } finally {
    await browser?.close();
    await server?.close();
  }

  const nodeCryptoExternalized = await builtJavaScriptContains(
    "node:crypto has been externalized",
  );
  // An inline script waits for every stylesheet above it.
  const builtHtml = await readFile(resolve(editorDist, "index.html"), "utf8");
  const routePreload = builtHtml.indexOf("<script>const galleryResources");
  const firstStylesheet = builtHtml.search(/<link\b[^>]*\brel="stylesheet"/u);
  const routePreloadBeforeStylesheets =
    routePreload !== -1 &&
    (firstStylesheet === -1 || routePreload < firstStylesheet);
  // The JSON grammar behind the property code views' inline controls loads
  // with those views (#1673). "JsonText" is its top node's name.
  const editorFirstLoadJsonParser = await routePreloadContains(
    builtHtml,
    "editor",
    "JsonText",
  );
  const report = {
    mounted,
    consoleErrors,
    nodeCryptoExternalized,
    projectDataIsolation,
    galleryEditorCodeLoaded,
    editorCodeLoaded,
    galleryEditorStylesLoaded,
    editorStylesLoaded,
    galleryPdfRuntimeLoaded,
    editorPdfRuntimeLoaded,
    editorLoadingScreens,
    editorSimulationServiceLoaded,
    routePreloadBeforeStylesheets,
    editorFirstLoadJsonParser,
  };

  if (check) {
    if (JSON.stringify(expected) !== JSON.stringify(report)) {
      throw new Error(
        `Production smoke report is stale:\nexpected ${JSON.stringify(expected)}\nreceived ${JSON.stringify(report)}`,
      );
    }
  } else {
    await mkdir(resolve(workspace, "fixtures/editor-production-smoke"), {
      recursive: true,
    });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (!report.mounted) throw new Error("Production editor did not mount");
  if (report.galleryEditorCodeLoaded) {
    throw new Error("Gallery loaded the editor route bundle eagerly");
  }
  if (!report.editorCodeLoaded) {
    throw new Error("Editor route did not load its editor bundle");
  }
  if (report.galleryEditorStylesLoaded) {
    throw new Error("Gallery loaded the editor stylesheet eagerly");
  }
  if (!report.editorStylesLoaded) {
    throw new Error("Editor route did not load its editor stylesheet");
  }
  if (report.galleryPdfRuntimeLoaded || report.editorPdfRuntimeLoaded) {
    throw new Error("PDF runtime loaded before a PDF export was requested");
  }
  if (report.editorLoadingScreens.length > 1) {
    throw new Error(
      `Editor revealed more than one loading screen: ${report.editorLoadingScreens.join(", ")}`,
    );
  }
  if (report.editorSimulationServiceLoaded) {
    throw new Error("Editor loaded the simulation service on startup");
  }
  if (!report.routePreloadBeforeStylesheets) {
    throw new Error("Route preload script waits for a stylesheet");
  }
  if (report.editorFirstLoadJsonParser) {
    throw new Error("Editor first load includes the JSON property-code parser");
  }
  if (report.consoleErrors.length > 0) {
    throw new Error(
      `Production smoke console errors:\n${report.consoleErrors.join("\n")}`,
    );
  }
  if (report.nodeCryptoExternalized) {
    throw new Error("node:crypto was externalized in the production build");
  }
  if (report.projectDataIsolation !== "clean") {
    throw new Error(
      `Project data found in browser caches: ${report.projectDataIsolation}`,
    );
  }
  console.log("Editor production preview smoke passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
