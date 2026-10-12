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

// Every glyph file of the font except sans-serif, which every formula uses.
// Static import() paths let bundlers emit each file as its own chunk, loaded
// the first time a formula reaches one of its glyphs, and keep worker bundles
// self-contained: MathJax's own loader would fetch a URL instead.
const fontFileModules = {
  latin: () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/latin.js"),
  "latin-b": () =>
    import("@mathjax/mathjax-newcm-font/js/svg/dynamic/latin-b.js"),
  "latin-i": () =>
    import("@mathjax/mathjax-newcm-font/js/svg/dynamic/latin-i.js"),
  "latin-bi": () =>
    import("@mathjax/mathjax-newcm-font/js/svg/dynamic/latin-bi.js"),
  "double-struck": () =>
    import("@mathjax/mathjax-newcm-font/js/svg/dynamic/double-struck.js"),
  fraktur: () =>
    import("@mathjax/mathjax-newcm-font/js/svg/dynamic/fraktur.js"),
  script: () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/script.js"),
  "sans-serif-r": () =>
    import("@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif-r.js"),
  "sans-serif-b": () =>
    import("@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif-b.js"),
  "sans-serif-i": () =>
    import("@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif-i.js"),
  "sans-serif-bi": () =>
    import("@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif-bi.js"),
  "sans-serif-ex": () =>
    import("@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif-ex.js"),
  monospace: () =>
    import("@mathjax/mathjax-newcm-font/js/svg/dynamic/monospace.js"),
  "monospace-l": () =>
    import("@mathjax/mathjax-newcm-font/js/svg/dynamic/monospace-l.js"),
  "monospace-ex": () =>
    import("@mathjax/mathjax-newcm-font/js/svg/dynamic/monospace-ex.js"),
  calligraphic: () =>
    import("@mathjax/mathjax-newcm-font/js/svg/dynamic/calligraphic.js"),
  math: () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/math.js"),
  symbols: () =>
    import("@mathjax/mathjax-newcm-font/js/svg/dynamic/symbols.js"),
  "symbols-b-i": () =>
    import("@mathjax/mathjax-newcm-font/js/svg/dynamic/symbols-b-i.js"),
  greek: () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/greek.js"),
  "greek-ss": () =>
    import("@mathjax/mathjax-newcm-font/js/svg/dynamic/greek-ss.js"),
  cyrillic: () =>
    import("@mathjax/mathjax-newcm-font/js/svg/dynamic/cyrillic.js"),
  "cyrillic-ss": () =>
    import("@mathjax/mathjax-newcm-font/js/svg/dynamic/cyrillic-ss.js"),
  phonetics: () =>
    import("@mathjax/mathjax-newcm-font/js/svg/dynamic/phonetics.js"),
  "phonetics-ss": () =>
    import("@mathjax/mathjax-newcm-font/js/svg/dynamic/phonetics-ss.js"),
  hebrew: () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/hebrew.js"),
  devanagari: () =>
    import("@mathjax/mathjax-newcm-font/js/svg/dynamic/devanagari.js"),
  cherokee: () =>
    import("@mathjax/mathjax-newcm-font/js/svg/dynamic/cherokee.js"),
  arabic: () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/arabic.js"),
  "braille-d": () =>
    import("@mathjax/mathjax-newcm-font/js/svg/dynamic/braille-d.js"),
  braille: () =>
    import("@mathjax/mathjax-newcm-font/js/svg/dynamic/braille.js"),
  arrows: () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/arrows.js"),
  marrows: () =>
    import("@mathjax/mathjax-newcm-font/js/svg/dynamic/marrows.js"),
  accents: () =>
    import("@mathjax/mathjax-newcm-font/js/svg/dynamic/accents.js"),
  "accents-b-i": () =>
    import("@mathjax/mathjax-newcm-font/js/svg/dynamic/accents-b-i.js"),
  shapes: () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/shapes.js"),
  mshapes: () =>
    import("@mathjax/mathjax-newcm-font/js/svg/dynamic/mshapes.js"),
  variants: () =>
    import("@mathjax/mathjax-newcm-font/js/svg/dynamic/variants.js"),
  PUA: () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/PUA.js"),
} satisfies Record<string, () => Promise<unknown>>;

/** A MathJax glyph file that loads only when a formula reaches one of its glyphs. */
export type FormulaFontFile = keyof typeof fontFileModules;

/** The default loader; tests wrap it to observe or fail loads. */
export async function loadFormulaFontFile(
  file: FormulaFontFile,
): Promise<void> {
  await fontFileModules[file]();
}

function isFormulaFontFile(file: string): file is FormulaFontFile {
  return Object.hasOwn(fontFileModules, file);
}

/** Tests replace the loader to observe or fail font file loads. */
export interface FormulaTypesetterOptions {
  loadFontFile?: (file: FormulaFontFile) => Promise<void>;
}

export interface FormulaTypesetter {
  typeset(request: FormulaRequest): Promise<FormulaTypesetResult>;
}

class FontFileUnavailableError extends Error {}

class SchematicFormulaFont extends MathJaxNewcmFont {
  /** Font file loads still in flight; no conversion may run beside one. */
  readonly pendingLoads = new Set<Promise<void>>();
  /** Started loads by file, kept once they succeed. */
  private readonly fontFileLoads = new Map<string, Promise<void>>();

  constructor(
    private readonly loadFontFile: (file: FormulaFontFile) => Promise<void>,
  ) {
    super();
    SchematicFormulaFont.dynamicFiles["sans-serif"]!.setup(this);
  }

  // MathJax calls this when a conversion first reaches a glyph of a font file
  // it has not set up; it removes that glyph's placeholder and abandons the
  // conversion until the returned promise settles.
  override loadDynamicFile(dynamic: DynamicFile): Promise<void> {
    const file = dynamic.file;
    const existing = this.fontFileLoads.get(file);
    if (existing) return existing;
    const load = (
      isFormulaFontFile(file)
        ? this.loadFontFile(file)
        : Promise.reject(new Error(`Unknown formula font file ${file}.`))
    ).then(
      () => dynamic.setup(this),
      (error: unknown) => {
        // Restore the placeholders so the next conversion loads the file
        // again rather than drawing those glyphs as missing.
        this.fontFileLoads.delete(file);
        this.defineDynamicCharacters({ [file]: dynamic });
        throw new FontFileUnavailableError(
          error instanceof Error ? error.message : String(error),
        );
      },
    );
    this.fontFileLoads.set(file, load);
    this.pendingLoads.add(load);
    const settle = () => this.pendingLoads.delete(load);
    void load.then(settle, settle);
    return load;
  }
}

function renderError(error: unknown): FormulaTypesetResult {
  return {
    ok: false,
    diagnostic: {
      code: "FORMULA_RENDER_ERROR",
      message: error instanceof Error ? error.message : String(error),
    },
  };
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
    options.loadFontFile ?? loadFormulaFontFile,
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

      for (;;) {
        // MathJax removed the placeholders of glyphs whose file is loading, so
        // a conversion beside a pending load could draw them as missing. No
        // await may separate this check from the conversion.
        while (font.pendingLoads.size > 0)
          await Promise.allSettled(font.pendingLoads);
        try {
          return convert(request);
        } catch (error) {
          const retry = retryPromise(error);
          if (!(retry instanceof Promise) || !font.pendingLoads.has(retry))
            return renderError(error);
          try {
            await retry;
          } catch (loadError) {
            if (!(loadError instanceof FontFileUnavailableError))
              return renderError(loadError);
            return {
              ok: false,
              diagnostic: {
                code: "FORMULA_FONT_UNAVAILABLE",
                message: `Formula glyphs could not be loaded: ${loadError.message}`,
              },
            };
          }
        }
      }
    },
  };
}

const defaultFormulaTypesetter = createFormulaTypesetter();

/** Typesets one formula, loading the glyph files it uses before it resolves. */
export function typesetFormula(
  request: FormulaRequest,
): Promise<FormulaTypesetResult> {
  return defaultFormulaTypesetter.typeset(request);
}
