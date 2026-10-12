import { liteAdaptor } from "@mathjax/src/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "@mathjax/src/js/handlers/html.js";
import { TeX } from "@mathjax/src/js/input/tex.js";
import "@mathjax/src/js/input/tex/ams/AmsConfiguration.js";
import "@mathjax/src/js/input/tex/cases/CasesConfiguration.js";
import "@mathjax/src/js/input/tex/configmacros/ConfigMacrosConfiguration.js";
import { mathjax } from "@mathjax/src/js/mathjax.js";
// Every formula is set in the drawing's sans face, so its glyphs ship with the
// formula chunk itself.
import "@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif.js";
import { MathJaxNewcmFont } from "@mathjax/mathjax-newcm-font/js/svg.js";
import type { DynamicFile } from "@mathjax/src/js/output/common/FontData.js";
import { SVG } from "@mathjax/src/js/output/svg.js";
import {
  CANONICAL_FORMULA_FONT_SIZE,
  formulaSourceHash,
  validateFormulaRequest,
} from "./cache.js";
import type {
  FormulaArtifact,
  FormulaRequest,
  FormulaTypesetResult,
} from "./cache.js";

export {
  ANALOG_CANVAS_MATH_PROFILE_ID,
  FORMULA_MAX_LATEX_LENGTH,
  validateFormulaSource,
} from "./profile.js";
export {
  CANONICAL_FORMULA_FONT_SIZE,
  formulaSourceHash,
  validateFormulaRequest,
} from "./cache.js";
export type {
  FormulaArtifact,
  FormulaDiagnostic,
  FormulaDiagnosticCode,
  FormulaRequest,
  FormulaTypesetResult,
} from "./cache.js";
export type { FormulaProfileDiagnostic } from "./profile.js";

const SVG_START = /<svg\b/;
const DIMENSION_EX = /^(-?(?:\d+(?:\.\d+)?|\.\d+))ex$/;
const VERTICAL_ALIGN_EX = /vertical-align:\s*(-?(?:\d+(?:\.\d+)?|\.\d+))ex/;

function findOuterSvgRange(
  markup: string,
): { start: number; end: number } | null {
  const tags = /<\/?svg\b[^>]*>/g;
  let depth = 0;
  let start = -1;
  for (let match = tags.exec(markup); match; match = tags.exec(markup)) {
    const tag = match[0];
    if (tag.startsWith("</")) {
      if (start < 0 || depth === 0) return null;
      depth -= 1;
      if (depth === 0) return { start, end: tags.lastIndex };
      continue;
    }
    if (start < 0) start = match.index;
    if (!tag.endsWith("/>")) depth += 1;
  }
  return null;
}

function parseEx(value: string | null, fontSize: number): number | undefined {
  const match = value?.match(DIMENSION_EX);
  if (!match) return undefined;
  const ex = Number(match[1]);
  return Number.isFinite(ex) ? (ex * fontSize) / 2 : undefined;
}

function extractSvg(
  markup: string,
  request: FormulaRequest,
): Omit<FormulaArtifact, "sourceHash"> {
  const range = findOuterSvgRange(markup);
  if (!range || SVG_START.test(markup.slice(range.end))) {
    throw new Error(
      "Math renderer did not return one balanced standalone SVG element.",
    );
  }

  let svg = markup.slice(range.start, range.end);
  const openTag = svg.slice(0, svg.indexOf(">") + 1);
  const width = parseEx(
    openTag.match(/\bwidth="([^"]+)"/)?.[1] ?? null,
    CANONICAL_FORMULA_FONT_SIZE,
  );
  const height = parseEx(
    openTag.match(/\bheight="([^"]+)"/)?.[1] ?? null,
    CANONICAL_FORMULA_FONT_SIZE,
  );
  const verticalAlign = Number(openTag.match(VERTICAL_ALIGN_EX)?.[1] ?? "0");
  if (
    width === undefined ||
    height === undefined ||
    !Number.isFinite(verticalAlign) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new Error("Math renderer returned invalid formula metrics.");
  }

  svg = svg.replace(
    SVG_START,
    `<svg data-icm-formula="${formulaSourceHash(request)}"`,
  );
  const depth = Math.max(0, (-verticalAlign * CANONICAL_FORMULA_FONT_SIZE) / 2);
  return {
    svg,
    width,
    height,
    baseline: Math.max(0, Math.min(height, height - depth)),
  };
}

/** A MathJax alphabet that loads only when a formula reaches one of its glyphs. */
export type FormulaAlphabet =
  "double-struck" | "calligraphic" | "script" | "fraktur" | "monospace";

// Static import() paths let bundlers emit each alphabet as its own chunk, and
// keep worker bundles self-contained: MathJax's own loader would fetch a URL.
const alphabetModules: Record<FormulaAlphabet, () => Promise<unknown>> = {
  "double-struck": () =>
    import("@mathjax/mathjax-newcm-font/js/svg/dynamic/double-struck.js"),
  calligraphic: () =>
    import("@mathjax/mathjax-newcm-font/js/svg/dynamic/calligraphic.js"),
  script: () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/script.js"),
  fraktur: () =>
    import("@mathjax/mathjax-newcm-font/js/svg/dynamic/fraktur.js"),
  monospace: () =>
    import("@mathjax/mathjax-newcm-font/js/svg/dynamic/monospace.js"),
};

export async function loadFormulaAlphabet(
  alphabet: FormulaAlphabet,
): Promise<void> {
  await alphabetModules[alphabet]();
}

function isFormulaAlphabet(file: string): file is FormulaAlphabet {
  return Object.hasOwn(alphabetModules, file);
}

export interface FormulaTypesetterOptions {
  /** Loads one alphabet's glyph module; tests observe or fail it here. */
  loadAlphabet?: (alphabet: FormulaAlphabet) => Promise<void>;
}

export interface FormulaTypesetter {
  typeset(request: FormulaRequest): Promise<FormulaTypesetResult>;
}

class SchematicFormulaFont extends MathJaxNewcmFont {
  /** Alphabet loads MathJax is waiting on; a conversion retries after them. */
  readonly alphabetLoads = new Set<Promise<void>>();
  private readonly loadedAlphabets = new Map<FormulaAlphabet, Promise<void>>();

  constructor(
    private readonly loadAlphabet: (alphabet: FormulaAlphabet) => Promise<void>,
  ) {
    super();
    SchematicFormulaFont.dynamicFiles["sans-serif"]!.setup(this);
  }

  // MathJax calls this when a conversion first reaches a glyph of a font file
  // it has not set up; it removes that glyph's placeholder and abandons the
  // conversion until the returned promise settles.
  override loadDynamicFile(dynamic: DynamicFile): Promise<void> {
    const alphabet = dynamic.file;
    if (!isFormulaAlphabet(alphabet)) return super.loadDynamicFile(dynamic);
    const existing = this.loadedAlphabets.get(alphabet);
    if (existing) return existing;
    const load = this.loadAlphabet(alphabet).then(
      () => dynamic.setup(this),
      (error: unknown) => {
        // Restore the placeholders so the next conversion loads it again
        // rather than rendering those glyphs as missing.
        this.loadedAlphabets.delete(alphabet);
        this.defineDynamicCharacters({ [alphabet]: dynamic });
        throw error;
      },
    );
    this.loadedAlphabets.set(alphabet, load);
    this.alphabetLoads.add(load);
    const settle = () => this.alphabetLoads.delete(load);
    void load.then(settle, settle);
    return load;
  }
}

function retryPromise(error: unknown): unknown {
  return typeof error === "object" && error !== null && "retry" in error
    ? error.retry
    : undefined;
}

export function createFormulaTypesetter(
  options: FormulaTypesetterOptions = {},
): FormulaTypesetter {
  const adaptor = liteAdaptor();
  RegisterHTMLHandler(adaptor);
  const input = new TeX({
    packages: ["base", "ams", "cases", "configmacros"],
    macros: {
      differentialD: String.raw`\mathrm{d}`,
    },
  });
  const font = new SchematicFormulaFont(
    options.loadAlphabet ?? loadFormulaAlphabet,
  );
  // A Formula artifact is one self-contained SVG. MathJax 4 enables inline
  // line breaking by default and otherwise emits sibling SVG fragments around
  // operators (for example, `x` and `+y`). That shape cannot be embedded as a
  // single drafting object, so keep the expression on one MathJax line and let
  // the editor's formula source panel handle horizontal overflow.
  const output = new SVG({
    fontData: font,
    fontCache: "none",
    linebreaks: { inline: false },
  });
  const document = mathjax.document("", {
    InputJax: input,
    OutputJax: output,
  });

  function convert(request: FormulaRequest): FormulaTypesetResult {
    const command =
      request.bold === false
        ? request.italic
          ? "mathsfit"
          : "mathsf"
        : request.italic
          ? "mathbfsfit"
          : "mathbfsf";
    // A surrounding default keeps explicit \mathrm/\mathit/etc. authored
    // inside the expression effective. Do not rewrite the stored LaTeX.
    const node = document.convert(`\\${command}{${request.latex}}`, {
      display: request.display === "block",
      em: CANONICAL_FORMULA_FONT_SIZE,
      ex: CANONICAL_FORMULA_FONT_SIZE / 2,
      containerWidth: 4096,
    });
    const markup = adaptor.outerHTML(node);
    if (markup.includes('data-mml-node="merror"')) {
      return {
        ok: false,
        diagnostic: {
          code: "FORMULA_PARSE_ERROR",
          message:
            adaptor.textContent(node).trim() || "Invalid formula source.",
        },
      };
    }
    const artifact = extractSvg(markup, request);
    return {
      ok: true,
      artifact: {
        ...artifact,
        sourceHash: formulaSourceHash(request),
      },
    };
  }

  return {
    async typeset(request) {
      const diagnostic = validateFormulaRequest(request);
      if (diagnostic) return { ok: false, diagnostic };

      try {
        for (;;) {
          // A conversion that started an alphabet load left that alphabet's
          // glyphs without placeholders; converting before the load settles
          // would draw them as missing.
          await Promise.all(font.alphabetLoads);
          try {
            return convert(request);
          } catch (error) {
            const retry = retryPromise(error);
            if (!(retry instanceof Promise) || !font.alphabetLoads.has(retry))
              throw error;
            await retry;
          }
        }
      } catch (error) {
        return {
          ok: false,
          diagnostic: {
            code: "FORMULA_RENDER_ERROR",
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    },
  };
}

const defaultFormulaTypesetter = createFormulaTypesetter();

/** Typesets one formula, loading any alphabet it uses before it resolves. */
export function typesetFormula(
  request: FormulaRequest,
): Promise<FormulaTypesetResult> {
  return defaultFormulaTypesetter.typeset(request);
}
