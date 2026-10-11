import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const compose = readFileSync("containers/ngspice/host/compose.yaml", "utf8");
const deploy = readFileSync("containers/ngspice/host/deploy.sh", "utf8");

describe("the operator simulator host", () => {
  it("keeps the untrusted executor private, unprivileged, bounded and without the host token", () => {
    expect(compose).toContain("read_only: true");
    expect(compose).toMatch(/cap_drop:\s*\n\s*- ALL/u);
    expect(compose).toContain("internal: true");
    expect(compose).not.toMatch(/^\s*ports:/mu);
    const executor = compose.slice(
      compose.indexOf("  executor:"),
      compose.indexOf("  simulator:"),
    );
    const gateway = compose.slice(
      compose.indexOf("  simulator:"),
      compose.indexOf("  tunnel:"),
    );
    expect(executor).toContain("pids_limit: 256");
    expect(executor).toContain("cpus: 8.0");
    expect(executor).toContain("mem_limit: 16g");
    expect(executor).not.toContain("SIMULATION_ACCESS_TOKEN");
    expect(gateway).toContain("SIMULATION_ACCESS_TOKEN");
  });

  it("never prunes the host's other Docker data", () => {
    expect(deploy).not.toMatch(/docker (?:system|volume|network) prune/u);
  });
});
