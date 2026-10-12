// The Arena gate's way in (#1681). The pages that open it hold only this:
// the panel, its count and its styles load when a gate opens, so no page's
// first load grows. One gate at a time; a request while one is open, or
// still deciding whether to show, changes nothing.

let gate: "idle" | "deciding" | "shown" = "idle";

/**
 * Opens the Arena gate over whatever page is showing, after a Cloud Save or
 * as the Cloud shelf opens.
 */
function requestArenaGate(after: "save" | "shelf"): void {
  if (gate !== "idle" || typeof document === "undefined") return;
  gate = "deciding";
  void import("./arena-gate-panel")
    .then((panel) =>
      panel.mountArenaGate({
        saved: after === "save",
        shown: () => {
          gate = "shown";
        },
        closed: () => {
          gate = "idle";
        },
      }),
    )
    // A gate that cannot load never stands in anyone's way.
    .catch(() => {
      gate = "idle";
    });
}

/**
 * Whether the gate's panel is over the page. The page under it takes no
 * keys meanwhile, wherever focus is.
 */
export function arenaGateShown(): boolean {
  return gate === "shown";
}

/**
 * A manual Cloud Save's outcome, after which the gate opens if the save
 * completed. The save itself never waits for the gate.
 */
export function gateAfterManualCloudSave<Outcome extends { status: string }>(
  outcome: Outcome,
  openGate: () => void = () => requestArenaGate("save"),
): Outcome {
  if (outcome.status === "saved") openGate();
  return outcome;
}

/**
 * The person opened the Cloud shelf: the editor's Shelf menu, the Gallery's
 * My shelf tab or the account page's Cloud Projects tab. Every such opening
 * opens the gate. A page that loads on the shelf, as on a reload, does not
 * call this, so a reload always ends a gate.
 */
export function cloudShelfOpened(): void {
  requestArenaGate("shelf");
}
