import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import {
  ARENA_GATE_PAGE,
  createArenaGate,
  gateClosable,
  startArenaGate,
  VOTES_REQUIRED,
  type ArenaGate,
  type ArenaGateState,
} from "./arena-gate";
import "./arena-gate.css";

/** How often an open gate reads the count again while the page is seen. */
const RECOUNT_MS = 4000;

/**
 * Asks Arena first, and shows the gate over the page only when there is a
 * panel to show, in a root of its own, so every page that opens it (the
 * editor, the Gallery's shelf, the account page) shows the same panel.
 * While it shows, the rest of the page is inert, so focus and pointer stay
 * in the panel. Nothing of it is kept: a reload ends it.
 */
export async function mountArenaGate({
  shown,
  closed,
}: {
  shown(): void;
  closed(): void;
}): Promise<void> {
  const gate = createArenaGate();
  const showed = await startArenaGate(gate, (state) => {
    const host = document.createElement("div");
    document.body.append(host);
    const focused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const madeInert = [...document.body.children].filter(
      (element) => element !== host && !element.hasAttribute("inert"),
    );
    for (const element of madeInert) element.setAttribute("inert", "");
    const root = createRoot(host);
    let closing = false;
    const close = () => {
      if (closing) return;
      closing = true;
      for (const element of madeInert) element.removeAttribute("inert");
      // Never from inside the root's own render or effects.
      queueMicrotask(() => {
        root.unmount();
        host.remove();
        focused?.focus({ preventScroll: true });
        closed();
      });
    };
    root.render(<ArenaGatePanel gate={gate} first={state} onClose={close} />);
    shown();
  });
  if (!showed) closed();
}

function statusLine(state: ArenaGateState): string {
  if (state.status === "free")
    return {
      "no-battle":
        "Arena has no more battles for you right now, so you can close this.",
      "signed-out":
        "You're no longer signed in to Arena, so you can close this.",
      "ai-account": "AI accounts can't vote in Arena, so you can close this.",
      unavailable: "Arena can't be reached right now, so you can close this.",
    }[state.reason];
  if (state.status !== "voting") return "";
  const left = state.required - state.voted;
  return left > 0
    ? `Your work is safe. Vote on the battle page; Close unlocks after ${votes(state.required)}: ${left} to go.`
    : "Thank you! Your votes are in, so you can close this.";
}

/** "1 new vote", "5 new votes". */
function votes(count: number): string {
  return `${count} new vote${count === 1 ? "" : "s"}`;
}

function ArenaGatePanel({
  gate,
  first,
  onClose,
}: {
  gate: ArenaGate;
  first: ArenaGateState;
  onClose(): void;
}) {
  const [state, setState] = useState(first);
  const [nudged, setNudged] = useState(false);
  const dialogRef = useRef<HTMLElement | null>(null);
  useEffect(() => dialogRef.current?.focus(), []);

  const closable = gateClosable(state);
  /** The Votes this gate asks for: five, or the Battles left if fewer. */
  const required = first.status === "voting" ? first.required : VOTES_REQUIRED;
  const counting = state.status === "voting" && !closable;
  const recount = useCallback(() => {
    void gate.recount().then(setState);
  }, [gate]);
  // Read again every few seconds while the page is seen, and at once when
  // the person comes back from Arena's window.
  useEffect(() => {
    if (!counting) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") recount();
    }, RECOUNT_MS);
    const returned = () => {
      if (document.visibilityState === "visible") recount();
    };
    window.addEventListener("focus", returned);
    document.addEventListener("visibilitychange", returned);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", returned);
      document.removeEventListener("visibilitychange", returned);
    };
  }, [counting, recount]);
  // Escape, wherever focus is, is the gate's: it waits while locked and
  // closes once the gate may close. No page under it sees the key.
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (closable) onClose();
      else setNudged(true);
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [closable, onClose]);

  const tryClose = () => {
    if (closable) onClose();
    else setNudged(true);
  };
  return (
    <div
      className="arena-gate-backdrop"
      // Focus stays in the panel: a press outside it moves nothing.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) event.preventDefault();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && closable) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="arena-gate"
        role="dialog"
        aria-modal="true"
        aria-labelledby="arena-gate-title"
        aria-describedby="arena-gate-status"
        tabIndex={-1}
        data-testid="arena-gate"
      >
        <h2 id="arena-gate-title">
          {`Vote in ${required} Schematic Arena battle${required === 1 ? "" : "s"} to continue`}
        </h2>
        {state.status === "voting" ? (
          <p className="arena-gate-count" data-testid="arena-gate-count">
            Voted {state.voted} / {state.required}
          </p>
        ) : null}
        <p
          id="arena-gate-status"
          className="arena-gate-status"
          data-nudged={nudged && !closable ? "" : undefined}
          aria-live="polite"
        >
          {statusLine(state)}
        </p>
        <div className="arena-gate-actions">
          {state.status === "voting" ? (
            // A link opened by the person's own click: a new tab or window
            // that no popup blocker stops, on chip-arena.com signed in.
            <a
              className="arena-gate-open"
              href={ARENA_GATE_PAGE}
              target="_blank"
              rel="noopener"
            >
              Open the battle page
            </a>
          ) : null}
          <button
            type="button"
            className="arena-gate-close"
            aria-disabled={!closable}
            title={
              closable ? "Close" : `Close unlocks after ${votes(required)}`
            }
            onClick={tryClose}
          >
            Close
          </button>
        </div>
      </section>
    </div>
  );
}
