import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { instanceHit, type CanvasBadge } from "./small-signal-device-menu";
import {
  devicePlaces,
  leaderLine,
  placeLabels,
  wirePlaces,
  type Box,
  type LabelRequest,
  type Obstacle,
  type PlacedLabel,
  type Point,
} from "./small-signal-label-layout";
import type { LinkState, LinkStore } from "./small-signal-link";

// Everything the panel draws on the canvas, in one layer that follows pans
// and zooms and one look (a tag): a badge on each part with assumptions,
// the operating point (node voltages on their wires, each transistor's
// region against it), placed together by `placeLabels`, and the ring
// around a part (or the mark along a net) whose symbol or label is
// pointed at.

/** A node's DC voltage, shown on one of its net's wires. */
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
  /** Every part on screen, by instance id: labels keep off them. */
  parts: readonly (Box & { id: string })[];
  /** The drawing's own text on screen (names, values): labels keep off it. */
  texts: readonly Box[];
  /** Each net's visible wire segments on screen, longest first. */
  wires: ReadonlyMap<string, readonly Segment[]>;
  container: { element: HTMLElement; rect: DOMRect } | null;
}

interface Segment {
  a: Point;
  b: Point;
}

const EMPTY: Geometry = {
  rects: new Map(),
  parts: [],
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

const visible = (
  r: { left: number; top: number; right: number; bottom: number },
  view: DOMRect,
) =>
  r.right > view.left &&
  r.left < view.right &&
  r.bottom > view.top &&
  r.top < view.bottom;

/** A net's wire segments on screen that reach into the view, longest
 * first. */
function wireSegments(routes: readonly string[], view: DOMRect): Segment[] {
  const found: (Segment & { length: number })[] = [];
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
      const box = {
        left: Math.min(a.x, b.x),
        right: Math.max(a.x, b.x),
        top: Math.min(a.y, b.y),
        bottom: Math.max(a.y, b.y),
      };
      if (
        !visible({ ...box, right: box.right + 1, bottom: box.bottom + 1 }, view)
      )
        continue;
      found.push({
        a: { x: a.x, y: a.y },
        b: { x: b.x, y: b.y },
        length: Math.hypot(b.x - a.x, b.y - a.y),
      });
    }
  }
  return found
    .sort((p, q) => q.length - p.length)
    .map(({ a, b }) => ({ a, b }));
}

const boxOf = (r: DOMRect): Box => ({
  left: r.left,
  top: r.top,
  width: r.width,
  height: r.height,
});

/** Screen boxes of parts, the drawing's text and the nets' wires,
 * measured each frame while any are wanted (pans, zooms and edits move
 * them). */
function useCanvasGeometry(
  instances: readonly string[],
  nets: readonly OpNetLabel[],
  /** Any operating-point label is shown: the drawing's text and parts are
   * measured for them to keep off. */
  labelled: boolean,
): Geometry {
  const [state, setState] = useState<Geometry>(EMPTY);
  const key = JSON.stringify([
    instances,
    nets.map((n) => [n.node, n.routes]),
    labelled,
  ]);
  useEffect(() => {
    const [ids, wanted, withMarks] = JSON.parse(key) as [
      string[],
      [string, string[]][],
      boolean,
    ];
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
          if (rect && rect.width > 0 && visible(rect, view))
            rects.set(id, rect);
        }
        const wires = new Map<string, Segment[]>();
        for (const [node, routes] of wanted) {
          const at = wireSegments(routes, view);
          if (at.length) wires.set(node, at);
        }
        const texts: Box[] = [];
        const parts: (Box & { id: string })[] = [];
        if (withMarks) {
          for (const text of svg.querySelectorAll("text")) {
            const r = text.getBoundingClientRect();
            if (r.width > 0 && visible(r, view)) texts.push(boxOf(r));
          }
          for (const hit of svg.querySelectorAll(
            '[data-canvas-hit-kind="instance"]',
          )) {
            const id = hit.getAttribute("data-canvas-hit-id");
            const r = hit.getBoundingClientRect();
            if (id && r.width > 0 && visible(r, view))
              parts.push({ id, ...boxOf(r) });
          }
        }
        const rect = element.getBoundingClientRect();
        const round = (n: number) => Math.round(n);
        const next = [
          rect.left,
          rect.top,
          ...[...rects].map(
            ([id, r]) =>
              `${id}:${round(r.left)},${round(r.top)},${round(r.right)},${round(r.bottom)}`,
          ),
          ...[...wires].map(
            ([node, at]) =>
              `${node}:${at.map((w) => `${round(w.a.x)},${round(w.a.y)},${round(w.b.x)},${round(w.b.y)}`).join(";")}`,
          ),
          ...texts.map(
            (t) => `${round(t.left)},${round(t.top)},${round(t.width)}`,
          ),
          ...parts.map(
            (p) =>
              `${p.id}:${round(p.left)},${round(p.top)},${round(p.width)},${round(p.height)}`,
          ),
        ].join("|");
        if (next !== last) {
          last = next;
          setState({
            rects,
            parts,
            texts,
            wires,
            container: { element, rect },
          });
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

/** Every label's height on screen: 15 px line, 1 px border each side. */
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

/** A badge's box on screen, as its CSS draws it: at its part's top right,
 * translate(-35%, -65%). */
function badgeBox(badge: CanvasBadge, rect: DOMRect): Box {
  const width = Math.max(18, labelWidth(badge.text, true));
  return {
    left: rect.right - 0.35 * width,
    top: rect.top - 0.65 * LABEL_HEIGHT,
    width,
    height: LABEL_HEIGHT,
  };
}

/**
 * Every operating-point label, none over another, a badge, a part or the
 * drawing's text: an off or triode device first (the one to notice), then
 * node voltages, then the devices that amplify.
 */
function layoutLabels(
  op: { devices: readonly OpDeviceLabel[]; nets: readonly OpNetLabel[] } | null,
  geometry: Geometry,
  badges: readonly CanvasBadge[],
): Map<string, PlacedLabel> {
  if (!op) return new Map();
  const obstacles: Obstacle[] = [...geometry.texts, ...geometry.parts];
  for (const badge of badges) {
    const rect = geometry.rects.get(badge.instanceId);
    if (rect) obstacles.push(badgeBox(badge, rect));
  }
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
        target: boxOf(rect),
        own: label.instanceId,
        places: devicePlaces(rect, size),
      },
    ];
  };
  const amplifying = (label: OpDeviceLabel) =>
    label.tone === "saturation" || label.tone === "active";
  const nets = op.nets.flatMap((net): LabelRequest[] => {
    const segments = (geometry.wires.get(net.node) ?? []).filter(
      (segment) =>
        Math.hypot(segment.b.x - segment.a.x, segment.b.y - segment.a.y) >=
        MIN_WIRE_PX,
    );
    if (!segments.length) return [];
    const size = { width: labelWidth(net.text, false), height: LABEL_HEIGHT };
    const places = segments
      .slice(0, 8)
      .map((segment) => wirePlaces(segment.a, segment.b, size));
    return [
      {
        id: `net-${net.node}`,
        ...size,
        places: [
          ...places.flatMap((at) => at.on),
          ...places.flatMap((at) => at.off),
        ],
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
  symbolsOf,
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
  /** An element's symbols in the formulas, marked while its label is
   * pointed at. */
  symbolsOf(element: string): readonly string[];
}) {
  const link = useSyncExternalStore(store.subscribe, store.get, NO_LINK);
  // Ring the parts a formula symbol, table row or label stands for; a
  // part hovered on the canvas shows its own hover already.
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
  const geometry = useCanvasGeometry(
    ids,
    op?.nets ?? [],
    Boolean(op && (op.nets.length || op.devices.length)),
  );
  const container = geometry.container;
  const labels = container
    ? layoutLabels(op, geometry, badges)
    : new Map<string, PlacedLabel>();
  // Pointing at a label marks what it describes: the part (and its
  // symbols) or the net's wires. Found by box, so the labels never take
  // a press from the drawing under them.
  const hits = useRef<{ box: Box; state: LinkState }[]>([]);
  hits.current = [
    ...(op?.devices ?? []).flatMap((device) => {
      const box = labels.get(`op-${device.instanceId}`);
      return box
        ? [
            {
              box,
              state: {
                source: "label" as const,
                elements: [device.element],
                symbols: symbolsOf(device.element),
              },
            },
          ]
        : [];
    }),
    ...(op?.nets ?? []).flatMap((net) => {
      const box = labels.get(`net-${net.node}`);
      return box
        ? [
            {
              box,
              state: {
                source: "label" as const,
                elements: [],
                symbols: [],
                nodes: [net.node],
              },
            },
          ]
        : [];
    }),
  ];
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const hit = hits.current.find(
        ({ box }) =>
          event.clientX >= box.left &&
          event.clientX <= box.left + box.width &&
          event.clientY >= box.top &&
          event.clientY <= box.top + box.height,
      );
      if (hit) store.set(hit.state);
      else if (store.get()?.source === "label") store.set(null);
    };
    window.addEventListener("pointermove", move);
    return () => {
      window.removeEventListener("pointermove", move);
      if (store.get()?.source === "label") store.set(null);
    };
  }, [store]);
  if (!container) return null;
  const left = (x: number) => x - container.rect.left;
  const top = (y: number) => y - container.rect.top;
  const linkedElements = new Set(link?.elements ?? []);
  const linkedNodes = new Set(link?.nodes ?? []);
  const leaders = [...labels.values()].filter((label) => label.leader);
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
      {linkedNodes.size || leaders.length ? (
        <svg className="small-signal-leaders" aria-hidden="true">
          {[...linkedNodes].flatMap((node) =>
            (geometry.wires.get(node) ?? []).map((segment, index) => (
              <line
                key={`wire-${node}-${index}`}
                className="small-signal-net-mark"
                data-net-mark={node}
                x1={left(segment.a.x)}
                y1={top(segment.a.y)}
                x2={left(segment.b.x)}
                y2={top(segment.b.y)}
              />
            )),
          )}
          {leaders.map((label, index) => {
            const [from, to] = leaderLine(label, label.target);
            return (
              <line
                key={`leader-${index}`}
                className="small-signal-leader"
                x1={left(from.x)}
                y1={top(from.y)}
                x2={left(to.x)}
                y2={top(to.y)}
              />
            );
          })}
        </svg>
      ) : null}
      {op?.nets.map((net) => {
        const box = labels.get(`net-${net.node}`);
        return box ? (
          <span
            key={`net-${net.node}`}
            className={`small-signal-tag small-signal-op-net${linkedNodes.has(net.node) ? " is-linked" : ""}`}
            data-op-node={net.node}
            data-leader={box.leader || undefined}
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
            className={`small-signal-tag small-signal-op-device is-${device.tone}${linkedElements.has(device.element) ? " is-linked" : ""}`}
            data-op-device={device.element}
            data-op-instance={device.instanceId}
            data-leader={box.leader || undefined}
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
            className={`small-signal-tag small-signal-badge${badge.warn ? " is-warn" : ""}`}
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
