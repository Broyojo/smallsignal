import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  RecoveryAvailableBanner,
  RecoveryFailureBanner,
  recoveryStateLabel,
} from "./recovery-banners";

describe("recovery banners", () => {
  it("keeps normal recovery writes silent and exposes only failures", () => {
    expect(recoveryStateLabel("idle")).toBeNull();
    expect(recoveryStateLabel("pending")).toBeNull();
    expect(recoveryStateLabel("stored")).toBeNull();
    expect(recoveryStateLabel("failed")).toContain("failed");
  });

  it("names a full or unavailable store in the statusbar and the warning", () => {
    expect(recoveryStateLabel("quota-exceeded")).toBe(
      "Recovery full — download now",
    );
    expect(recoveryStateLabel("unavailable")).toBe(
      "Recovery unavailable — download now",
    );
    const warning = (state: "quota-exceeded" | "unavailable") =>
      renderToStaticMarkup(
        <RecoveryFailureBanner
          state={state}
          onDownload={vi.fn()}
          onDismiss={vi.fn()}
        />,
      );
    expect(warning("quota-exceeded")).toContain(
      "storage for this site is full",
    );
    expect(warning("unavailable")).toContain("storage is unavailable");
    for (const state of ["quota-exceeded", "unavailable"] as const) {
      expect(warning(state)).toContain('role="alert"');
      expect(warning(state)).toContain("Download Backup");
      expect(warning(state)).toContain("Dismiss warning");
    }
  });

  it("offers non-modal restore, backup, and ignore actions", () => {
    const html = renderToStaticMarkup(
      <RecoveryAvailableBanner
        projectName="OTA"
        updatedAt="2026-08-28T08:30:00.000Z"
        onRestore={vi.fn()}
        onDownload={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(html).toContain("startup-recovery-banner");
    expect(html).toContain("OTA");
    expect(html).toContain("Restore");
    expect(html).toContain("Download backup");
    expect(html).toContain("Ignore");
    expect(html).not.toContain('role="dialog"');
  });
});
