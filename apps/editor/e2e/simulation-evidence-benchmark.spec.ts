import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import { harnessModuleUrl } from "./helpers/harness-url";

// Synthetic numeric evidence, never a user's circuit or historical waveform.
function evidence(rows: number, signals: number) {
  const values = Array.from({ length: signals }, (_, signal) =>
    Array.from({ length: rows }, (_, row) =>
      signal === 0
        ? row * 0.05e-9
        : Math.sin(row * 0.002 + signal * 0.11) * (1 + signal * 0.001),
    ),
  );
  const csv = [
    Array.from({ length: signals }, (_, index) =>
      index === 0 ? "time" : `V(n${index})`,
    ).join(","),
  ];
  const raw = [
    "Title: Storage acceptance\nPlotname: Transient Analysis\nFlags: real",
    `No. Variables: ${signals}\nNo. Points: ${rows}\nVariables:`,
    ...values.map(
      (_, index) =>
        `\t${index}\t${index === 0 ? "time" : `v(n${index})`}\t${index === 0 ? "time" : "voltage"}`,
    ),
    "Values:",
  ];
  for (let row = 0; row < rows; row++) {
    csv.push(values.map((column) => column[row]!.toExponential(14)).join(","));
    raw.push(
      values
        .map(
          (column, index) =>
            `${index === 0 ? row : ""}\t${column[row]!.toExponential(15)}`,
        )
        .join("\n"),
    );
  }
  return [
    { name: "out.raw", role: "raw", text: raw.join("\n") + "\n" },
    {
      name: "result.json",
      role: "result-json",
      text: JSON.stringify({ analyses: [{ kind: "tran", vectors: values }] }),
    },
    ...(
      [
        ["tran-0.csv", csv.join("\r\n") + "\r\n"],
        ["op-1.csv", "\uFEFFnode,voltage\r\nvout,0.9\r\n"],
        [
          "ac-2.csv",
          "frequency,V(out).real,V(out).imag\r\n1,2,-3\r\n1000,1,-2\r\n",
        ],
        ["dc-3.csv", "sweep,V(out)\r\n0,0\r\n1,0.95\r\n"],
        ["noise-4.csv", "frequency,onoise\r\n1,1e-9\r\n1000,3e-10\r\n"],
      ] as const
    ).map(([name, text]) => ({ name, role: "analysis-csv", text })),
  ].map((file) => ({
    ...file,
    bytes: Buffer.byteLength(file.text),
    sha256: createHash("sha256").update(file.text).digest("hex"),
  }));
}

// A real browser Worker compresses and restores every supported analysis's
// files. Store admission, identity and atomicity are the artifact store's
// module tests.
test("Browser codec preserves complete OP/AC/DC/TRAN/Noise evidence", async ({
  page,
}) => {
  const corpus = evidence(1024, 8);
  await page.route("**/evidence-fixture/*", async (route) => {
    const index = Number(
      new URL(route.request().url()).pathname.split("/").at(-1),
    );
    await route.fulfill({
      contentType: "text/plain",
      body: corpus[index]!.text,
    });
  });
  await page.goto("/editor");
  const result = await page.evaluate(
    async ({ artifactUrl, filesUrl, descriptors }) => {
      const { createBrowserSimulationArtifactStore } = await import(
        artifactUrl
      );
      const { SimulationFiles } = await import(filesUrl);
      const projectId = "codec-evidence";
      const store = createBrowserSimulationArtifactStore(projectId, indexedDB, {
        compression: true,
        retainSession: true,
      });
      const files = new SimulationFiles(Date.now, undefined, undefined, store);
      // A timer that keeps firing shows the main thread stayed responsive.
      let beats = 0;
      const heartbeat = setInterval(() => {
        beats++;
      }, 10);
      // The store takes a lazy iterable; each fixture's public identity is
      // prepared as its body arrives.
      const identities: any[] = [];
      async function* bodies() {
        for (const [index, file] of descriptors.entries()) {
          const response = await fetch("/evidence-fixture/" + index);
          // Fetch.text() removes a UTF-8 BOM; the fixture supplies exact bytes.
          const text = new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: true,
          }).decode(await response.arrayBuffer());
          const ref = {
            id: crypto.randomUUID(),
            fileId: crypto.randomUUID(),
            name: file.name,
            mediaType: file.name.endsWith("json")
              ? "application/json"
              : "text/plain",
            role: file.role,
            byteLength: new Blob([text]).size,
            sha256: await store.digest(text),
          };
          identities.push(ref);
          yield { ref, text };
        }
      }
      await store.publishEvidence(bodies(), () => ({
        storedAt: Date.now(),
        catalog: {
          schemaVersion: 1,
          runId: "codec-run",
          preparedId: "prepared",
          inputRevision: "rev",
          execution: "completed",
          collection: "complete",
          retentionPolicy: "cache",
          files: identities,
          datasets: [],
        },
      }));
      const usage = await files.resourceUsage();
      const reopened = createBrowserSimulationArtifactStore(
        projectId,
        indexedDB,
      );
      for (const [index, ref] of identities.entries()) {
        const original = descriptors[index]!;
        const restored = await reopened.get(ref.id);
        if (
          !restored ||
          new Blob([restored.text]).size !== original.bytes ||
          (await reopened.digest(restored.text)) !== original.sha256
        )
          throw new Error("Original evidence changed");
      }
      clearInterval(heartbeat);
      await store.releaseSession();
      return { beats, usage };
    },
    {
      artifactUrl: harnessModuleUrl("browser-simulation-artifact-store"),
      filesUrl: harnessModuleUrl("simulation-files"),
      descriptors: corpus.map(({ text: _text, ...descriptor }) => descriptor),
    },
  );
  const originalBytes = corpus.reduce((sum, file) => sum + file.bytes, 0);
  expect(result.usage.usedBytes).toBeLessThan(originalBytes);
  expect(result.usage.logicalBytes).toBe(originalBytes);
  expect(result.usage.fileCount).toBe(corpus.length);
  expect(result.beats).toBeGreaterThan(0);
});
