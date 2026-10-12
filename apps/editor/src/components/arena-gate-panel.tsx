import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import {
  ARENA_GATE_PAGE,
  createArenaGate,
  gateClosable,
  VOTES_REQUIRED,
  type ArenaGateState,
} from "./arena-gate";
import "./arena-gate.css";

/** How often an open gate reads the count again while the page is seen. */
const RECOUNT_MS = 4000;

/**
 * Shows the gate over the page in a root of its own, so every page that
 * opens it (the editor, the Gallery's shelf, the account page) shows the
 * same panel. While it shows, the rest of the page is inert, so focus and
 * pointer stay in the panel. Nothing of it is kept: a reload ends it.
 */
export function mountArenaGate(onClosed: () => void): void {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const focused =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  let madeInert: Element[] = [];
  const shown = () => {
    madeInert = [...document.body.children].filter(
      (element) => element !== host && !element.hasAttribute("inert"),
    );
    for (const element of madeInert) element.setAttribute("inert", "");
  };
  const close = () => {
    for (const element of madeInert) element.removeAttribute("inert");
    root.unmount();
    host.remove();
    focused?.focus({ preventScroll: true });
    onClosed();
  };
  root.render(<ArenaGatePanel onShown={shown} onClose={close} />);
}

function statusLine(state: ArenaGateState): string {
  if (state.status === "free")
    return state.reason === "no-battle"
      ? "Arena has no battle to offer right now, so you can close this."
      : state.reason === "signed-out"
        ? "You're no longer signed in to Arena, so you can close this."
        : "Arena can't be reached right now, so you can close this.";
  if (state.status !== "voting") return "";
  const left = VOTES_REQUIRED - state.voted;
  return left > 0
    ? `Your work is safe. Vote on the battle page; Close unlocks after ${VOTES_REQUIRED} new votes: ${left} to go.`
    : "Thank you! Your votes are in, so you can close this.";
}

function ArenaGatePanel({
  onShown,
  onClose,
}: {
  onShown(): void;
  onClose(): void;
}) {
  const [gate] = useState(() => createArenaGate());
  const [state, setState] = useState<ArenaGateState>(gate.state);
  const [nudged, setNudged] = useState(false);
  const dialogRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let live = true;
    void gate.start().then((next) => {
      if (live) setState(next);
    });
    return () => {
      live = false;
    };
  }, [gate]);

  const status = state.status;
  const showing = status !== "checking" && status !== "closed";
  useEffect(() => {
    if (status === "closed") onClose();
  }, [status, onClose]);
  useEffect(() => {
    if (!showing) return;
    onShown();
    dialogRef.current?.focus();
  }, [showing, onShown]);

  const closable = gateClosable(state);
  const counting = status === "voting" && !closable;
  const recount = useCallback(
    (season = false) => {
      void gate.recount({ season }).then(setState);
    },
    [gate],
  );
  // Read again every few seconds while the page is seen, and at once, with
  // whether a Season still serves Battles, when the person comes back from
  // Arena's window.
  useEffect(() => {
    if (!counting) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") recount();
    }, RECOUNT_MS);
    const returned = () => {
      if (document.visibilityState === "visible") recount(true);
    };
    window.addEventListener("focus", returned);
    document.addEventListener("visibilitychange", returned);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", returned);
      document.removeEventListener("visibilitychange", returned);
    };
  }, [counting, recount]);
  // Once it may close, Escape closes it wherever focus is.
  useEffect(() => {
    if (!showing || !closable) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [showing, closable, onClose]);

  if (!showing) return null;
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
        onKeyDown={(event) => {
          // Locked, Escape stays; unlocked, the window's listener closes.
          if (event.key === "Escape" && !closable) {
            event.preventDefault();
            setNudged(true);
          }
        }}
      >
        <h2 id="arena-gate-title">
          Vote in {VOTES_REQUIRED} Schematic Arena battles to continue
        </h2>
        {state.status === "voting" ? (
          <p className="arena-gate-count" data-testid="arena-gate-count">
            Voted {state.voted} / {VOTES_REQUIRED}
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
              closable
                ? "Close"
                : `Close unlocks after ${VOTES_REQUIRED} new votes`
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
