import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FormulaTypesetResult } from "./cache.js";

const typesetFormula = vi.fn<() => Promise<FormulaTypesetResult>>();
vi.mock("./index.js", () => ({ typesetFormula }));

const {
  ANALOG_CANVAS_MATH_PROFILE_ID,
  cachedFormulaResult,
  clearFormulaArtifactCacheForTests,
  prepareFormula,
} = await import("./cache.js");

const request = {
  latex: String.raw`\mathbb{R}`,
  display: "inline",
  profileId: ANALOG_CANVAS_MATH_PROFILE_ID,
} as const;

describe("prepareFormula", () => {
  beforeEach(() => {
    clearFormulaArtifactCacheForTests();
    typesetFormula.mockReset();
  });

  it("typesets again after a glyph file failed to load", async () => {
    const unavailable: FormulaTypesetResult = {
      ok: false,
      diagnostic: {
        code: "FORMULA_FONT_UNAVAILABLE",
        message: "Formula glyphs could not be loaded: Network unavailable.",
      },
    };
    const rendered: FormulaTypesetResult = {
      ok: true,
      artifact: {
        svg: "<svg/>",
        width: 1,
        height: 1,
        baseline: 1,
        sourceHash: "",
      },
    };
    typesetFormula
      .mockResolvedValueOnce(unavailable)
      .mockResolvedValueOnce(rendered);

    expect(await prepareFormula(request)).toEqual(unavailable);
    expect(cachedFormulaResult(request)).toBeUndefined();
    expect(await prepareFormula(request)).toEqual(rendered);
    expect(cachedFormulaResult(request)).toEqual(rendered);
    expect(typesetFormula).toHaveBeenCalledTimes(2);
  });

  it("keeps a formula's lasting failure", async () => {
    const parseError: FormulaTypesetResult = {
      ok: false,
      diagnostic: { code: "FORMULA_PARSE_ERROR", message: "Missing argument." },
    };
    typesetFormula.mockResolvedValueOnce(parseError);
    await prepareFormula(request);
    expect(await prepareFormula(request)).toEqual(parseError);
    expect(typesetFormula).toHaveBeenCalledTimes(1);
  });
});
