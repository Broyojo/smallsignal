import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const compose = readFileSync("containers/ngspice/host/compose.yaml", "utf8");

describe("the operator simulator host", () => {
  it("keeps the untrusted executor private, unprivileged and without the host token", () => {
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
    expect(executor).not.toContain("SIMULATION_ACCESS_TOKEN");
    expect(gateway).toContain("SIMULATION_ACCESS_TOKEN");
  });
});
