// The Project set the Season tool draws itself (#1560): the Check Battle copy
// of the Human Reference. It is drawn through the editor's own Agent host, as
// an Agent would draw it, so it is an ordinary Project in every respect.
import {
  createLocalEditor,
  exportNetlist,
  gradeNetlists,
  seededRandom,
  withSeededIds,
} from "./editor.mjs";

function transact(editor, actions, tag) {
  const document = editor.controller.document;
  const answer = editor.circuit({
    apiVersion: "3.0",
    requestId: tag,
    operation: "transact",
    documentId: document.id,
    transactionId: tag,
    expectedRevision: document.revision,
    dryRun: false,
    actions,
  });
  return answer.ok ? null : (answer.error?.message ?? "refused");
}

/** Places a Check copy tries for one part before leaving it where it is. */
const SCRAMBLE_ATTEMPTS = 4;

/**
 * The Check Battle copy of a Human Reference: the same drawing with its
 * parts scattered by a generator seeded from `seed`. Each part, in drawing
 * order, is offered a shuffled partner's place, then random places over an
 * area half again as large as the drawing, all on its grid. The editor
 * moves it with its wires following, and a place is kept only when the
 * editor accepts it and the netlist stays equivalent to the Task's under
 * the #1524 rules; a part no place suits stays where it was. Returns the
 * Project and how many parts moved.
 *
 * @param {string} seed
 * @param {import("@icm/model").CircuitProject} reference
 * @param {string} taskNetlist
 */
export function drawCheckCopy(seed, reference, taskNetlist) {
  return withSeededIds(`check-copy:${seed}`, async () => {
    let editor = createLocalEditor({ project: reference });
    const document = editor.controller.document;
    const grid = document.presentation?.grid ?? 10;
    const parts = document.instances
      .filter((instance) => instance.placement)
      .map((instance) => ({
        id: instance.id,
        position: instance.placement.position,
      }));
    const random = seededRandom(`check-copy:${seed}`);
    const order = parts.map((_, index) => index);
    for (let index = order.length - 1; index > 0; index -= 1) {
      const other = Math.floor(random() * (index + 1));
      [order[index], order[other]] = [order[other], order[index]];
    }
    const xs = parts.map((part) => part.position.x);
    const ys = parts.map((part) => part.position.y);
    const span = (values) =>
      Math.max(Math.max(...values) - Math.min(...values), 20 * grid);
    const [width, height] = [span(xs), span(ys)];
    const snap = (value) => Math.round(value / grid) * grid;
    const scatter = () => ({
      x: snap(Math.min(...xs) - width / 4 + random() * width * 1.5),
      y: snap(Math.min(...ys) - height / 4 + random() * height * 1.5),
    });
    let moved = 0;
    for (const [index, part] of parts.entries()) {
      const places = [parts[order[index]].position];
      while (places.length < SCRAMBLE_ATTEMPTS) places.push(scatter());
      for (const [attempt, place] of places.entries()) {
        if (place.x === part.position.x && place.y === part.position.y)
          continue;
        const before = editor.project;
        const refused = transact(
          editor,
          [
            {
              kind: "move",
              target: { kind: "instance", id: part.id },
              position: { x: place.x, y: place.y },
            },
          ],
          `scramble-${index}-${attempt}`,
        );
        if (refused) continue;
        const netlist = exportNetlist(editor.project).text;
        const same =
          netlist !== null &&
          (await gradeNetlists(netlist, taskNetlist, { sourcePolarity: true }))
            .exact;
        if (same) {
          moved += 1;
          break;
        }
        editor = createLocalEditor({ project: before });
      }
    }
    return { project: editor.project, moved, parts: parts.length };
  });
}
