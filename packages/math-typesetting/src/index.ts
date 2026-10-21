import { liteAdaptor } from "@mathjax/src/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "@mathjax/src/js/handlers/html.js";
import { TeX } from "@mathjax/src/js/input/tex.js";
import "@mathjax/src/js/input/tex/ams/AmsConfiguration.js";
import "@mathjax/src/js/input/tex/cases/CasesConfiguration.js";
import "@mathjax/src/js/input/tex/configmacros/ConfigMacrosConfiguration.js";
import { mathjax } from "@mathjax/src/js/mathjax.js";
import type { MmlNode } from "@mathjax/src/js/core/MmlTree/MmlNode.js";
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

// The glyph files a formula loads the first time it reaches one of their
// glyphs: the five alphabets (\mathbb, \mathcal, \mathscr, \mathfrak,
// \mathtt and their bold and Unicode forms) and the files behind common
// operators and symbols: math (\perp, \lll, \ggg, \triangleq, ...), shapes
// (\checkmark, \sharp, \bigstar, ...) and arrows (\leadsto,
// \rightsquigarrow, ...). Sans-serif is bundled, since every formula is set
// in it. The remaining newcm files (other scripts, \digamma, \yen, accented
// Latin letters) are left out to keep the Worker bundle small; a formula that
// needs one is refused. Static import() paths let bundlers emit each file as
// its own chunk and keep worker bundles self-contained: MathJax's own loader
// would fetch a URL instead.
const fontFileModules = {
  "double-struck": () =>
    import("@mathjax/mathjax-newcm-font/js/svg/dynamic/double-struck.js"),
  calligraphic: () =>
    import("@mathjax/mathjax-newcm-font/js/svg/dynamic/calligraphic.js"),
  script: () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/script.js"),
  fraktur: () =>
    import("@mathjax/mathjax-newcm-font/js/svg/dynamic/fraktur.js"),
  monospace: () =>
    import("@mathjax/mathjax-newcm-font/js/svg/dynamic/monospace.js"),
  math: () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/math.js"),
  shapes: () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/shapes.js"),
  arrows: () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/arrows.js"),
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
        ? this.loadFontFile(file).catch((error: unknown) => {
            throw new FontFileUnavailableError(
              error instanceof Error ? error.message : String(error),
            );
          })
        : Promise.reject(
            new Error(
              `The formula uses characters the formula font does not include (MathJax ${file} glyphs).`,
            ),
          )
    ).then(
      () => dynamic.setup(this),
      (error: unknown) => {
        // Restore the placeholders so the next conversion reaches the file
        // again rather than drawing those glyphs as missing.
        this.fontFileLoads.delete(file);
        this.defineDynamicCharacters({ [file]: dynamic });
        throw error;
      },
    );
    this.fontFileLoads.set(file, load);
    this.pendingLoads.add(load);
    const settle = () => this.pendingLoads.delete(load);
    void load.then(settle, settle);
    return load;
  }
}

/**
 * Lets a formula break only between its terms, as a textbook sets a long
 * equation: at the operators of its top level or of a \\left…\\right group
 * in it, never inside a fraction, script or root. Each line after the
 * first is indented 2em.
 */
function markTermBreaks(node: MmlNode, open: boolean): void {
  for (const child of node.childNodes as MmlNode[]) {
    if (child.isKind("mo")) {
      if (open) {
        child.attributes.set("indentalign", "left");
        child.attributes.set("indentshift", "2em");
        child.attributes.set("indentalignfirst", "left");
        child.attributes.set("indentshiftfirst", "0");
      } else child.attributes.set("linebreak", "nobreak");
    } else if (!child.isToken) {
      const group =
        child.isKind("mrow") ||
        child.isKind("mstyle") ||
        child.isKind("TeXAtom");
      markTermBreaks(child, open && group);
    }
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
  // The break width of the conversion in progress (ems); null for one line.
  let breakWidth: number | null = null;
  input.postFilters.add((args: unknown) => {
    if (breakWidth === null) return;
    const { root } = (args as { data: { root: MmlNode } }).data;
    root.attributes.set("overflow", "linebreak");
    // The artifact's ems take an ex as half of one (`extractSvg`); MathJax's
    // ex is the font's x-height.
    const ems = (breakWidth * 2 * font.params.x_height).toFixed(3);
    root.attributes.set("maxwidth", `${ems}em`);
    markTermBreaks(root, true);
  });

  // A Formula artifact is one self-contained SVG. MathJax 4 enables inline
  // line breaking by default and otherwise emits sibling SVG fragments around
  // operators (for example, `x` and `+y`). That shape cannot be embedded as a
  // single drafting object, so keep the expression on one MathJax line and let
  // the editor's formula source panel handle horizontal overflow. A block
  // formula given a break width breaks inside its one SVG instead.
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
    if (request.breakWidth === undefined || request.display !== "block")
      return convertLine(request, null);
    const broken = convertLine(request, request.breakWidth);
    if (!broken.ok) return broken;
    const line = convertLine(request, null);
    if (!line.ok) return line;
    // Kept when it fits, or when breaking helps even though one term is
    // too wide; a formula that barely breaks (one long fraction) scrolls
    // on one line as it always has.
    const fits =
      broken.artifact.width / CANONICAL_FORMULA_FONT_SIZE <=
      request.breakWidth + 0.01;
    return fits || broken.artifact.width < 0.75 * line.artifact.width
      ? broken
      : line;
  }

  function convertLine(
    request: FormulaRequest,
    width: number | null,
  ): FormulaTypesetResult {
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
    // Broken lines start at the left; a single line keeps its defaults.
    const { displayAlign, displayIndent } = output.options as {
      displayAlign: string;
      displayIndent: string;
    };
    breakWidth = width;
    if (width !== null)
      Object.assign(output.options, {
        displayAlign: "left",
        displayIndent: "0",
      });
    let node;
    try {
      node = document.convert(`\\${command}{${request.latex}}`, {
        display: request.display === "block",
        em: CANONICAL_FORMULA_FONT_SIZE,
        ex: CANONICAL_FORMULA_FONT_SIZE / 2,
        containerWidth: 4096,
      });
    } finally {
      breakWidth = null;
      Object.assign(output.options, { displayAlign, displayIndent });
    }
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
