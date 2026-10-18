import { describe, expect, it } from "vitest";
import {
  createLinkStore,
  elementSymbols,
  symbolElements,
  symbolHighlightCss,
  withSymbolKeys,
} from "./small-signal-link";

const params = [
  {
    name: "gm_M1",
    latex: "g_{m1,2}",
    value: 1,
    unit: "S",
    element: "M1",
    elements: ["M1", "M2"],
  },
  { name: "ro_M3", latex: "r_{o3}", value: 1, unit: "Ω", element: "M3" },
  {
    name: "cgd_M3",
    latex: "C_{gd3}",
    value: 1,
    unit: "F",
    element: "M3",
    elements: ["M3"],
  },
];

describe("formula ↔ drawing link", () => {
  it("maps each symbol to every element it stands for, matched groups whole", () => {
    const map = symbolElements(params);
    expect(map.get("g_{m1,2}")).toEqual(["M1", "M2"]);
    expect(map.get("r_{o3}")).toEqual(["M3"]);
    expect(elementSymbols(map, ["M2"])).toEqual(["g_{m1,2}"]);
    expect(elementSymbols(map, ["M3"])).toEqual(["r_{o3}", "C_{gd3}"]);
  });

  it("keys MathJax's data-latex without spaces, entities intact", () => {
    expect(
      withSymbolKeys('<g data-latex="r_{\\pi 1}"><g data-latex="a &amp; b">'),
    ).toBe(
      '<g data-latex="r_{\\pi 1}" data-sym="r_{\\pi1}"><g data-latex="a &amp; b" data-sym="a&amp;b">',
    );
  });

  it("highlights by attribute, quoting what a selector string needs", () => {
    expect(symbolHighlightCss(".p", [])).toBe("");
    expect(symbolHighlightCss(".p", ['r_{\\pi"1}'])).toBe(
      '.p .small-signal-formula [data-sym="r_{\\\\pi\\"1}"] { fill: var(--icm-accent); color: var(--icm-accent); }',
    );
  });

  it("notifies only on a change", () => {
    const store = createLinkStore();
    let calls = 0;
    store.subscribe(() => (calls += 1));
    const state = {
      source: "formula" as const,
      elements: ["M1"],
      symbols: ["g_{m1}"],
    };
    store.set(state);
    store.set({ ...state, elements: ["M1"] });
    expect(calls).toBe(1);
    store.set(null);
    expect(calls).toBe(2);
  });
});
