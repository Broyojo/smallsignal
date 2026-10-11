import { afterEach, describe, expect, it, vi } from "vitest";
import { claimDeadline } from "./claim-clock";

describe("a Claim's deadline on the page clock", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // The page shows a Claim until this deadline, measured on the page's
  // elapsed clock, so a wrong or changing wall clock cannot expire it.
  it("follows the relay's clock, whatever the computer's says", () => {
    const serverNow = Date.UTC(2026, 9, 12, 8, 0, 0);
    const responseDate = new Date(serverNow).toUTCString();
    for (const skew of [31 * 60_000, -24 * 60 * 60_000]) {
      vi.useFakeTimers({ now: serverNow + skew });
      // One second off for the Date header's precision.
      expect(claimDeadline(serverNow + 300_000, responseDate, 5_000)).toBe(
        5_000 + 299_000,
      );
    }
  });

  it("is already past for a Claim the relay says has expired", () => {
    const serverNow = Date.UTC(2026, 9, 12, 8, 0, 0);
    expect(
      claimDeadline(
        serverNow - 10_000,
        new Date(serverNow).toUTCString(),
        5_000,
      ),
    ).toBe(5_000);
  });

  it("estimates from the wall clock when an older relay sends no Date", () => {
    vi.useFakeTimers({ now: 1_000_000 });
    expect(claimDeadline(1_300_000, null, 5_000)).toBe(305_000);
  });
});
