import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { instanceHit, type CanvasBadge } from "./small-signal-device-menu";
import {
  devicePlaces,
  placeLabels,
  wirePlaces,
  type Box,
  type LabelRequest,
} from "./small-signal-label-layout";
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
  /** The drawing's own text on screen (names, values): labels keep off it. */
  texts: readonly Box[];
  /** Points on each net's longest visible wire segments, longest first. */
  wires: ReadonlyMap<string, readonly WirePoint[]>;
  container: { element: HTMLElement; rect: DOMRect } | null;
}

interface WirePoint {
  x: number;
  y: number;
  vertical: boolean;
}

const EMPTY: Geometry = {
  rects: new Map(),
  texts: [],
  wires: new Map(),
  container: null,
};

/** Zoomed out past these, a label would only cover the drawing. */
const MIN_WIRE_PX = 28;
const MIN_PART_PX = 10;

/** A route's hit polyline on the canvas, by route id. */
function routeHit(id: string): SVGPolylineElement | null {
  return document.querySelector<SVGPolylineElement>(
    `[data-testid="schematic-canvas"] [data-canvas-hit-kind="route"][data-canvas-hit-id="${CSS.escape(id)}"]`,
  );
}

/** A net's places for its label: a third and two thirds of the way along
 * its three longest visible segments, longest first. */
function wireSegments(routes: readonly string[], view: DOMRect): WirePoint[] {
  const found: (WirePoint & { length: number })[] = [];
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
      if (length < MIN_WIRE_PX) continue;
      // Off the middle: a net's name label usually sits there.
      for (const along of [1 / 3, 2 / 3]) {
        const x = a.x + (b.x - a.x) * along;
        const y = a.y + (b.y - a.y) * along;
        if (x > view.left && x < view.right && y > view.top && y < view.bottom)
          found.push({
            x,
            y,
            vertical: Math.abs(b.y - a.y) > Math.abs(b.x - a.x),
            length,
          });
      }
    }
  }
  return found
    .sort((p, q) => q.length - p.length)
    .slice(0, 6)
    .map(({ x, y, vertical }) => ({ x, y, vertical }));
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
        const wires = new Map<string, WirePoint[]>();
        for (const [node, routes] of wanted) {
          const at = wireSegments(routes, view);
          if (at.length) wires.set(node, at);
        }
        const texts: Box[] = [];
        if (wanted.length)
          for (const text of svg.querySelectorAll("text")) {
            const r = text.getBoundingClientRect();
            if (
              r.width > 0 &&
              r.right > view.left &&
              r.left < view.right &&
              r.bottom > view.top &&
              r.top < view.bottom
            )
              texts.push({
                left: r.left,
                top: r.top,
                width: r.width,
                height: r.height,
              });
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
            ([node, at]) =>
              `${node}:${at.map((w) => `${Math.round(w.x)},${Math.round(w.y)}`).join(";")}`,
          ),
          ...texts.map(
            (t) =>
              `${Math.round(t.left)},${Math.round(t.top)},${Math.round(t.width)}`,
          ),
        ].join("|");
        if (next !== last) {
          last = next;
          setState({ rects, texts, wires, container: { element, rect } });
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

/** Label height on screen: 15 px line, 1 px border each side. */
const LABEL_HEIGHT = 17;

let measure: CanvasRenderingContext2D | null | undefined;

/** A label's width on screen, as its 10 px text draws (padding, border). */
function labelWidth(text: string, bold: boolean): number {
  if (measure === undefined)
    measure = document.createElement("canvas").getContext("2d");
  if (!measure) return text.length * 6 + 10;
  const family = getComputedStyle(document.body).fontFamily;
  measure.font = `${bold ? 650 : 400} 10px ${family}`;
  return Math.ceil(measure.measureText(text).width) + 10;
}

/**
 * Every operating-point label's box, none over another or a badge: an
 * off or triode device first (the one to notice), then node voltages,
 * then the devices that amplify.
 */
function layoutLabels(
  op: { devices: readonly OpDeviceLabel[]; nets: readonly OpNetLabel[] } | null,
  geometry: Geometry,
  badges: readonly CanvasBadge[],
): Map<string, Box> {
  if (!op) return new Map();
  const obstacles: Box[] = [...geometry.texts];
  for (const box of badges.flatMap((badge) => {
    const rect = geometry.rects.get(badge.instanceId);
    if (!rect) return [];
    const width = Math.max(18, labelWidth(badge.text, true));
    // As the badge's CSS draws it: translate(-35%, -65%).
    return [
      {
        left: rect.right - 0.35 * width,
        top: rect.top - 0.65 * 18,
        width,
        height: 18,
      },
    ];
  }))
    obstacles.push(box);
  const device = (label: OpDeviceLabel): LabelRequest[] => {
    const rect = geometry.rects.get(label.instanceId);
    if (!rect || Math.min(rect.width, rect.height) < MIN_PART_PX) return [];
    const size = {
      width: labelWidth(label.region, true),
      height: LABEL_HEIGHT,
    };
    return [
      {
        id: `op-${label.instanceId}`,
        ...size,
        places: devicePlaces(rect, size),
      },
    ];
  };
  const amplifying = (label: OpDeviceLabel) =>
    label.tone === "saturation" || label.tone === "active";
  const nets = op.nets.flatMap((net): LabelRequest[] => {
    const at = geometry.wires.get(net.node);
    if (!at?.length) return [];
    const size = { width: labelWidth(net.text, false), height: LABEL_HEIGHT };
    return [
      {
        id: `net-${net.node}`,
        ...size,
        places: at.flatMap((point) => wirePlaces(point, size)),
      },
    ];
  });
  return placeLabels(
    [
      ...op.devices.filter((label) => !amplifying(label)).flatMap(device),
      ...nets,
      ...op.devices.filter(amplifying).flatMap(device),
    ],
    obstacles,
  );
}

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
  const labels = layoutLabels(op, geometry, badges);
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
        const box = labels.get(`net-${net.node}`);
        const at = geometry.wires.get(net.node)?.[0];
        return box ? (
          <span
            key={`net-${net.node}`}
            className={`small-signal-op-net${at?.vertical ? " is-vertical" : ""}`}
            data-op-node={net.node}
            style={{ left: left(box.left), top: top(box.top) }}
          >
            {net.text}
          </span>
        ) : null;
      })}
      {op?.devices.map((device) => {
        const box = labels.get(`op-${device.instanceId}`);
        return box ? (
          <span
            key={`op-${device.instanceId}`}
            className={`small-signal-op-device is-${device.tone}`}
            data-op-device={device.element}
            style={{ left: left(box.left), top: top(box.top) }}
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
