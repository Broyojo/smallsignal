import type { SmallSignalParam } from "@icm/small-signal";

// Formula ↔ drawing: the symbols of a part light up when the part is
// hovered, and the part when one of its symbols is. One small store holds
// what is hovered, so only the highlight itself re-renders.

export interface LinkState {
  /** Where the hover is: a formula symbol, a part on the canvas, a table
   * row, a label the panel put on the drawing. */
  source: "formula" | "canvas" | "table" | "label";
  /** The netlist elements to mark on the drawing. */
  elements: readonly string[];
  /** The symbols (LaTeX, as the formulas write them) to mark in formulas. */
  symbols: readonly string[];
  /** The nets whose wires to mark (a node voltage's label). */
  nodes?: readonly string[];
}

export interface LinkStore {
  get(): LinkState | null;
  set(next: LinkState | null): void;
  subscribe(listener: () => void): () => void;
}

const same = (a: LinkState | null, b: LinkState | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.source === b.source &&
    a.elements.join("\n") === b.elements.join("\n") &&
    a.symbols.join("\n") === b.symbols.join("\n") &&
    (a.nodes ?? []).join("\n") === (b.nodes ?? []).join("\n"));

export function createLinkStore(): LinkStore {
  let state: LinkState | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(next) {
      if (same(state, next)) return;
      state = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** A symbol's LaTeX without spaces: MathJax's `data-latex` and the
 * solver's `params` write the same symbol, spacing aside. */
export function symbolKey(latex: string): string {
  return latex.replace(/\s+/gu, "");
}

/** Each symbol the equations use, with the elements it stands for (every
 * member of a matched group). */
export function symbolElements(
  params: readonly SmallSignalParam[] | undefined,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const param of params ?? []) {
    const elements = param.elements?.length ? param.elements : [param.element];
    const key = symbolKey(param.latex);
    const known = map.get(key) ?? [];
    for (const element of elements)
      if (element && !known.includes(element)) known.push(element);
    map.set(key, known);
  }
  return map;
}

/** Every symbol of any of these elements, as the formulas write it. */
export function elementSymbols(
  map: ReadonlyMap<string, readonly string[]>,
  elements: readonly string[],
): string[] {
  return [...map]
    .filter(([, of]) => of.some((element) => elements.includes(element)))
    .map(([latex]) => latex);
}

/**
 * The symbol a pointer is over in a typeset formula: the nearest enclosing
 * node whose `data-sym` (see `withSymbolKeys`) is a known symbol (g_{m1}
 * for the "g" in it), within `root`.
 */
export function symbolAt(
  target: Element | null,
  map: ReadonlyMap<string, readonly string[]>,
  root: Element | null,
): string | null {
  for (
    let node: Element | null = target;
    node && node !== root;
    node = node.parentElement
  ) {
    const key = node.getAttribute("data-sym");
    if (key !== null && map.has(key)) return key;
  }
  return null;
}

/**
 * The known symbol whose box holds a point in a typeset formula, the
 * smallest when they nest: a glyph's ink is thin, so the pointer is often
 * between its strokes.
 */
export function symbolAtPoint(
  formula: Element,
  x: number,
  y: number,
  map: ReadonlyMap<string, readonly string[]>,
): string | null {
  let best: { key: string; area: number } | null = null;
  for (const node of formula.querySelectorAll("[data-sym]")) {
    const key = node.getAttribute("data-sym");
    if (key === null || !map.has(key)) continue;
    const box = node.getBoundingClientRect();
    if (x < box.left || x > box.right || y < box.top || y > box.bottom)
      continue;
    const area = box.width * box.height;
    if (!best || area < best.area) best = { key, area };
  }
  return best?.key ?? null;
}

/** A value inside a quoted CSS attribute selector. */
function cssString(value: string): string {
  return value.replace(/["\\]/gu, "\\$&").replace(/\n/gu, "\\a ");
}

/**
 * Highlight rules for these symbols in every typeset formula under
 * `scope`: one stylesheet, so no formula re-renders.
 */
export function symbolHighlightCss(
  scope: string,
  symbols: readonly string[],
): string {
  if (!symbols.length) return "";
  const selectors = symbols.map(
    (latex) =>
      `${scope} .small-signal-formula [data-sym="${cssString(latex)}"]`,
  );
  return `${selectors.join(",\n")} { fill: var(--icm-accent); color: var(--icm-accent); }`;
}

/**
 * A typeset formula's SVG with each node's `data-latex` (MathJax writes one
 * per node: g_{m1} on the subscripted symbol, g on its letter) also as a
 * `data-sym` key without spaces. Spaces never sit inside an HTML entity,
 * so stripping them from the escaped text strips them from the value.
 */
export function withSymbolKeys(svg: string): string {
  return svg.replace(
    / data-latex="([^"]*)"/gu,
    (attribute, value: string) =>
      `${attribute} data-sym="${value.replace(/\s+/gu, "")}"`,
  );
}
