import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startVacaskService } from "./entrypoint.mjs";

const services = [];
let root, config;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "icm-native-start-"));
  const startupPath = join(root, "startup.toml");
  await writeFile(startupPath, "# controlled\n");
  config = {
    runtime: {
      executor: "local-host",
      profileId: "native-start-proof",
      binary: resolve(process.env.VACASK_BIN ?? "plan/missing-vacask"),
      modules: resolve(process.env.VACASK_MODULES ?? "plan/missing-modules"),
      startupPath,
      runRoot: join(root, "jobs"),
      ...(process.env.ICM_VACASK_LIBRARY_PATH
        ? { libraryPath: process.env.ICM_VACASK_LIBRARY_PATH }
        : {}),
    },
    capabilities: {
      configured: true,
      rawfileCollection: "native-multi-ascii",
      maxInputFiles: 8,
      inputs: ["source"],
      analyses: ["op", "tran"],
      parsedAnalyses: ["op", "tran"],
      profiles: [{ id: "native-start-proof", corners: [] }],
      maxTimeoutMs: 15000,
      maxInputBytes: 65536,
      maxOutputBytes: 131072,
      cancel: true,
    },
    limits: {
      maxInputBytes: 65536,
      maxInputFiles: 8,
      maxOutputBytes: 131072,
      maxLogBytes: 65536,
      maxRawFiles: 8,
      maxEntries: 128,
    },
    listen: { host: "127.0.0.1", port: 0 },
  };
});
afterEach(async () => {
  for (const service of services.splice(0)) await service.stop();
  await rm(root, { recursive: true, force: true });
});
const base = (service) => `http://127.0.0.1:${service.server.address().port}`;
async function start(value = config) {
  const service = await startVacaskService(value);
  services.push(service);
  return service;
}
describe("native service startup and recovery", () => {
  it("refuses implicit public local bindings and invalid limits before starting", async () => {
    await expect(
      start({ ...config, listen: { host: "0.0.0.0", port: 0 } }),
    ).rejects.toThrow("loopback");
    await expect(
      start({ ...config, limits: { ...config.limits, maxInputBytes: 0 } }),
    ).rejects.toThrow("resource limits");
  });
  it("keeps failed runtime health available without becoming configured", async () => {
    const service = await start({
      ...config,
      runtime: { ...config.runtime, binary: join(root, "absent") },
    });
    await expect(service.ready).rejects.toThrow();
    expect((await fetch(base(service) + "/health")).status).toBe(503);
    const reply = await fetch(base(service) + "/api/simulate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation: "capabilities" }),
    });
    expect(await reply.json()).toMatchObject({ configured: false });
  });
});
