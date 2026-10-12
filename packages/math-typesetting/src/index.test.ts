import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ANALOG_CANVAS_MATH_PROFILE_ID,
  createFormulaTypesetter,
  formulaSourceHash,
  loadFormulaAlphabet,
  type FormulaAlphabet,
  type FormulaRequest,
} from "./index.js";

const baseRequest: FormulaRequest = {
  latex: String.raw`V_{OUT}`,
  display: "inline",
  profileId: ANALOG_CANVAS_MATH_PROFILE_ID,
};

const corpus = [
  String.raw`V_{OUT}`,
  String.raw`I_{D1}+I_{D2}=I_{SS}`,
  String.raw`\overline{CLK}`,
  String.raw`\frac{g_m r_o}{1+s/\omega_p}`,
  String.raw`A_v=-g_m(r_o\parallel R_D)`,
  String.raw`\Delta V=\frac{I}{C}\Delta t`,
  String.raw`\frac{\mathrm{d}y}{\mathrm{d}x}`,
  String.raw`\int_0^1\frac{1}{\sqrt{1+\cos^2x}}\differentialD x`,
  String.raw`\prod_{k=0}^{N-1}a_k`,
  String.raw`\iint_{\Omega}f(x,y)\,\mathrm{d}x\,\mathrm{d}y`,
  String.raw`\lim_{s\to0}H(s)`,
  String.raw`\begin{bmatrix}1 & 0 \\ 0 & 1\end{bmatrix}`,
  String.raw`\begin{cases}V_{OH},&x>0\\V_{OL},&x\leq0\end{cases}`,
  String.raw`\mathrm{ABC}+\mathit{ABC}+\mathbf{ABC}+\mathbb{R}+\mathcal{L}+\mathscr{L}+\mathfrak{g}+\mathtt{A}`,
];

function countSvgTags(svg: string, closing = false): number {
  return [...svg.matchAll(closing ? /<\/svg>/g : /<svg\b/g)].length;
}

describe("Analog Canvas formula typesetter", () => {
  it("renders the formula corpus as standalone path-based SVG", async () => {
    const typesetter = createFormulaTypesetter();
    for (const latex of corpus) {
      const result = await typesetter.typeset({ ...baseRequest, latex });
      expect(result, latex).toMatchObject({ ok: true });
      if (!result.ok) continue;
      expect(result.artifact.width).toBeGreaterThan(0);
      expect(result.artifact.height).toBeGreaterThan(0);
      expect(result.artifact.baseline).toBeGreaterThanOrEqual(0);
      expect(result.artifact.baseline).toBeLessThanOrEqual(
        result.artifact.height,
      );
      expect(result.artifact.svg).toContain("<svg");
      expect(result.artifact.svg).toContain("<path");
      expect(countSvgTags(result.artifact.svg)).toBe(
        countSvgTags(result.artifact.svg, true),
      );
      expect(result.artifact.svg).not.toContain("<foreignObject");
      expect(result.artifact.svg).not.toContain("<image");
      expect(result.artifact.svg).not.toMatch(/(?:href|xlink:href)=/);
    }
  });

  it("keeps the complete expression when MathJax emits nested SVG glyphs", async () => {
    const typesetter = createFormulaTypesetter();
    const prefix = await typesetter.typeset({
      ...baseRequest,
      latex: String.raw`\overline{I_1^{n}}`,
    });
    const expression = await typesetter.typeset({
      ...baseRequest,
      latex: String.raw`\overline{I_1^{n}}=4kt`,
    });

    expect(prefix).toMatchObject({ ok: true });
    expect(expression).toMatchObject({ ok: true });
    if (!prefix.ok || !expression.ok) return;

    expect(expression.artifact.width).toBeGreaterThan(prefix.artifact.width);
    expect(expression.artifact.svg).toContain('data-latex="="');
    expect(expression.artifact.svg).toContain('data-latex="4"');
    // Sans typography groups adjacent letters in one math identifier; both
    // vector glyphs must survive after the nested overbar SVG.
    expect(expression.artifact.svg).toContain('data-latex="kt"');
    expect(expression.artifact.svg).toContain('data-c="1D5F8"');
    expect(expression.artifact.svg).toContain('data-c="1D601"');
    expect(countSvgTags(expression.artifact.svg)).toBe(
      countSvgTags(expression.artifact.svg, true),
    );
  });

  it("does not truncate ordinary operators after the first glyph", async () => {
    const result = await createFormulaTypesetter().typeset({
      ...baseRequest,
      latex: "x+y",
    });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.artifact.svg).toContain('data-latex="+"');
    expect(result.artifact.svg).toContain('data-latex="y"');
  });

  it("matches drawing sans weight/slant without rewriting explicit formula styling", async () => {
    const typesetter = createFormulaTypesetter();
    const glyphs = [
      [{}, "1D5DF"],
      [{ bold: false }, "1D5AB"],
      [{ italic: true }, "1D647"],
      [{ bold: false, italic: true }, "1D613"],
    ] as const;
    const keys = new Set<string>();
    for (const [style, glyph] of glyphs) {
      const result = await typesetter.typeset({
        ...baseRequest,
        latex: "L",
        ...style,
      });
      expect(result).toMatchObject({ ok: true });
      if (!result.ok) continue;
      expect(result.artifact.svg).toContain(`data-c="${glyph}"`);
      keys.add(result.artifact.sourceHash);
    }
    expect(keys.size).toBe(4);
    const explicit = await typesetter.typeset({
      ...baseRequest,
      latex: String.raw`\mathrm{L}`,
    });
    expect(explicit.ok && explicit.artifact.svg).toContain('data-c="4C"');
  });

  it("produces deterministic markup, metrics, and source hashes", async () => {
    const first = await createFormulaTypesetter().typeset(baseRequest);
    const second = await createFormulaTypesetter().typeset(baseRequest);
    expect(first).toEqual(second);
    expect(formulaSourceHash(baseRequest)).toHaveLength(16);
  });

  it.each(["href", "includegraphics", "newcommand", "require"])(
    "rejects the disallowed \\%s command",
    async (command) => {
      const result = await createFormulaTypesetter().typeset({
        ...baseRequest,
        latex: `\\${command}{value}`,
      });
      expect(result).toEqual({
        ok: false,
        diagnostic: expect.objectContaining({
          code: "FORMULA_DISALLOWED_COMMAND",
          command,
        }),
      });
    },
  );

  it("rejects malformed source instead of persisting an error glyph", async () => {
    const result = await createFormulaTypesetter().typeset({
      ...baseRequest,
      latex: String.raw`\frac{V_{OUT}`,
    });
    expect(result).toEqual({
      ok: false,
      diagnostic: expect.objectContaining({
        code: "FORMULA_INVALID_REQUEST",
        message: "Formula source has unbalanced braces.",
      }),
    });
  });
});

function recordingTypesetter() {
  const loaded: FormulaAlphabet[] = [];
  const typesetter = createFormulaTypesetter({
    loadAlphabet(alphabet) {
      loaded.push(alphabet);
      return loadFormulaAlphabet(alphabet);
    },
  });
  return { typesetter, loaded };
}

function resultDigest(result: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(result))
    .digest("hex")
    .slice(0, 16);
}

// Digests of the complete typeset result produced by the build that bundled
// every alphabet up front (origin/main at e73858c8). Lazy alphabets must not
// change a single glyph, metric or attribute.
const alphabetCases: readonly {
  latex: string;
  alphabets: readonly FormulaAlphabet[];
  inline: string;
  block: string;
}[] = [
  {
    latex: String.raw`\mathtt{ABCxyz012}`,
    alphabets: ["monospace"],
    inline: "1eac42e62d0e6e24",
    block: "39a1885a0c67bd0a",
  },
  {
    latex: String.raw`\texttt{code}+\textsf{x}`,
    alphabets: ["monospace"],
    inline: "eda70f5646392106",
    block: "2e8d020f15ef2b39",
  },
  {
    latex: String.raw`\mathfrak{ABCxyz}`,
    alphabets: ["fraktur"],
    inline: "780578ce8ed942d8",
    block: "f45c8ee3e8fd3121",
  },
  {
    latex: String.raw`\mathscr{ABCXYZ}`,
    alphabets: ["script"],
    inline: "737f2fd52cd011ee",
    block: "7b486b3c470a84bf",
  },
  {
    latex: String.raw`\mathbb{ABCRNZ}+\mathbb{1}`,
    alphabets: ["double-struck"],
    inline: "eb40aadf88dc4e7c",
    block: "bbaa46b415ea788c",
  },
  {
    latex: String.raw`\Bbb{R}`,
    alphabets: ["double-struck"],
    inline: "bf8922905cc46880",
    block: "536f7fe17d3a2166",
  },
  {
    latex: String.raw`\mathcal{ABCLOXYZ}`,
    alphabets: ["calligraphic"],
    inline: "29f292f2ec014a8e",
    block: "36293f1924b3d94a",
  },
  {
    latex: String.raw`\mathbfscr{L}+\mathbfcal{L}+\mathbffrak{g}`,
    alphabets: ["calligraphic", "fraktur", "script"],
    inline: "0f153325691fdf43",
    block: "e0533cb621751554",
  },
  {
    latex: "ℝ+ℂ+ℕ+𝔤+𝒜+𝚊+𝖠+ℒ+ℱ+𝕜",
    alphabets: ["double-struck", "fraktur", "monospace", "script"],
    inline: "2e5d6116032ed287",
    block: "557db23129c06bcd",
  },
  {
    latex: String.raw`\mathrm{ABC}+\mathit{ABC}+\mathbf{ABC}+\mathbb{R}+\mathcal{L}+\mathscr{L}+\mathfrak{g}+\mathtt{A}`,
    alphabets: [
      "calligraphic",
      "double-struck",
      "fraktur",
      "monospace",
      "script",
    ],
    inline: "1fa6d6dd39845d54",
    block: "9b9ef8bd96df7110",
  },
];

describe("formula alphabets", () => {
  it("typesets a formula without extra alphabets without loading any", async () => {
    const { typesetter, loaded } = recordingTypesetter();
    for (const [latex, style, digest] of [
      [String.raw`I_{D1}+I_{D2}=I_{SS}`, {}, "692fc57302afe3da"],
      [
        String.raw`\mathsf{ABC}+\mathsf{xyz}+\mathsf{012}`,
        {},
        "88d04d6be84dc11a",
      ],
      [String.raw`\text{gain}+\textbf{x}+\textit{y}`, {}, "85b17ff7034d7ce6"],
    ] as const) {
      const result = await typesetter.typeset({
        ...baseRequest,
        ...style,
        latex,
      });
      expect(resultDigest(result), latex).toBe(digest);
    }
    expect(loaded).toEqual([]);
  });

  it.each(alphabetCases)(
    "loads only the alphabets $latex uses and renders it unchanged",
    async ({ latex, alphabets, inline, block }) => {
      const { typesetter, loaded } = recordingTypesetter();
      const inlineResult = await typesetter.typeset({ ...baseRequest, latex });
      const blockResult = await typesetter.typeset({
        ...baseRequest,
        latex,
        display: "block",
        bold: false,
        italic: true,
      });
      expect(resultDigest(inlineResult)).toBe(inline);
      expect(resultDigest(blockResult)).toBe(block);
      expect([...loaded].sort()).toEqual(alphabets);
    },
  );

  it("never renders a missing glyph while an alphabet is still loading", async () => {
    const typesetter = createFormulaTypesetter();
    const [first, second] = await Promise.all([
      typesetter.typeset({ ...baseRequest, latex: String.raw`\Bbb{R}` }),
      typesetter.typeset({
        ...baseRequest,
        latex: String.raw`\Bbb{R}`,
        display: "block",
        bold: false,
        italic: true,
      }),
    ]);
    expect(resultDigest(first)).toBe("bf8922905cc46880");
    expect(resultDigest(second)).toBe("536f7fe17d3a2166");
  });

  it("reports an alphabet that fails to load and loads it on the next request", async () => {
    let attempts = 0;
    const typesetter = createFormulaTypesetter({
      loadAlphabet(alphabet) {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new Error("Network unavailable."))
          : loadFormulaAlphabet(alphabet);
      },
    });
    const request = { ...baseRequest, latex: String.raw`\Bbb{R}` };
    expect(await typesetter.typeset(request)).toEqual({
      ok: false,
      diagnostic: {
        code: "FORMULA_RENDER_ERROR",
        message: "Network unavailable.",
      },
    });
    expect(resultDigest(await typesetter.typeset(request))).toBe(
      "bf8922905cc46880",
    );
  });
});
