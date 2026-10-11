import { describe, expect, it } from "vitest";
import type { z } from "zod";

import {
  flattenRichText,
  normalizeRichText,
  rewriteRichTextPlainText,
  rewriteRichTextContent,
} from "./rich-text.js";
import { RichTextDocumentSchema } from "./schema.js";
import type { RichTextDocument } from "./schema.js";

describe("canonical RichText helpers", () => {
  it("replaces multiline prose without dropping spans or modifying its source", () => {
    const original: RichTextDocument = {
      runs: [
        {
          kind: "span",
          style: "italic",
          children: [
            {
              kind: "span",
              style: "bold",
              children: [{ kind: "text", value: "输入 A" }],
            },
          ],
        },
        { kind: "line-break" },
        { kind: "text", value: "plain" },
      ],
    };
    const before = structuredClone(original);
    const updated = rewriteRichTextContent(original, "输入 B\nplain");
    expect(updated).toEqual({
      runs: [
        {
          kind: "span",
          style: "italic",
          children: [
            {
              kind: "span",
              style: "bold",
              children: [{ kind: "text", value: "输入 B" }],
            },
          ],
        },
        { kind: "line-break" },
        { kind: "text", value: "plain" },
      ],
    });
    expect(original).toEqual(before);
    expect(rewriteRichTextContent(original, flattenRichText(original))).toBe(
      original,
    );
    expect(rewriteRichTextContent(original, "")).toEqual({
      runs: [{ kind: "line-break" }],
    });
  });
  it("normalizes nested spans and flattens retained formatting", () => {
    const content: RichTextDocument = {
      runs: [
        { kind: "text", value: "V" },
        { kind: "text", value: "" },
        {
          kind: "span",
          style: "subscript",
          children: [
            { kind: "text", value: "D" },
            { kind: "text", value: "D" },
          ],
        },
        { kind: "line-break" },
        {
          kind: "span",
          style: "superscript",
          children: [{ kind: "text", value: "+" }],
        },
      ],
    };

    const normalized = normalizeRichText(content);
    expect(normalized.runs[1]).toEqual({
      kind: "span",
      style: "subscript",
      children: [{ kind: "text", value: "DD" }],
    });
    expect(flattenRichText(normalized)).toBe("VDD\n+");
    expect(RichTextDocumentSchema.safeParse(normalized).success).toBe(true);
  });

  it("accepts the restored fraction node and flattens it with a slash", () => {
    const content: RichTextDocument = {
      runs: [
        {
          kind: "span",
          style: "bold",
          children: [
            {
              kind: "fraction",
              numerator: { runs: [{ kind: "text", value: "10um" }] },
              denominator: { runs: [{ kind: "text", value: "150nm" }] },
            },
          ],
        },
      ],
    };
    expect(RichTextDocumentSchema.safeParse(content).success).toBe(true);
    expect(flattenRichText(content)).toBe("10um/150nm");
    expect(flattenRichText(normalizeRichText(content))).toBe("10um/150nm");
  });

  it("bounds nesting at four levels and keeps formulas out of spans", () => {
    const text = { kind: "text", value: "x" };
    const span = (child: unknown, levels: number): unknown =>
      levels === 0
        ? child
        : {
            kind: "span",
            style: "bold",
            children: [span(child, levels - 1)],
          };
    const fraction = (inner: unknown, levels: number): unknown =>
      levels === 0
        ? inner
        : {
            kind: "fraction",
            numerator: { runs: [fraction(inner, levels - 1)] },
            denominator: { runs: [text] },
          };
    const math = { kind: "math", latex: "V", display: "inline" };
    const accepts = (run: unknown) =>
      RichTextDocumentSchema.safeParse({ runs: [run] }).success;

    expect(accepts(span(text, 4))).toBe(true);
    expect(accepts(span(text, 5))).toBe(false);
    expect(accepts(fraction(text, 4))).toBe(true);
    expect(accepts(fraction(text, 5))).toBe(false);
    expect(accepts(fraction(span(text, 1), 3))).toBe(true);
    expect(accepts(fraction(span(text, 1), 4))).toBe(false);
    // A formula is a whole document: inside a fraction side, never a span.
    expect(accepts(fraction(math, 4))).toBe(true);
    expect(accepts(span(math, 1))).toBe(false);
    expect(accepts(fraction(span(math, 1), 1))).toBe(false);
  });

  it("builds one run schema per nesting level and formula permission", () => {
    // Rebuilding the recursive schema per branch made 121 nested unions at
    // module load where nine are distinct (#1645).
    const unions = new Set<unknown>();
    const seen = new Set<unknown>();
    const visit = (schema: z.ZodType) => {
      if (seen.has(schema)) return;
      seen.add(schema);
      const def = (
        schema as unknown as {
          _zod: {
            def: {
              type: string;
              shape?: Record<string, z.ZodType>;
              element?: z.ZodType;
              options?: z.ZodType[];
            };
          };
        }
      )._zod.def;
      if (def.type === "union") unions.add(schema);
      Object.values(def.shape ?? {}).forEach(visit);
      if (def.element) visit(def.element);
      def.options?.forEach(visit);
    };
    visit(RichTextDocumentSchema);
    expect(unions.size).toBe(9);
  });

  it("rejects an empty fraction side", () => {
    expect(
      RichTextDocumentSchema.safeParse({
        runs: [
          {
            kind: "fraction",
            numerator: { runs: [{ kind: "text", value: "1" }] },
            denominator: { runs: [] },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("accepts an atomic formula without interpreting it as styled text", () => {
    const content: RichTextDocument = {
      runs: [
        {
          kind: "math",
          latex: String.raw`A_v=-g_m(r_o\parallel R_D)`,
          display: "inline",
        },
      ],
    };

    expect(RichTextDocumentSchema.safeParse(content).success).toBe(true);
    expect(flattenRichText(content)).toBe(
      String.raw`A_v=-g_m(r_o\parallel R_D)`,
    );
    expect(normalizeRichText(content)).toEqual(content);
  });

  it("rejects ambiguous mixed formula and styled-text documents", () => {
    expect(
      RichTextDocumentSchema.safeParse({
        runs: [
          { kind: "text", value: "Gain: " },
          { kind: "math", latex: "A_v", display: "inline" },
        ],
      }).success,
    ).toBe(false);
  });

  it("bounds formula source and requires an explicit display mode", () => {
    expect(
      RichTextDocumentSchema.safeParse({
        runs: [{ kind: "math", latex: "", display: "inline" }],
      }).success,
    ).toBe(false);
    expect(
      RichTextDocumentSchema.safeParse({
        runs: [{ kind: "math", latex: "V_{OUT}" }],
      }).success,
    ).toBe(false);
    expect(
      RichTextDocumentSchema.safeParse({
        runs: [
          {
            kind: "math",
            latex: String.raw`\href{https://example.com}{V}`,
            display: "inline",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rewrites a semantic name while preserving its independent RichText styles", () => {
    const content: RichTextDocument = {
      runs: [
        {
          kind: "span",
          style: "italic",
          children: [
            {
              kind: "span",
              style: "bold",
              children: [{ kind: "text", value: "M" }],
            },
          ],
        },
        {
          kind: "span",
          style: "subscript",
          children: [
            {
              kind: "span",
              style: "bold",
              children: [{ kind: "text", value: "15" }],
            },
          ],
        },
      ],
    };

    const rewritten = rewriteRichTextPlainText(content, "M21");

    expect(flattenRichText(rewritten)).toBe("M21");
    expect(rewritten).toEqual({
      runs: [
        {
          kind: "span",
          style: "italic",
          children: [
            {
              kind: "span",
              style: "bold",
              children: [{ kind: "text", value: "M" }],
            },
          ],
        },
        {
          kind: "span",
          style: "subscript",
          children: [
            {
              kind: "span",
              style: "bold",
              children: [{ kind: "text", value: "21" }],
            },
          ],
        },
      ],
    });
    expect(RichTextDocumentSchema.safeParse(rewritten).success).toBe(true);
  });
});
