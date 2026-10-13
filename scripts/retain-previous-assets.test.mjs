import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  HISTORY_FILE,
  planAssetRetention,
  retainPreviousAssets,
} from "./retain-previous-assets.mjs";

const NOW = Date.parse("2026-10-13T20:00:00.000Z");
const ago = (days) => new Date(NOW - days * 86_400_000).toISOString();
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("keeping recent deploys' assets for tabs opened before a deploy", () => {
  it("carries what a deploy served within the week and this build lacks", () => {
    const { retain, history } = planAssetRetention({
      previous: {
        "App-old.js": ago(1),
        "App-older.js": ago(6.9),
        "App-expired.js": ago(8),
        "App-new.js": ago(1),
        "../escape.js": ago(1),
        "App-garbled.js": "yesterday-ish",
      },
      current: ["App-new.js", "index-now.css"],
      now: NOW,
    });
    expect(retain.map((item) => item.name)).toEqual([
      "App-old.js",
      "App-older.js",
    ]);
    expect(history).toEqual({
      version: 1,
      assets: {
        "App-old.js": ago(1),
        "App-older.js": ago(6.9),
        "App-new.js": new Date(NOW).toISOString(),
        "index-now.css": new Date(NOW).toISOString(),
      },
    });
  });

  it("downloads them beside the build and never fails the deploy", async () => {
    const dist = mkdtempSync(join(tmpdir(), "retain-assets-"));
    roots.push(dist);
    mkdirSync(join(dist, "assets"));
    writeFileSync(join(dist, "assets", "App-new.js"), "new");
    const served = {
      "/asset-history.json": Response.json({
        version: 1,
        assets: { "App-old.js": ago(1), "App-gone.js": ago(2) },
      }),
      "/assets/App-old.js": new Response("old", {
        headers: { "content-type": "text/javascript" },
      }),
      "/assets/App-gone.js": new Response("missing", { status: 404 }),
    };
    const fetchLike = async (url) =>
      served[new URL(url).pathname] ?? new Response("", { status: 404 });
    const logs = [];
    const result = await retainPreviousAssets(dist, "https://live.example", {
      fetchLike,
      now: NOW,
      log: (line) => logs.push(line),
    });
    expect(result.kept).toBe(1);
    expect(result.failed).toEqual(["App-gone.js"]);
    expect(readFileSync(join(dist, "assets", "App-old.js"), "utf8")).toBe(
      "old",
    );
    // The history the next deploy reads names what this deploy serves.
    expect(
      JSON.parse(readFileSync(join(dist, HISTORY_FILE), "utf8")).assets,
    ).toEqual({
      "App-old.js": ago(1),
      "App-new.js": new Date(NOW).toISOString(),
    });

    // No history at all (the first deploy, or the site down): it starts one.
    const fresh = mkdtempSync(join(tmpdir(), "retain-assets-"));
    roots.push(fresh);
    mkdirSync(join(fresh, "assets"));
    writeFileSync(join(fresh, "assets", "App-new.js"), "new");
    const offline = await retainPreviousAssets(fresh, "https://live.example", {
      fetchLike: async () => {
        throw new Error("offline");
      },
      now: NOW,
      log: () => undefined,
    });
    expect(offline.kept).toBe(0);
    expect(
      JSON.parse(readFileSync(join(fresh, HISTORY_FILE), "utf8")).assets,
    ).toEqual({ "App-new.js": new Date(NOW).toISOString() });
  });
});
