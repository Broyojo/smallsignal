// The Arena gate's count (#1681): after a manual Cloud Save and whenever the
// person opens the Cloud shelf, Analog Canvas asks for five Schematic Arena
// Votes before its panel closes. The person votes in Arena's own window,
// on chip-arena.com; this side only counts. Arena lists a Voter's voted
// Battles newest first with the time each Vote was cast
// (GET /api/arena/battles/past, which this site's Worker forwards with the
// signed-in account). A Vote counts when its Battle was not listed as the
// gate opened and it was cast since then, by Arena's own clock.
//
// The gate never traps anyone: when Arena fails as it opens, keeps failing
// while counting, or has no Season serving Battles, the panel may close at
// once. Someone Arena will not count (signed out, or an AI account, which may
// not vote) never sees it, and neither does anyone on a server with no Arena
// behind it.

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
const EXAMPLE_PATH = "/api/arena/example";

/** Why the panel may close before the Votes are in. */
export type ArenaGateFreeReason =
  "unavailable" | "no-battle" | "signed-out" | "ai-account";

export type ArenaGateState =
  | { status: "checking" }
  /** Nothing to show: no Arena here, or nobody Arena would count. */
  | { status: "closed" }
  | { status: "voting"; voted: number }
  | { status: "free"; reason: ArenaGateFreeReason };

type VotedBattle = { id: string; castAt: number };

type PastRead =
  /** Arena's clock as it answered, where it said, and the voted Battles. */
  | { kind: "listed"; at: number | null; battles: VotedBattle[] }
  /** A Voter who must agree to the Consent first, in Arena's window. */
  | { kind: "consent"; at: number | null }
  | { kind: "signed-out" }
  | { kind: "ai-account" }
  | { kind: "unavailable" }
  | { kind: "absent" };

const READ_OPTIONS = {
  credentials: "same-origin",
  headers: { accept: "application/json" },
  cache: "no-store",
} as const;

async function readPast(fetchLike: typeof fetch): Promise<PastRead> {
  let response: Response;
  try {
    response = await fetchLike(PAST_PATH, READ_OPTIONS);
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
  if (response.status === 401) return { kind: "signed-out" };
  if (response.status === 403)
    return body?.error === "consent-required"
      ? { kind: "consent", at }
      : { kind: "ai-account" };
  if (!response.ok || !Array.isArray(body?.battles))
    return { kind: "unavailable" };
  return {
    kind: "listed",
    at,
    battles: body.battles.map((battle) => {
      const { id, castAt } = battle as { id?: unknown; castAt?: unknown };
      return { id: String(id), castAt: Date.parse(String(castAt)) };
    }),
  };
}

/**
 * Whether a Season serves Battles: Arena's example Battle, read-only and
 * open to anyone, is null exactly when none does (a Season over or frozen
 * with no next one). When it cannot say, it says yes, and the count's own
 * failures decide.
 */
async function battleOffered(fetchLike: typeof fetch): Promise<boolean> {
  try {
    const response = await fetchLike(EXAMPLE_PATH, READ_OPTIONS);
    if (!response.ok) return true;
    return (await response.json())?.example !== null;
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
 * One opening of the gate. `start` notes what Arena listed as it opened;
 * `recount` reads the count again, and with `season` also whether a Season
 * still serves Battles. A recount asked while one is reading joins it. Once
 * the panel may close, it stays closable.
 */
export function createArenaGate(fetchLike: typeof fetch = fetch) {
  let state: ArenaGateState = { status: "checking" };
  /** The Battles listed as the gate opened; none of them counts. */
  let seen = new Set<string>();
  /** When the gate opened, by Arena's clock; null where it did not say. */
  let since: number | null = null;
  let failures = 0;
  let reading: Promise<ArenaGateState> | null = null;

  const settle = (next: ArenaGateState) => {
    if (state.status === "checking" || !gateClosable(state)) state = next;
    return state;
  };
  const counted = (read: PastRead & { kind: "listed" | "consent" }) => {
    const voted =
      read.kind === "listed"
        ? read.battles.filter(
            (battle) =>
              !seen.has(battle.id) &&
              (since === null || battle.castAt >= since),
          ).length
        : 0;
    const before = state.status === "voting" ? state.voted : 0;
    return Math.min(Math.max(voted, before), VOTES_REQUIRED);
  };

  async function readAgain(season: boolean): Promise<ArenaGateState> {
    const [read, offered] = await Promise.all([
      readPast(fetchLike),
      season ? battleOffered(fetchLike) : true,
    ]);
    if (read.kind === "signed-out" || read.kind === "ai-account")
      return settle({ status: "free", reason: read.kind });
    if (read.kind === "unavailable" || read.kind === "absent") {
      failures += 1;
      return failures >= FAILURES_ALLOWED
        ? settle({ status: "free", reason: "unavailable" })
        : state;
    }
    failures = 0;
    const next = settle({ status: "voting", voted: counted(read) });
    if (!offered && !gateClosable(next))
      return settle({ status: "free", reason: "no-battle" });
    return next;
  }

  return {
    state: () => state,
    async start(): Promise<ArenaGateState> {
      const [read, offered] = await Promise.all([
        readPast(fetchLike),
        battleOffered(fetchLike),
      ]);
      if (read.kind === "unavailable")
        return settle({ status: "free", reason: "unavailable" });
      if (read.kind !== "listed" && read.kind !== "consent")
        return settle({ status: "closed" });
      if (!offered) return settle({ status: "free", reason: "no-battle" });
      since = read.at;
      if (read.kind === "listed")
        seen = new Set(read.battles.map((battle) => battle.id));
      return settle({ status: "voting", voted: 0 });
    },
    recount({ season = false }: { season?: boolean } = {}) {
      if (state.status !== "voting" || gateClosable(state))
        return Promise.resolve(state);
      reading ??= readAgain(season).finally(() => {
        reading = null;
      });
      return reading;
    },
  };
}

export type ArenaGate = ReturnType<typeof createArenaGate>;

/**
 * Starts `gate` and shows its panel only when there is one to show: nothing
 * of the panel exists, and focus stays where it was, for someone who never
 * sees it. True when it showed.
 */
export async function startArenaGate(
  gate: ArenaGate,
  show: (state: ArenaGateState) => void,
): Promise<boolean> {
  const state = await gate.start();
  if (state.status === "closed" || state.status === "checking") return false;
  show(state);
  return true;
}
