// Where the panel's data goes on the drawing: one placement for every
// label (node voltages, regions) around fixed marks (assumption badges,
// the drawing's own text, its parts). Each label tries its places in turn
// and takes the first that covers nothing already there: first touching
// what it describes (on its wire, against its part), then a little away
// with a leader line to it. A label with no free place is left off, never
// stacked or set adrift.

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** A label's top-left corner; `leader` when it sits away from its target
 * and draws a line to it; `target` when it is the request's own spot (a
 * point on one of its net's wires). */
export interface Place {
  left: number;
  top: number;
  leader?: true;
  target?: Box;
}

export interface LabelRequest {
  id: string;
  width: number;
  height: number;
  /** What it describes, on screen: a part's box (a place may name a
   * point on a wire instead). */
  target?: Box;
  /** Places to try, best first. */
  places: readonly Place[];
  /** The obstacle it describes (its own part), which it may touch. */
  own?: string;
}

/** A fixed mark labels keep off; `id` names a part. */
export interface Obstacle extends Box {
  id?: string;
}

export interface PlacedLabel extends Box {
  target: Box;
  leader: boolean;
}

/** Space kept between two labels, or a label and a mark. */
const GAP = 2;
/** How far a leader takes a label from its target. */
const LEADER = 14;
/** A wire label's distance from its segment's ends (a junction, a pin). */
const WIRE_END = 6;

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
 * obstacles; returns each placed label by id.
 */
export function placeLabels(
  requests: readonly LabelRequest[],
  obstacles: readonly Obstacle[] = [],
): Map<string, PlacedLabel> {
  const taken: Obstacle[] = [...obstacles];
  const placed = new Map<string, PlacedLabel>();
  for (const request of requests) {
    for (const place of request.places) {
      const box = {
        left: place.left,
        top: place.top,
        width: request.width,
        height: request.height,
      };
      if (
        taken.some(
          (other) =>
            (request.own === undefined || other.id !== request.own) &&
            overlaps(box, other),
        )
      )
        continue;
      taken.push(box);
      placed.set(request.id, {
        ...box,
        target: place.target ??
          request.target ?? { ...box, width: 0, height: 0 },
        leader: place.leader === true,
      });
      break;
    }
  }
  return placed;
}

/**
 * A part's label: against its box (right, left, below, above; each side's
 * lower corner first, where a MOSFET's source and a region read), else a
 * leader's length out to its right or left, below or above.
 */
export function devicePlaces(
  part: { left: number; top: number; right: number; bottom: number },
  size: { width: number; height: number },
): Place[] {
  const { width, height } = size;
  const middle = (part.top + part.bottom - height) / 2;
  const centre = (part.left + part.right - width) / 2;
  const right = part.right + GAP;
  const left = part.left - GAP - width;
  return [
    { left: right, top: part.bottom - height },
    { left: right, top: part.top },
    { left, top: part.bottom - height },
    { left, top: part.top },
    { left: centre, top: part.bottom + GAP },
    { left: centre, top: part.top - GAP - height },
    { left: right + LEADER, top: middle, leader: true },
    { left: left - LEADER, top: middle, leader: true },
    { left: centre, top: part.bottom + GAP + LEADER, leader: true },
    { left: centre, top: part.top - GAP - LEADER - height, leader: true },
  ];
}

/**
 * A node's voltage on one wire segment (screen points): `on` the wire,
 * centred on it, from the middle outward and clear of the ends; `off` it
 * by a leader's length on either side. A net tries every segment's `on`
 * places before any `off` one.
 */
export function wirePlaces(
  a: Point,
  b: Point,
  size: { width: number; height: number },
): { on: Place[]; off: Place[] } {
  const { width, height } = size;
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (length === 0) return { on: [], off: [] };
  const ux = (b.x - a.x) / length;
  const uy = (b.y - a.y) / length;
  // Half the label's extent along the wire.
  const half = Math.abs(ux) * (width / 2) + Math.abs(uy) * (height / 2);
  const spot = (t: number): Box => ({
    left: a.x + ux * t,
    top: a.y + uy * t,
    width: 0,
    height: 0,
  });
  const on: Place[] = [];
  for (const share of [0.5, 0.35, 0.65, 0.2, 0.8]) {
    const t = share * length;
    if (t - half < WIRE_END || length - t - half < WIRE_END) continue;
    const target = spot(t);
    on.push({
      left: target.left - width / 2,
      top: target.top - height / 2,
      target,
    });
  }
  // Off the wire: across it by a leader, the label's near edge that far.
  const nx = -uy;
  const ny = ux;
  const across = Math.abs(nx) * (width / 2) + Math.abs(ny) * (height / 2);
  const target = spot(length / 2);
  const off: Place[] = [1, -1].map((side) => ({
    left: target.left + nx * side * (across + LEADER) - width / 2,
    top: target.top + ny * side * (across + LEADER) - height / 2,
    leader: true,
    target,
  }));
  return { on, off };
}

/** The leader from a label to its target: between their nearest points. */
export function leaderLine(label: Box, target: Box): [Point, Point] {
  const clamp = (value: number, low: number, high: number) =>
    Math.max(low, Math.min(high, value));
  const centre = {
    x: label.left + label.width / 2,
    y: label.top + label.height / 2,
  };
  const end = {
    x: clamp(centre.x, target.left, target.left + target.width),
    y: clamp(centre.y, target.top, target.top + target.height),
  };
  const start = {
    x: clamp(end.x, label.left, label.left + label.width),
    y: clamp(end.y, label.top, label.top + label.height),
  };
  return [start, end];
}
