import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/ci.yml", "utf8");

describe("CI workflow", () => {
  it("keeps the required check names branch protection depends on", () => {
    for (const name of ["Core contracts", "Browser tests"])
      expect(workflow).toContain(`name: ${name}\n`);
  });

  it("fails each required check when the job it aggregates fails", () => {
    // Without always() a failed shard skips the aggregate, and GitHub
    // counts a skipped required check as passing.
    expect(workflow).toContain(
      "if: always() && github.event_name == 'merge_group' && needs.changes.outputs.heavy == 'true'",
    );
    expect(workflow).toContain('test "$CORE_RESULT" = "success"');
    expect(workflow).toContain(
      "if: always() && github.event_name == 'merge_group' && needs.changes.outputs.browser == 'true'",
    );
    expect(workflow).toContain('test "$SHARD_RESULT" = "success"');
  });
});
