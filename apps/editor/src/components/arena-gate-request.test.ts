import { describe, expect, it } from "vitest";

import { gateAfterManualCloudSave } from "./arena-gate-request";

describe("the Arena gate after a manual Cloud Save", () => {
  it("opens once the save has completed", async () => {
    let opened = 0;
    const outcome = { status: "saved" as const };
    expect(gateAfterManualCloudSave(outcome, () => opened++)).toBe(outcome);
    expect(opened).toBe(1);
  });

  it("stays shut when nothing was saved", () => {
    let opened = 0;
    for (const status of ["conflict", "unreachable", "unauthorized", "failed"])
      gateAfterManualCloudSave({ status }, () => opened++);
    expect(opened).toBe(0);
  });
});
