// The Arena gate's count (#1681): after a manual Cloud Save and on every
// opening of the Cloud shelf, the Schematic Arena asks for five Votes before
// its panel closes. Arena lists a Voter's own voted Battles newest first
// (GET /api/arena/battles/past, forwarded by this site's Worker with the
// signed-in account), so the newest one when the gate opens is the baseline
// and every Battle listed before it is a new Vote.
//
// The gate never traps anyone: when Arena fails, cannot be reached or has no
// Battle to offer, the panel may close at once. Someone Arena cannot count
// (signed out, or an AI account, which may not vote) never sees it, and
// neither does anyone on a server with no Arena behind it.

/**
 * The Schematic Arena's battle page as the gate frames it, on this site's
 * own origin. `from=canvas-gate` makes Arena record each Vote cast there
 * with the source `canvas-gate` (docs/specs/analog-arena.md#vote-source).
 */
export const ARENA_GATE_PAGE = "/schematic?from=canvas-gate";

/** The Votes a gate asks for. */
export const VOTES_REQUIRED = 5;

const PAST_PATH = "/api/arena/battles/past";

/** Why the panel may close before the Votes are in. */
export type ArenaGateFreeReason = "unavailable" | "no-battle" | "signed-out";

export type ArenaGateState =
  | { status: "checking" }
  /** Nothing to show: no Arena here, or nobody Arena could count. */
  | { status: "closed" }
  | { status: "voting"; voted: number }
  | { status: "free"; reason: ArenaGateFreeReason };

type PastRead =
  | { kind: "listed"; ids: string[] }
  | { kind: "not-a-voter" }
  | { kind: "unavailable" }
  | { kind: "absent" };

async function readPast(fetchLike: typeof fetch): Promise<PastRead> {
  let response: Response;
  try {
    response = await fetchLike(PAST_PATH, {
      credentials: "same-origin",
      headers: { accept: "application/json" },
      cache: "no-store",
    });
  } catch {
    return { kind: "unavailable" };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // Arena and this site's Worker answer JSON on every /api/arena path,
    // failures included. Anything else is a server with no Arena behind it.
    return { kind: "absent" };
  }
  if (response.status === 401 || response.status === 403)
    return { kind: "not-a-voter" };
  const battles = (body as { battles?: unknown } | null)?.battles;
  if (!response.ok || !Array.isArray(battles)) return { kind: "unavailable" };
  return {
    kind: "listed",
    ids: battles.map((battle) => String((battle as { id?: unknown }).id)),
  };
}

/** Whether the panel may close now. */
export function gateClosable(state: ArenaGateState): boolean {
  return (
    state.status === "free" ||
    state.status === "closed" ||
    (state.status === "voting" && state.voted >= VOTES_REQUIRED)
  );
}

/**
 * One opening of the gate. `start` reads the baseline; `recount` reads the
 * list again; `noBattle` notes that Arena had no Battle to offer. Once the
 * panel may close, it stays closable.
 */
export function createArenaGate(fetchLike: typeof fetch = fetch) {
  let state: ArenaGateState = { status: "checking" };
  /** The newest voted Battle when the gate opened; null for none. */
  let baseline: string | null = null;

  const settle = (next: ArenaGateState) => {
    if (!gateClosable(state) || state.status === "checking") state = next;
    return state;
  };

  return {
    state: () => state,
    async start(): Promise<ArenaGateState> {
      const read = await readPast(fetchLike);
      if (read.kind === "listed") {
        baseline = read.ids[0] ?? null;
        return settle({ status: "voting", voted: 0 });
      }
      return settle(
        read.kind === "unavailable"
          ? { status: "free", reason: "unavailable" }
          : { status: "closed" },
      );
    },
    async recount(): Promise<ArenaGateState> {
      if (state.status !== "voting" || gateClosable(state)) return state;
      const read = await readPast(fetchLike);
      if (read.kind !== "listed")
        return settle({
          status: "free",
          reason: read.kind === "not-a-voter" ? "signed-out" : "unavailable",
        });
      const seen = baseline === null ? -1 : read.ids.indexOf(baseline);
      const voted = seen === -1 ? read.ids.length : seen;
      // Reads may answer out of order; the count never goes back.
      const counted = state.status === "voting" ? state.voted : 0;
      return settle({
        status: "voting",
        voted: Math.min(Math.max(voted, counted), VOTES_REQUIRED),
      });
    },
    noBattle(): ArenaGateState {
      if (state.status !== "voting") return state;
      return settle({ status: "free", reason: "no-battle" });
    },
  };
}

const VOTE_PATH = /^\/api\/arena\/battles\/[^/]+\/vote$/u;
const NEXT_PATH = "/api/arena/battles/next";
const WATCHED = Symbol("arena-gate-watched");

/** What the gate hears from the framed Arena page. */
export interface ArenaFrameListener {
  /** Arena answered that it has no Battle to offer. */
  noBattle(): void;
  /** Arena recorded a Vote. */
  voted(): void;
}

type WatchedFetch = typeof fetch & { [WATCHED]?: true };

/**
 * Hears the framed page's own Arena answers. The frame is this site's own
 * page, so its `fetch` can be watched: the page keeps every answer as it
 * was, and the gate learns at once when Arena has no Battle (a 404 from
 * POST /api/arena/battles/next, as for a closed Season or every pairing
 * voted) or has recorded a Vote. A page is watched once.
 */
export function watchArenaFrame(
  frame: { fetch: typeof fetch; readonly location: { readonly href: string } },
  listener: ArenaFrameListener,
): void {
  const pageFetch = frame.fetch as WatchedFetch | undefined;
  if (!pageFetch || pageFetch[WATCHED]) return;
  const watched: WatchedFetch = (input, init) => {
    const answer = pageFetch.call(frame, input, init);
    void answer.then(
      (response) => {
        // The frame's Request and URL are its own realm's, so they are
        // told apart by shape, not by instanceof.
        const address =
          typeof input === "object" && "url" in input
            ? input.url
            : String(input);
        const path = new URL(address, frame.location.href).pathname;
        if (path === NEXT_PATH && response.status === 404) listener.noBattle();
        else if (VOTE_PATH.test(path) && response.ok) listener.voted();
      },
      () => undefined,
    );
    return answer;
  };
  watched[WATCHED] = true;
  frame.fetch = watched;
}
