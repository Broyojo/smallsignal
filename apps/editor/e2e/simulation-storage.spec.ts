import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { parseProject } from "@icm/project-protocol";
import { openProjectFile } from "./editor-fixtures.js";
import { createSimulationFolder } from "@icm/model";
import { unzipSync } from "fflate";
import {
  agentNativeProfile,
  agentNativeSource,
  createAgentNativeExecutor,
} from "./native-simulation-executor.mjs";

import { harnessModuleUrl } from "./helpers/harness-url";

const archiveUrl = harnessModuleUrl("browser-simulation-archive-store");
const artifactUrl = harnessModuleUrl("browser-simulation-artifact-store");
const lockUrl = harnessModuleUrl("browser-simulation-storage-lock");

test("GUI retries failed evidence storage and downloads a complete run without executing again", async ({
  page,
}) => {
  const project = parseProject(
    await readFile(
      "apps/editor/src/examples/simulation-rc.icproj.json",
      "utf8",
    ),
  );
  const folder = createSimulationFolder({
    id: "storage-retry",
    name: "Storage retry",
    profileId: agentNativeProfile,
  });
  folder.input.entry = "run.sim";
  folder.input.circuitBindings = [];
  folder.input.files = [
    {
      path: "experiment.json",
      text: JSON.stringify({
        version: 2,
        environment: { profileId: agentNativeProfile },
      }),
    },
    { path: "run.sim", text: agentNativeSource },
  ];
  project.simulationFolders = [folder];
  const executor = await createAgentNativeExecutor();
  let executions = 0;
  try {
    await page.route("**/api/simulate", async (route) => {
      const input = route.request().postDataJSON();
      if (input.operation === "capabilities")
        return route.fulfill({ json: executor.capabilities });
      executions++;
      return route.fulfill({ json: await executor.execute(input) });
    });
    await page.addInitScript(() => {
      (window as any).refuseEvidence = true;
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value, key) {
        if (
          (window as any).refuseEvidence &&
          this.name === "files" &&
          value?.ref?.name === "result.json"
        )
          throw new DOMException("Test origin quota", "QuotaExceededError");
        return put.call(this, value, key);
      };
    });
    await page.goto("/editor");
    await openProjectFile(page, project, "storage-retry.icproj.json");
    await page.getByTestId("open-analog-simulation").click();
    const panel = page.getByRole("region", { name: "Analog simulation" });
    await panel.getByRole("button", { name: "Run", exact: true }).click();
    await expect(
      panel.getByRole("button", { name: "Retry saving results" }),
    ).toBeVisible();
    await expect(panel.getByLabel("Run evidence persistence")).toContainText(
      "Collection: complete",
    );
    await expect(panel.getByLabel("Run evidence persistence")).toContainText(
      "Persistence: failed",
    );
    expect(executions).toBe(1);
    await panel.getByRole("button", { name: "Retry saving results" }).click();
    await expect(
      panel.getByRole("button", { name: "Retry saving results" }),
    ).toBeEnabled();
    expect(executions).toBe(1);
    await page.evaluate(() => {
      (window as any).refuseEvidence = false;
    });
    await panel
      .getByRole("treeitem", { name: /Storage retry/ })
      .click({ button: "right" });
    const downloading = page.waitForEvent("download");
    await page
      .getByRole("menuitem", { name: "Download complete run…", exact: true })
      .click();
    const stream = await (await downloading).createReadStream();
    if (!stream) throw new Error("Downloaded evidence stream unavailable");
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const zipped = unzipSync(Buffer.concat(chunks));
    expect(Object.keys(zipped)).toContain("evidence/result.json");
    expect(Object.keys(zipped)).toContain("evidence/evidence-manifest.json");
    expect(Object.keys(zipped).some((name) => name.endsWith(".raw"))).toBe(
      true,
    );
    expect(
      JSON.parse(new TextDecoder().decode(zipped["evidence/result.json"]!)).data
        .analyses.length,
    ).toBeGreaterThan(0);
    await expect(
      panel.getByRole("button", { name: "Retry saving results" }),
    ).toHaveCount(0);
    expect(executions).toBe(1);
  } finally {
    await executor.close();
  }
});

test("Run history can reveal browser results from other folders without changing the selected folder", async ({
  page,
}) => {
  const project = parseProject(
    await readFile(
      "apps/editor/src/examples/simulation-rc.icproj.json",
      "utf8",
    ),
  );
  const folderId = project.simulationFolders[0]!.id;
  await page.goto("/editor");
  await openProjectFile(page, project, "history-folders.icproj.json");
  await page.evaluate(
    async ({ projectId, folderId, archiveUrl }) => {
      const { createBrowserSimulationArchiveStore } = await import(archiveUrl);
      const store = createBrowserSimulationArchiveStore();
      for (const [id, owner] of [
        ["current", folderId],
        ["other", "other-folder"],
      ] as const) {
        const saved = await store.save({
          schemaVersion: 1,
          id: `history-${id}`,
          projectId,
          createdAt: new Date(0).toISOString(),
          retention: "saved",
          presentation: {
            folderId: owner,
            folderName: id === "current" ? "Current" : "Other folder",
            analysisLabel: "OP",
            outputs: [],
          },
          prepared: {
            id: `prepared-${id}`,
            digest: "a".repeat(64),
            inputRevision: "rev",
            expiresAt: 1,
            mode: "structured",
            environment: { profileId: "test" },
            vectors: [],
            outputs: [],
            deviceOperatingPoints: [],
            warnings: [],
            artifactIds: [],
          },
          run: {
            id: `run-${id}`,
            preparedId: `prepared-${id}`,
            inputRevision: "rev",
            state: "finished",
          },
          artifacts: [],
          byteLength: 0,
        });
        if (!saved.ok) throw new Error(saved.message);
      }
      store.close();
    },
    { projectId: project.id, folderId, archiveUrl },
  );
  await page.getByTestId("open-analog-simulation").click();
  await page.locator(".simulation-run-history > summary").click();
  const history = page.getByRole("region", { name: "Saved folder results" });
  await expect(history).toContainText("Other folder");
  await page.getByRole("checkbox", { name: "All Project folders" }).uncheck();
  await expect(history).toContainText("Current");
  await expect(history).not.toContainText("Other folder");
});

// Web Locks and IndexedDB shared by two real tabs. The same rules within one
// tab are browser-simulation-artifact-store and -storage-lock module tests.
test("Evidence protection holds across tabs: a Project lease until release or page close, and a viewed Run against another tab's byte budget", async ({
  page,
  context,
}) => {
  await page.goto("/editor");
  const peer = await context.newPage();
  await peer.goto("/editor");
  await page.evaluate(async (path) => {
    const { ProjectEvidenceLease } = await import(path);
    const lease = new ProjectEvidenceLease("storage-lifetime-proof");
    (window as any).evidenceLease = lease;
    await lease.acquire();
    await lease.acquire(); // one consumer must not accidentally retain twice
  }, lockUrl);
  const attempt = () =>
    peer.evaluate(async (path) => {
      const { withExclusiveEvidence } = await import(path);
      return withExclusiveEvidence(
        "storage-lifetime-proof",
        async () => "reclaimed",
      );
    }, lockUrl);
  expect(await attempt()).toEqual({ available: false });
  expect(
    await peer.evaluate(async (path) => {
      const { withExclusiveEvidence } = await import(path);
      return withExclusiveEvidence("different-project", async () => "isolated");
    }, lockUrl),
  ).toEqual({ available: true, value: "isolated" });
  await page.evaluate(() => (window as any).evidenceLease.release());
  await expect.poll(attempt).toEqual({ available: true, value: "reclaimed" });

  // A Run this tab views stays while the other tab reclaims unrelated cache.
  await page.evaluate(async (path) => {
    const { createBrowserSimulationArtifactStore } = await import(path);
    const store = createBrowserSimulationArtifactStore(
      "cross-tab-byte-budget",
      indexedDB,
      { retainSession: true, limits: { bytes: 16, files: 8 } },
    );
    for (const [id, at] of [
      ["viewed", 1],
      ["unrelated", 2],
      ["latest", 3],
    ]) {
      const ref = {
        id,
        name: "result.raw",
        mediaType: "text/plain",
        byteLength: 4,
        sha256: await store.digest("data"),
      };
      await store.put(ref, "data");
      await store.saveCatalog({
        storedAt: at,
        catalog: {
          schemaVersion: 1,
          runId: id,
          preparedId: "prepared",
          inputRevision: "rev",
          retentionPolicy: "cache",
          execution: "completed",
          collection: "complete",
          files: [ref],
          datasets: [],
        },
      });
    }
    (window as any).viewedEvidence = await store.pinRun("viewed");
  }, artifactUrl);
  const reclaimed = await peer.evaluate(async (path) => {
    const { createBrowserSimulationArtifactStore } = await import(path);
    const store = createBrowserSimulationArtifactStore(
      "cross-tab-byte-budget",
      indexedDB,
      { retainSession: true, limits: { bytes: 16, files: 8 } },
    );
    await store.put(
      {
        id: "incoming",
        name: "result.raw",
        mediaType: "text/plain",
        byteLength: 8,
        sha256: await store.digest("incoming"),
      },
      "incoming",
    );
    return {
      viewed: (await store.get("viewed"))?.text,
      unrelated: await store.get("unrelated"),
      bytes: (await store.usage()).byteLength,
    };
  }, artifactUrl);
  expect(reclaimed).toEqual({ viewed: "data", unrelated: null, bytes: 16 });

  // Closing the tab that holds a lease releases it.
  await page.evaluate(async () => {
    await (window as any).evidenceLease.acquire();
  });
  expect(await attempt()).toEqual({ available: false });
  await page.close();
  await expect.poll(attempt).toEqual({ available: true, value: "reclaimed" });
});
