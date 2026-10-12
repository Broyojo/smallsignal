import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import {
  ARENA_GATE_PAGE,
  createArenaGate,
  gateClosable,
  VOTES_REQUIRED,
  watchArenaFrame,
  type ArenaGateState,
} from "./arena-gate";
import "./arena-gate.css";

/** How often an open gate reads the count again between Arena's answers. */
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
      ? "Arena has no battle for you right now, so you can close this."
      : state.reason === "signed-out"
        ? "You're no longer signed in to Arena, so you can close this."
        : "Arena can't be reached right now, so you can close this.";
  if (state.status !== "voting") return "";
  const left = VOTES_REQUIRED - state.voted;
  return left > 0
    ? `Your work is safe. Close unlocks after ${VOTES_REQUIRED} new votes: ${left} to go.`
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

  const recount = useCallback(() => {
    void gate.recount().then(setState);
  }, [gate]);
  const closable = gateClosable(state);
  const counting = status === "voting" && !closable;
  useEffect(() => {
    if (!counting) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") recount();
    }, RECOUNT_MS);
    return () => clearInterval(timer);
  }, [counting, recount]);

  const watchFrame = useCallback(
    (frame: HTMLIFrameElement | null) => {
      const page = frame?.contentWindow;
      if (!page) return;
      try {
        watchArenaFrame(page, {
          noBattle: () => setState(gate.noBattle()),
          voted: recount,
        });
      } catch {
        // A page that cannot be watched is still counted by the timer.
      }
    },
    [gate, recount],
  );

  if (!showing) return null;
  const tryClose = () => {
    if (closable) onClose();
    else setNudged(true);
  };
  const showFrame =
    status === "voting" || (status === "free" && state.reason === "no-battle");
  return (
    <div
      className="arena-gate-backdrop"
      // Focus stays in the panel: a press outside it moves nothing.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) event.preventDefault();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) tryClose();
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
          if (event.key !== "Escape") return;
          event.preventDefault();
          tryClose();
        }}
      >
        <header className="arena-gate-header">
          <div>
            <h2 id="arena-gate-title">Vote in the Schematic Arena</h2>
            <p
              id="arena-gate-status"
              className="arena-gate-status"
              data-nudged={nudged && !closable ? "" : undefined}
              aria-live="polite"
            >
              {statusLine(state)}
            </p>
          </div>
          {state.status === "voting" ? (
            <span className="arena-gate-count" data-testid="arena-gate-count">
              Voted {state.voted} / {VOTES_REQUIRED}
            </span>
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
        </header>
        {showFrame ? (
          <iframe
            ref={watchFrame}
            className="arena-gate-frame"
            title="Schematic Arena battle"
            src={ARENA_GATE_PAGE}
            // Each page the frame loads is watched afresh and recounted.
            onLoad={(event) => {
              watchFrame(event.currentTarget);
              recount();
            }}
          />
        ) : null}
      </section>
    </div>
  );
}
