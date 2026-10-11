import { z } from "zod";
import {
  FORMULA_MAX_LATEX_LENGTH,
  validateFormulaSource,
} from "@icm/math-typesetting/profile";

export type RichTextStyle =
  | "italic"
  | "bold"
  | "subscript"
  | "superscript"
  | "overbar"
  | "lowercase"
  | "uppercase";

export type RichTextRun =
  | { kind: "text"; value: string }
  | { kind: "line-break" }
  | {
      kind: "math";
      latex: string;
      display: "inline" | "block";
    }
  | { kind: "span"; style: RichTextStyle; children: RichTextRun[] }
  | {
      kind: "fraction";
      numerator: RichTextDocument;
      denominator: RichTextDocument;
    };

export interface RichTextDocument {
  runs: RichTextRun[];
}

const RICH_TEXT_MAX_DEPTH = 4;
const RICH_TEXT_MAX_RUNS = 64;
const RICH_TEXT_MAX_TEXT_LENGTH = 256;

const textRunSchema = z.strictObject({
  kind: z.literal("text"),
  value: z.string().min(1).max(RICH_TEXT_MAX_TEXT_LENGTH),
});
const lineBreakRunSchema = z.strictObject({ kind: z.literal("line-break") });
const mathRunSchema = z.strictObject({
  kind: z.literal("math"),
  latex: z
    .string()
    .trim()
    .min(1)
    .max(FORMULA_MAX_LATEX_LENGTH)
    .superRefine((latex, context) => {
      const diagnostic = validateFormulaSource(latex);
      if (diagnostic) {
        context.addIssue({ code: "custom", message: diagnostic.message });
      }
    }),
  display: z.enum(["inline", "block"]),
});

// Each (depth, allowMath) schema is built once and shared by every branch that
// reaches it: rebuilding it per branch made 121 nested unions at module load,
// in every worker, where nine are distinct (#1645).
const runSchemas = new Map<string, z.ZodTypeAny>();
const documentSchemas = new Map<number, z.ZodTypeAny>();

function richTextRunSchema(depth: number, allowMath: boolean): z.ZodTypeAny {
  const key = `${depth}:${allowMath}`;
  const built = runSchemas.get(key);
  if (built) return built;
  const leafSchemas = allowMath
    ? [textRunSchema, lineBreakRunSchema, mathRunSchema]
    : [textRunSchema, lineBreakRunSchema];
  const schema =
    depth >= RICH_TEXT_MAX_DEPTH
      ? z.union(leafSchemas)
      : z.union([
          ...leafSchemas,
          z.strictObject({
            kind: z.literal("span"),
            style: z.enum([
              "italic",
              "bold",
              "subscript",
              "superscript",
              "overbar",
              "lowercase",
              "uppercase",
            ]),
            children: z
              .array(richTextRunSchema(depth + 1, false))
              .min(1)
              .max(RICH_TEXT_MAX_RUNS),
          }),
          z.strictObject({
            kind: z.literal("fraction"),
            numerator: richTextDocumentSchema(depth + 1),
            denominator: richTextDocumentSchema(depth + 1),
          }),
        ]);
  runSchemas.set(key, schema);
  return schema;
}

function richTextDocumentSchema(depth: number): z.ZodTypeAny {
  const built = documentSchemas.get(depth);
  if (built) return built;
  const schema = z
    .strictObject({
      runs: z
        .array(richTextRunSchema(depth, true))
        .min(1)
        .max(RICH_TEXT_MAX_RUNS),
    })
    .superRefine((document, context) => {
      if (
        document.runs.some(
          (run) => (run as { kind?: string }).kind === "math",
        ) &&
        document.runs.length !== 1
      ) {
        context.addIssue({
          code: "custom",
          message: "A formula is one atomic RichText document.",
          path: ["runs"],
        });
      }
    });
  documentSchemas.set(depth, schema);
  return schema;
}

export const RichTextDocumentSchema = richTextDocumentSchema(
  0,
) as z.ZodType<RichTextDocument>;
