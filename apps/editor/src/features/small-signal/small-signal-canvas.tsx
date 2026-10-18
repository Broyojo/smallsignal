import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { instanceHit, type CanvasBadge } from "./small-signal-device-menu";
import type { LinkStore } from "./small-signal-link";

// Everything the panel draws on the canvas, in one layer that follows pans
// and zooms: a badge on each part with assumptions, the operating point
// (node voltages on wires, each transistor's region), and the
// ring around a part whose symbol is hovered in a formula.

/** A node's DC voltage, shown on the longest wire segment of its net. */
export interface OpNetLabel {
  node: string;
  text: string;
  /** Route ids of the net's wires in the open Cell. */
  routes: readonly string[];
}

/** A transistor's region, beside it. */
export interface OpDeviceLabel {
  instanceId: string;
  element: string;
  /** "sat", "triode", "off", "active". */
  region: string;
  /** Region class: saturation, triode, cutoff, active. */
  tone: string;
}

interface Geometry {
  rects: ReadonlyMap<string, DOMRect>;
  /** A point on each net's longest visible wire segment, on screen. */
  wires: ReadonlyMap<string, { x: number; y: number; vertical: boolean }>;
  container: { element: HTMLElement; rect: DOMRect } | null;
}

const EMPTY: Geometry = { rects: new Map(), wires: new Map(), container: null };

/** Zoomed out past these, a label would only cover the drawing. */
const MIN_WIRE_PX = 28;
const MIN_PART_PX = 10;

/** A route's hit polyline on the canvas, by route id. */
function routeHit(id: string): SVGPolylineElement | null {
  return document.querySelector<SVGPolylineElement>(
    `[data-testid="schematic-canvas"] [data-canvas-hit-kind="route"][data-canvas-hit-id="${CSS.escape(id)}"]`,
  );
}

function longestSegment(
  routes: readonly string[],
  view: DOMRect,
): { x: number; y: number; vertical: boolean } | null {
  let best: { x: number; y: number; vertical: boolean; length: number } | null =
    null;
  for (const id of routes) {
    const line = routeHit(id);
    const ctm = line?.getScreenCTM();
    if (!line || !ctm) continue;
    const points = line.points;
    for (let i = 1; i < points.numberOfItems; i += 1) {
      const a = new DOMPoint(
        points.getItem(i - 1).x,
        points.getItem(i - 1).y,
      ).matrixTransform(ctm);
      const b = new DOMPoint(
        points.getItem(i).x,
        points.getItem(i).y,
      ).matrixTransform(ctm);
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      // A third of the way along: a net's name label usually sits at the
      // middle of its wire.
      const x = a.x + (b.x - a.x) / 3;
      const y = a.y + (b.y - a.y) / 3;
      const inside =
        x > view.left && x < view.right && y > view.top && y < view.bottom;
      if (inside && (!best || length > best.length))
        best = {
          x,
          y,
          vertical: Math.abs(b.y - a.y) > Math.abs(b.x - a.x),
          length,
        };
    }
  }
  return best && best.length >= MIN_WIRE_PX ? best : null;
}

/** Screen boxes of parts and wire midpoints, measured each frame while
 * any are wanted (pans, zooms and edits move them). */
function useCanvasGeometry(
  instances: readonly string[],
  nets: readonly OpNetLabel[],
): Geometry {
  const [state, setState] = useState<Geometry>(EMPTY);
  const key = JSON.stringify([instances, nets.map((n) => [n.node, n.routes])]);
  useEffect(() => {
    const [ids, wanted] = JSON.parse(key) as [string[], [string, string[]][]];
    if (!ids.length && !wanted.length) {
      setState(EMPTY);
      return;
    }
    let frame = 0;
    let last = "";
    const measure = () => {
      const svg = document.querySelector<SVGSVGElement>(
        '[data-testid="schematic-canvas"]',
      );
      const element = svg?.parentElement ?? null;
      if (svg && element) {
        const view = svg.getBoundingClientRect();
        const rects = new Map<string, DOMRect>();
        for (const id of ids) {
          const rect = instanceHit(id)?.getBoundingClientRect();
          if (
            rect &&
            rect.width > 0 &&
            rect.right > view.left &&
            rect.left < view.right &&
            rect.bottom > view.top &&
            rect.top < view.bottom
          )
            rects.set(id, rect);
        }
        const wires = new Map<
          string,
          { x: number; y: number; vertical: boolean }
        >();
        for (const [node, routes] of wanted) {
          const at = longestSegment(routes, view);
          if (at) wires.set(node, at);
        }
        const rect = element.getBoundingClientRect();
        const next = [
          rect.left,
          rect.top,
          ...[...rects].map(
            ([id, r]) =>
              `${id}:${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.right)},${Math.round(r.bottom)}`,
          ),
          ...[...wires].map(
            ([node, w]) => `${node}:${Math.round(w.x)},${Math.round(w.y)}`,
          ),
        ].join("|");
        if (next !== last) {
          last = next;
          setState({ rects, wires, container: { element, rect } });
        }
      }
      frame = requestAnimationFrame(measure);
    };
    measure();
    return () => cancelAnimationFrame(frame);
  }, [key]);
  return state;
}

const NO_LINK = () => null;

export function CanvasOverlay({
  badges,
  open,
  onOpen,
  op,
  store,
  instanceOf,
}: {
  badges: readonly CanvasBadge[];
  /** The part whose menu is open. */
  open: string | null;
  onOpen(badge: CanvasBadge, fromKeyboard: boolean): void;
  /** The operating point to draw, or null when it is off. */
  op: { devices: readonly OpDeviceLabel[]; nets: readonly OpNetLabel[] } | null;
  store: LinkStore;
  /** The drawn part (in the open Cell) each element is, or is inside. */
  instanceOf: ReadonlyMap<string, string>;
}) {
  const link = useSyncExternalStore(store.subscribe, store.get, NO_LINK);
  // Ring the parts a formula symbol or table row stands for; a part
  // hovered on the canvas shows its own hover already.
  const ringed =
    link && link.source !== "canvas"
      ? [
          ...new Set(
            link.elements.flatMap((element) => {
              const id = instanceOf.get(element);
              return id ? [id] : [];
            }),
          ),
        ]
      : [];
  const ids = [
    ...new Set([
      ...badges.map((badge) => badge.instanceId),
      ...(op?.devices ?? []).map((device) => device.instanceId),
      ...ringed,
    ]),
  ];
  const geometry = useCanvasGeometry(ids, op?.nets ?? []);
  const container = geometry.container;
  if (!container) return null;
  const left = (x: number) => x - container.rect.left;
  const top = (y: number) => y - container.rect.top;
  return createPortal(
    <div
      className="small-signal-badges"
      data-testid="small-signal-canvas-overlay"
    >
      {ringed.map((id) => {
        const rect = geometry.rects.get(id);
        return rect ? (
          <div
            key={`ring-${id}`}
            className="small-signal-link-ring"
            data-small-signal-ring={id}
            style={{
              left: left(rect.left) - 4,
              top: top(rect.top) - 4,
              width: rect.width + 8,
              height: rect.height + 8,
            }}
          />
        ) : null;
      })}
      {op?.nets.map((net) => {
        const at = geometry.wires.get(net.node);
        return at ? (
          <span
            key={`net-${net.node}`}
            className={`small-signal-op-net${at.vertical ? " is-vertical" : ""}`}
            data-op-node={net.node}
            style={{ left: left(at.x), top: top(at.y) }}
          >
            {net.text}
          </span>
        ) : null;
      })}
      {op?.devices.map((device) => {
        const rect = geometry.rects.get(device.instanceId);
        return rect && Math.min(rect.width, rect.height) >= MIN_PART_PX ? (
          <span
            key={`op-${device.instanceId}`}
            className={`small-signal-op-device is-${device.tone}`}
            data-op-device={device.element}
            style={{ left: left(rect.right), top: top(rect.bottom) }}
          >
            {device.region}
          </span>
        ) : null;
      })}
      {badges.map((badge) => {
        const rect = geometry.rects.get(badge.instanceId);
        return rect ? (
          <button
            key={badge.instanceId}
            type="button"
            className={`small-signal-badge${badge.warn ? " is-warn" : ""}`}
            data-small-signal-badge={badge.element}
            aria-label={badge.description}
            aria-expanded={open === badge.instanceId}
            title={badge.description}
            style={{ left: left(rect.right), top: top(rect.top) }}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => onOpen(badge, event.detail === 0)}
          >
            {badge.text}
          </button>
        ) : null;
      })}
    </div>,
    container.element,
  );
}
