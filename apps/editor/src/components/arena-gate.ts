// The Arena gate's count (#1681): after a manual Cloud Save and on every
// opening of the Cloud shelf, Analog Canvas asks for five Schematic Arena
// Votes before its panel closes. The person votes in Arena's own window,
// on chip-arena.com; this side only counts. Arena lists a Voter's voted
// Battles newest first with the time each Vote was cast
// (GET /api/arena/battles/past, which this site's Worker forwards with the
// signed-in account), so every Vote cast since the gate opened, by Arena's
// own clock, counts.
//
// The gate never traps anyone: when Arena fails as it opens, keeps failing
// while counting, or serves no Season, the panel may close at once. Someone
// Arena will not count (signed out, or an AI account, which may not vote)
// never sees it, and neither does anyone on a server with no Arena behind it.

/**
 * The Schematic Arena's battle page as the gate opens it. On Analog Canvas's
 * host /schematic hands the visitor on to chip-arena.com, signed in as here,
 * with the query kept; `from=canvas-gate` makes Arena record each Vote cast
 * there with the source `canvas-gate` (docs/specs/analog-arena.md#vote-source).
 */
export const ARENA_GATE_PAGE = "/schematic?from=canvas-gate";

/** The Votes a gate asks for. */
export const VOTES_REQUIRED = 5;

/** Failed reads in a row, while counting, after which the panel unlocks. */
export const FAILURES_ALLOWED = 3;

const PAST_PATH = "/api/arena/battles/past";
const LEADERBOARD_PATH = "/api/arena/leaderboard";

/** Why the panel may close before the Votes are in. */
export type ArenaGateFreeReason = "unavailable" | "no-battle" | "signed-out";

export type ArenaGateState =
  | { status: "checking" }
  /** Nothing to show: no Arena here, or nobody Arena would count. */
  | { status: "closed" }
  | { status: "voting"; voted: number }
  | { status: "free"; reason: ArenaGateFreeReason };

type PastRead =
  /** Arena's clock as it answered, and when each listed Vote was cast. */
  | { kind: "listed"; at: number | null; castAt: number[] }
  /** A Voter who must agree to the Consent first, in Arena's window. */
  | { kind: "consent"; at: number | null }
  | { kind: "not-a-voter" }
  | { kind: "unavailable" }
  | { kind: "absent" };

const READ = {
  credentials: "same-origin",
  headers: { accept: "application/json" },
  cache: "no-store",
} as const;

async function readPast(fetchLike: typeof fetch): Promise<PastRead> {
  let response: Response;
  try {
    response = await fetchLike(PAST_PATH, READ);
  } catch {
    return { kind: "unavailable" };
  }
  let body: { battles?: unknown; error?: unknown } | null;
  try {
    body = await response.json();
  } catch {
    // Arena and this site's Worker answer JSON on every /api/arena path,
    // failures included. Anything else is a server with no Arena behind it.
    return { kind: "absent" };
  }
  const date = Date.parse(response.headers.get("date") ?? "");
  const at = Number.isNaN(date) ? null : date;
  if (response.status === 403 && body?.error === "consent-required")
    return { kind: "consent", at };
  if (response.status === 401 || response.status === 403)
    return { kind: "not-a-voter" };
  if (!response.ok || !Array.isArray(body?.battles))
    return { kind: "unavailable" };
  return {
    kind: "listed",
    at,
    castAt: body.battles.map((battle) =>
      Date.parse(String((battle as { castAt?: unknown }).castAt)),
    ),
  };
}

/**
 * Whether a Season serves Battles: the leaderboard's `season` is null while
 * none does. A read, never an assignment; when it cannot say, it says yes,
 * and the count's own failures decide.
 */
async function seasonOpen(fetchLike: typeof fetch): Promise<boolean> {
  try {
    const response = await fetchLike(LEADERBOARD_PATH, READ);
    if (!response.ok) return true;
    return (await response.json())?.season !== null;
  } catch {
    return true;
  }
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
 * One opening of the gate. `start` reads when it opened; `recount` reads
 * the count again, and with `season` also whether a Season still serves
 * Battles. Once the panel may close, it stays closable.
 */
export function createArenaGate(
  fetchLike: typeof fetch = fetch,
  now: () => number = Date.now,
) {
  let state: ArenaGateState = { status: "checking" };
  /** When the gate opened, by Arena's clock where it said. */
  let since = 0;
  let failures = 0;

  const settle = (next: ArenaGateState) => {
    if (state.status === "checking" || !gateClosable(state)) state = next;
    return state;
  };
  const counted = (read: PastRead & { kind: "listed" | "consent" }) => {
    const voted =
      read.kind === "listed"
        ? read.castAt.filter((time) => time >= since).length
        : 0;
    const before = state.status === "voting" ? state.voted : 0;
    return Math.min(Math.max(voted, before), VOTES_REQUIRED);
  };

  return {
    state: () => state,
    async start(): Promise<ArenaGateState> {
      const [read, open] = await Promise.all([
        readPast(fetchLike),
        seasonOpen(fetchLike),
      ]);
      if (read.kind === "unavailable")
        return settle({ status: "free", reason: "unavailable" });
      if (read.kind !== "listed" && read.kind !== "consent")
        return settle({ status: "closed" });
      if (!open) return settle({ status: "free", reason: "no-battle" });
      // Arena's Date answer is to the second: a Vote cast in the second the
      // gate opened counts.
      since = read.at ?? now();
      return settle({ status: "voting", voted: counted(read) });
    },
    async recount({
      season = false,
    }: { season?: boolean } = {}): Promise<ArenaGateState> {
      if (state.status !== "voting" || gateClosable(state)) return state;
      const [read, open] = await Promise.all([
        readPast(fetchLike),
        season ? seasonOpen(fetchLike) : true,
      ]);
      if (read.kind === "not-a-voter")
        return settle({ status: "free", reason: "signed-out" });
      if (read.kind === "unavailable" || read.kind === "absent") {
        failures += 1;
        return failures >= FAILURES_ALLOWED
          ? settle({ status: "free", reason: "unavailable" })
          : state;
      }
      failures = 0;
      const next = settle({ status: "voting", voted: counted(read) });
      if (!open && !gateClosable(next))
        return settle({ status: "free", reason: "no-battle" });
      return next;
    },
  };
}
