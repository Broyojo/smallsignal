// The Arena gate's way in (#1681). The pages that open it hold only this:
// the panel, its count and its styles load when a gate opens, so no page's
// first load grows. One gate at a time; a request while one is open, or
// still deciding whether to show, changes nothing.

let gateOpen = false;

/** Opens the Arena gate over whatever page is showing. */
function requestArenaGate(): void {
  if (gateOpen || typeof document === "undefined") return;
  gateOpen = true;
  void import("./arena-gate-panel")
    .then((panel) =>
      panel.mountArenaGate(() => {
        gateOpen = false;
      }),
    )
    // A gate that cannot load never stands in anyone's way.
    .catch(() => {
      gateOpen = false;
    });
}

/**
 * A manual Cloud Save's outcome, after which the gate opens if the save
 * completed. The save itself never waits for the gate.
 */
export function gateAfterManualCloudSave<Outcome extends { status: string }>(
  outcome: Outcome,
  openGate: () => void = requestArenaGate,
): Outcome {
  if (outcome.status === "saved") openGate();
  return outcome;
}

/**
 * The Cloud shelf has opened: the editor's Shelf menu, the Gallery's My
 * shelf or the account page's Cloud Projects. Every opening opens the gate.
 */
export function cloudShelfOpened(): void {
  requestArenaGate();
}
