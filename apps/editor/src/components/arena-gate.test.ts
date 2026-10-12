import { describe, expect, it } from "vitest";

import {
  ARENA_GATE_PAGE,
  createArenaGate,
  gateClosable,
  VOTES_REQUIRED,
  watchArenaFrame,
} from "./arena-gate";

/** Arena's past-Battles answers, one per read, as the Canvas Worker serves them. */
function arenaAnswering(...answers: (Response | Error)[]): typeof fetch {
  const queue = [...answers];
  return (async (input: RequestInfo | URL) => {
    expect(String(input)).toBe("/api/arena/battles/past");
    const next = queue.shift();
    if (!next) throw new Error("no answer left");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
}

const past = (...ids: string[]) =>
  Response.json({
    battles: ids.map((id) => ({ id })),
    more: false,
    total: ids.length,
  });

describe("the Arena gate's count", () => {
  it("counts only Battles voted after the newest one when it opened", async () => {
    const gate = createArenaGate(
      arenaAnswering(past("b2", "b1"), past("b4", "b3", "b2", "b1")),
    );
    expect(await gate.start()).toEqual({ status: "voting", voted: 0 });
    expect(await gate.recount()).toEqual({ status: "voting", voted: 2 });
    expect(gateClosable(gate.state())).toBe(false);
  });

  it("opens to a first-time Voter and counts every Vote", async () => {
    const gate = createArenaGate(arenaAnswering(past(), past("n1")));
    await gate.start();
    expect(await gate.recount()).toEqual({ status: "voting", voted: 1 });
  });

  it("lets the panel close once five new Votes are recorded, and stays closable", async () => {
    const gate = createArenaGate(
      arenaAnswering(
        past("old"),
        past("n5", "n4", "n3", "n2", "n1", "old"),
        Response.json({ error: "arena-unavailable" }, { status: 503 }),
      ),
    );
    await gate.start();
    expect(await gate.recount()).toEqual({
      status: "voting",
      voted: VOTES_REQUIRED,
    });
    expect(gateClosable(gate.state())).toBe(true);
    // A later failure changes nothing once the Votes are in.
    expect(await gate.recount()).toEqual({
      status: "voting",
      voted: VOTES_REQUIRED,
    });
  });

  it("counts a full page past an entry it no longer lists", async () => {
    const ids = Array.from({ length: 20 }, (_, index) => `n${20 - index}`);
    const gate = createArenaGate(arenaAnswering(past("old"), past(...ids)));
    await gate.start();
    expect(await gate.recount()).toEqual({ status: "voting", voted: 5 });
  });
});

describe("the Arena gate never traps anyone", () => {
  it("is closable at once when Arena fails or cannot be reached", async () => {
    for (const answer of [
      Response.json({ error: "arena-unavailable" }, { status: 503 }),
      new TypeError("Failed to fetch"),
    ]) {
      const gate = createArenaGate(arenaAnswering(answer));
      const state = await gate.start();
      expect(state).toEqual({ status: "free", reason: "unavailable" });
      expect(gateClosable(state)).toBe(true);
    }
  });

  it("becomes closable when Arena fails while counting", async () => {
    const gate = createArenaGate(
      arenaAnswering(past("old"), new TypeError("Failed to fetch")),
    );
    await gate.start();
    expect(await gate.recount()).toEqual({
      status: "free",
      reason: "unavailable",
    });
  });

  it("becomes closable when Arena has no Battle to offer", async () => {
    const gate = createArenaGate(arenaAnswering(past("old")));
    await gate.start();
    expect(gate.noBattle()).toEqual({ status: "free", reason: "no-battle" });
    expect(gateClosable(gate.state())).toBe(true);
  });

  it("does not open for someone who cannot vote", async () => {
    for (const answer of [
      Response.json({ error: "signed-out" }, { status: 401 }),
      Response.json({ error: "ai-account" }, { status: 403 }),
    ]) {
      const gate = createArenaGate(arenaAnswering(answer));
      expect(await gate.start()).toEqual({ status: "closed" });
    }
  });

  it("does not open where no Arena answers, as on a static server", async () => {
    const gate = createArenaGate(
      arenaAnswering(
        new Response("<!doctype html>", {
          headers: { "content-type": "text/html" },
        }),
      ),
    );
    expect(await gate.start()).toEqual({ status: "closed" });
  });

  it("frees a person who signs out while voting", async () => {
    const gate = createArenaGate(
      arenaAnswering(
        past("old"),
        Response.json({ error: "signed-out" }, { status: 401 }),
      ),
    );
    await gate.start();
    expect(await gate.recount()).toEqual({
      status: "free",
      reason: "signed-out",
    });
  });
});

describe("watching the framed Arena page", () => {
  /** A frame whose page fetches as Arena answers `status` for `path`. */
  function frame(answers: Record<string, number>) {
    const window = {
      location: { href: "https://canvas.test/schematic" },
      fetch: (async (input: RequestInfo | URL) => {
        const path = new URL(String(input), "https://canvas.test").pathname;
        return new Response("{}", { status: answers[path] ?? 200 });
      }) as typeof fetch,
    };
    return window;
  }

  it("hears that Arena has no Battle and that a Vote was recorded", async () => {
    const page = frame({ "/api/arena/battles/next": 404 });
    const heard: string[] = [];
    watchArenaFrame(page, {
      noBattle: () => heard.push("no-battle"),
      voted: () => heard.push("voted"),
    });
    const next = await page.fetch("/api/arena/battles/next", {
      method: "POST",
    });
    // The page still reads its own answer.
    expect(next.status).toBe(404);
    await page.fetch("/api/arena/battles/b-1/vote", { method: "POST" });
    await page.fetch("/api/arena/battles/b-1/shown", { method: "POST" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(heard).toEqual(["no-battle", "voted"]);
  });

  it("ignores a refused Vote and watches a page only once", async () => {
    const page = frame({ "/api/arena/battles/b-1/vote": 429 });
    const heard: string[] = [];
    const listener = {
      noBattle: () => heard.push("no-battle"),
      voted: () => heard.push("voted"),
    };
    watchArenaFrame(page, listener);
    watchArenaFrame(page, listener);
    await page.fetch("/api/arena/battles/b-1/vote", { method: "POST" });
    await page.fetch("/api/arena/battles/b-2/vote", { method: "POST" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(heard).toEqual(["voted"]);
  });
});

describe("the framed Arena page", () => {
  it("is the battle page on this origin, marked so Arena records its Votes as the gate's", () => {
    const address = new URL(ARENA_GATE_PAGE, "https://canvas.test");
    expect(address.origin).toBe("https://canvas.test");
    expect(address.pathname).toBe("/schematic");
    // Arena's contract (Arcadia-1/chip-arena#234): a Vote cast on a page
    // opened with from=canvas-gate keeps the source "canvas-gate".
    expect(address.searchParams.get("from")).toBe("canvas-gate");
  });
});
