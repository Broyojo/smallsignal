import { afterEach, describe, expect, it, vi } from "vitest";

import {
  liveEntryScript,
  pageEntryScript,
  watchForNewDeploy,
} from "./app-update";

const shell = (entry: string) =>
  `<!doctype html><head><script type="module" crossorigin src="${entry}"></script></head>`;

afterEach(() => {
  vi.useRealTimers();
});

describe("a newer deploy than this page (2026-10-13)", () => {
  it("reads this page's entry and the live one", async () => {
    expect(
      pageEntryScript({
        querySelector: (selector: string) =>
          selector.includes('[src^="/assets/"]')
            ? ({ getAttribute: () => "/assets/index-AAA.js" } as never)
            : null,
      }),
    ).toBe("/assets/index-AAA.js");
    expect(pageEntryScript({ querySelector: () => null })).toBeNull();
    const served = vi.fn(
      async () => new Response(shell("/assets/index-BBB.js")),
    );
    expect(await liveEntryScript(served as never)).toBe("/assets/index-BBB.js");
    expect(served).toHaveBeenCalledWith(
      "/editor",
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(
      await liveEntryScript((async () => {
        throw new Error("offline");
      }) as never),
    ).toBeNull();
  });

  it("tells once a different entry is live, checking on focus and on a timer", async () => {
    vi.useFakeTimers();
    let live = "/assets/index-AAA.js";
    const fetchLike = vi.fn(async () => new Response(shell(live)));
    const listeners = new Map<string, () => void>();
    const target = {
      addEventListener: (type: string, listener: () => void) =>
        void listeners.set(type, listener),
      removeEventListener: (type: string) => void listeners.delete(type),
    };
    const onNewDeploy = vi.fn();
    watchForNewDeploy(onNewDeploy, {
      fetchLike: fetchLike as never,
      own: "/assets/index-AAA.js",
      everyMs: 600_000,
      target: target as never,
      visible: () => true,
    });
    // The same deploy: nothing to say.
    listeners.get("focus")!();
    await vi.advanceTimersByTimeAsync(0);
    expect(onNewDeploy).not.toHaveBeenCalled();
    // A focus within the minute asks nothing more.
    listeners.get("focus")!();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchLike).toHaveBeenCalledTimes(1);
    // A deploy later, the timer finds it, once, and stops.
    live = "/assets/index-CCC.js";
    await vi.advanceTimersByTimeAsync(600_000);
    expect(onNewDeploy).toHaveBeenCalledTimes(1);
    expect(listeners.has("focus")).toBe(false);
    await vi.advanceTimersByTimeAsync(1_800_000);
    expect(onNewDeploy).toHaveBeenCalledTimes(1);
  });

  it("checks nothing on a page with no built entry", () => {
    const fetchLike = vi.fn();
    watchForNewDeploy(() => undefined, {
      fetchLike: fetchLike as never,
      own: null,
      target: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    });
    expect(fetchLike).not.toHaveBeenCalled();
  });
});
