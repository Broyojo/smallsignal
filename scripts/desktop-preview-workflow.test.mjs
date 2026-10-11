import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/desktop-preview.yml", "utf8");
const release = readFileSync(".github/workflows/desktop-release.yml", "utf8");

describe("desktop distribution gates", () => {
  it("only explicitly publishes accepted mainline builds as desktop prereleases", () => {
    expect(workflow).toContain(
      "git merge-base --is-ancestor $sourceCommit origin/main",
    );
    expect(release).toContain(
      "needs: package\n    if: github.event_name == 'workflow_dispatch' && inputs.publish",
    );
    expect(release).not.toContain("--clobber");
    expect(workflow).not.toContain("pull_request_target:");
    expect(workflow).not.toContain("secrets.");
  });
});
