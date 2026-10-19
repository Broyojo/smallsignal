// Where the operating-point labels go on the drawing: each tries its
// places in turn and takes the first that covers no label already placed
// (nor a badge); a label with no free place is left off, never stacked.

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface LabelRequest {
  id: string;
  width: number;
  height: number;
  /** Top-left corners to try, best first. */
  places: readonly { left: number; top: number }[];
}

/** Space kept between two labels. */
const GAP = 2;

function overlaps(a: Box, b: Box): boolean {
  return (
    a.left < b.left + b.width + GAP &&
    b.left < a.left + a.width + GAP &&
    a.top < b.top + b.height + GAP &&
    b.top < a.top + a.height + GAP
  );
}

/**
 * Places labels in the order given (most important first) around fixed
 * obstacles; returns each placed label's box by id.
 */
export function placeLabels(
  requests: readonly LabelRequest[],
  obstacles: readonly Box[] = [],
): Map<string, Box> {
  const taken: Box[] = [...obstacles];
  const placed = new Map<string, Box>();
  for (const request of requests) {
    for (const place of request.places) {
      const box = { ...place, width: request.width, height: request.height };
      if (taken.some((other) => overlaps(box, other))) continue;
      taken.push(box);
      placed.set(request.id, box);
      break;
    }
  }
  return placed;
}

/** A part's region label: beside it to the right, else left, below, above. */
export function devicePlaces(
  part: { left: number; top: number; right: number; bottom: number },
  size: { width: number; height: number },
): { left: number; top: number }[] {
  return [
    { left: part.right + 3, top: part.bottom - size.height },
    { left: part.left - 3 - size.width, top: part.bottom - size.height },
    { left: part.right - size.width, top: part.bottom + 3 },
    { left: part.left, top: part.top - 3 - size.height },
  ];
}

/** A node's voltage on a wire point: under it (beside a vertical one),
 * else above (or on its other side). */
export function wirePlaces(
  at: { x: number; y: number; vertical: boolean },
  size: { width: number; height: number },
): { left: number; top: number }[] {
  return at.vertical
    ? [
        { left: at.x + 4, top: at.y - size.height / 2 },
        { left: at.x - 4 - size.width, top: at.y - size.height / 2 },
      ]
    : [
        { left: at.x - size.width / 2, top: at.y + 3 },
        { left: at.x - size.width / 2, top: at.y - 3 - size.height },
      ];
}
