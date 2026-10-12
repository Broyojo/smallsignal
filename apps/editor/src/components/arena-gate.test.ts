import { describe, expect, it } from "vitest";

import {
  ARENA_GATE_PAGE,
  createArenaGate,
  FAILURES_ALLOWED,
  gateClosable,
  VOTES_REQUIRED,
} from "./arena-gate";

const OPENED = "Mon, 12 Oct 2026 10:00:00 GMT";
const BEFORE = "2026-10-12T09:59:59.400Z";
const after = (second: number) =>
  `2026-10-12T10:00:${String(second).padStart(2, "0")}.250Z`;

type Answer = Response | Error;

/**
 * Arena behind the Canvas Worker: the Voter's voted Battles and the
 * leaderboard, each answered from its own queue (the last answer repeats).
 */
function arena({
  past,
  season = ["s1"],
}: {
  past: Answer[];
  season?: (string | null | Error)[];
}) {
  const asked: string[] = [];
  const take = <T>(queue: T[]) =>
    queue.length > 1 ? queue.shift()! : queue[0]!;
  const fetchLike = (async (input: RequestInfo | URL) => {
    const path = String(input);
    asked.push(path);
    if (path === "/api/arena/battles/past") {
      const answer = take(past);
      if (answer instanceof Error) throw answer;
      return answer.clone();
    }
    if (path === "/api/arena/leaderboard") {
      const answer = take(season);
      if (answer instanceof Error) throw answer;
      return Response.json({ season: answer });
    }
    throw new Error(`unexpected ${path}`);
  }) as typeof fetch;
  return { fetchLike, asked };
}

/** Past Battles cast at these times, newest first, answered at `date`. */
const past = (castAts: string[], date = OPENED) =>
  Response.json(
    {
      battles: castAts.map((castAt, index) => ({ id: `b${index}`, castAt })),
      more: false,
      total: castAts.length,
    },
    { headers: { date } },
  );
const refusal = (status: number, error: string) =>
  Response.json(
    { error, message: error },
    { status, headers: { date: OPENED } },
  );

describe("the Arena gate's count", () => {
  it("counts only Votes cast after it opened, by Arena's own clock", async () => {
    const { fetchLike } = arena({
      past: [past([BEFORE]), past([after(30), after(10), BEFORE])],
    });
    // The browser's clock is an hour off; Arena's Date answer sets the start.
    const gate = createArenaGate(fetchLike, () => Date.parse(OPENED) + 3.6e6);
    expect(await gate.start()).toEqual({ status: "voting", voted: 0 });
    expect(await gate.recount()).toEqual({ status: "voting", voted: 2 });
    expect(gateClosable(gate.state())).toBe(false);
  });

  it("unlocks at five new Votes and stays unlocked", async () => {
    const five = [5, 4, 3, 2, 1].map(after);
    const { fetchLike } = arena({
      past: [
        past([BEFORE]),
        past([...five, BEFORE]),
        refusal(503, "arena-unavailable"),
      ],
    });
    const gate = createArenaGate(fetchLike);
    await gate.start();
    expect(await gate.recount()).toEqual({
      status: "voting",
      voted: VOTES_REQUIRED,
    });
    expect(gateClosable(gate.state())).toBe(true);
    expect(await gate.recount()).toEqual({
      status: "voting",
      voted: VOTES_REQUIRED,
    });
  });

  it("opens for a Voter who must first agree to the Consent, and counts once Arena lists Votes", async () => {
    const { fetchLike } = arena({
      past: [
        refusal(403, "consent-required"),
        refusal(403, "consent-required"),
        // Agreed in Arena's window: older Votes from an earlier Consent and
        // one new Vote.
        past([after(40), BEFORE, BEFORE], "Mon, 12 Oct 2026 10:01:00 GMT"),
      ],
    });
    const gate = createArenaGate(fetchLike);
    expect(await gate.start()).toEqual({ status: "voting", voted: 0 });
    expect(await gate.recount()).toEqual({ status: "voting", voted: 0 });
    expect(await gate.recount()).toEqual({ status: "voting", voted: 1 });
  });

  it("never counts down when answers arrive out of order", async () => {
    const { fetchLike } = arena({
      past: [past([]), past([after(2), after(1)]), past([after(1)])],
    });
    const gate = createArenaGate(fetchLike);
    await gate.start();
    await gate.recount();
    expect(await gate.recount()).toEqual({ status: "voting", voted: 2 });
  });
});

describe("the Arena gate never traps anyone", () => {
  it("is closable at once when Arena fails or cannot be reached as it opens", async () => {
    for (const answer of [
      refusal(503, "arena-unavailable"),
      new TypeError("Failed to fetch"),
    ]) {
      const gate = createArenaGate(arena({ past: [answer] }).fetchLike);
      const state = await gate.start();
      expect(state).toEqual({ status: "free", reason: "unavailable" });
      expect(gateClosable(state)).toBe(true);
    }
  });

  it(`unlocks after ${FAILURES_ALLOWED} failed reads in a row while counting, not after one`, async () => {
    const down = new TypeError("Failed to fetch");
    const { fetchLike } = arena({
      past: [past([]), down, past([after(1)]), down, down, down],
    });
    const gate = createArenaGate(fetchLike);
    await gate.start();
    expect(await gate.recount()).toEqual({ status: "voting", voted: 0 });
    expect(await gate.recount()).toEqual({ status: "voting", voted: 1 });
    for (let failure = 1; failure < FAILURES_ALLOWED; failure++)
      expect(await gate.recount()).toEqual({ status: "voting", voted: 1 });
    expect(await gate.recount()).toEqual({
      status: "free",
      reason: "unavailable",
    });
  });

  it("is closable when Arena has no Season serving Battles, as it opens or later", async () => {
    const closed = createArenaGate(
      arena({ past: [past([])], season: [null] }).fetchLike,
    );
    expect(await closed.start()).toEqual({
      status: "free",
      reason: "no-battle",
    });

    const { fetchLike, asked } = arena({
      past: [past([])],
      season: ["s1", null],
    });
    const later = createArenaGate(fetchLike);
    await later.start();
    // An ordinary recount reads the count alone; a return to the page also
    // asks whether a Season still serves Battles.
    expect(await later.recount()).toEqual({ status: "voting", voted: 0 });
    expect(asked.filter((path) => path.endsWith("leaderboard"))).toHaveLength(
      1,
    );
    expect(await later.recount({ season: true })).toEqual({
      status: "free",
      reason: "no-battle",
    });
  });

  it("shows nothing to an AI account, a signed-out visitor or where no Arena answers", async () => {
    for (const answer of [
      refusal(403, "ai-account"),
      refusal(401, "signed-out"),
      new Response("<!doctype html>", {
        headers: { "content-type": "text/html" },
      }),
    ]) {
      const gate = createArenaGate(arena({ past: [answer] }).fetchLike);
      expect(await gate.start()).toEqual({ status: "closed" });
    }
  });

  it("frees a person signed out while counting", async () => {
    const gate = createArenaGate(
      arena({ past: [past([]), refusal(401, "signed-out")] }).fetchLike,
    );
    await gate.start();
    expect(await gate.recount()).toEqual({
      status: "free",
      reason: "signed-out",
    });
  });
});

describe("the battle page the gate opens", () => {
  it("is the Schematic Arena's page, marked so Arena records its Votes as the gate's", () => {
    const address = new URL(ARENA_GATE_PAGE, "https://analog-canvas.test");
    // On Analog Canvas's host /schematic hands the visitor on to
    // chip-arena.com signed in, query kept (docs/specs/analog-arena.md).
    expect(address.origin).toBe("https://analog-canvas.test");
    expect(address.pathname).toBe("/schematic");
    // Arcadia-1/chip-arena#234: Votes cast on a page opened with
    // from=canvas-gate keep the source "canvas-gate".
    expect(address.searchParams.get("from")).toBe("canvas-gate");
  });
});
