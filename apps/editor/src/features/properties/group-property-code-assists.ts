// Inline controls for a group's code view. They need the JSON grammar, so
// they live apart from the group's values and parser, which the editor uses
// on startup; only the lazy code view imports this (#1673).
import { CANVAS_PROPERTY_FIELDS } from "./component-property-fields";
import {
  propertyCodeSpans,
  type PropertyCodeSpan,
} from "./component-property-code-assists";
import {
  parseGroupPropertyCode,
  type GroupPropertyCodeContext,
} from "./group-property-code";

/** Inline controls patch only their own valid JSON value. */
export function groupPropertyCodeChanges(
  source: string,
  context: GroupPropertyCodeContext,
  values: Readonly<Record<string, unknown>>,
): readonly { from: number; to: number; insert: string }[] {
  try {
    JSON.parse(source);
  } catch {
    return [];
  }
  const spans = groupPropertyCodeSpans(source, context);
  const changes = Object.entries(values).map(([path, value]) => {
    const matches = spans.filter((item) => item.field.path === path);
    const span = matches.length === 1 ? matches[0] : undefined;
    return span
      ? { from: span.from, to: span.to, insert: JSON.stringify(value) }
      : null;
  });
  if (changes.some((change) => change === null)) return [];
  let candidate = source;
  for (const change of changes
    .filter((item) => item !== null)
    .sort((a, b) => b.from - a.from))
    candidate =
      candidate.slice(0, change.from) +
      change.insert +
      candidate.slice(change.to);
  return parseGroupPropertyCode(candidate, context).ok
    ? changes.filter((item) => item !== null).sort((a, b) => a.from - b.from)
    : [];
}

export function groupPropertyCodeSpans(
  source: string,
  context: GroupPropertyCodeContext,
): PropertyCodeSpan[] {
  const fields = [
    ...CANVAS_PROPERTY_FIELDS,
    ...(context.parameterFields ?? []).map((field) => ({
      path: `parameters.${field.key}`,
      label: field.label,
      kind: field.options ? ("choice" as const) : ("text" as const),
      ...(field.options ? { options: field.options } : {}),
      description: field.unit ?? "",
    })),
  ];
  // Where components differ, each has its own entry and its own control;
  // the dictionary that holds them has none.
  const perItem = fields.filter(
    (field) =>
      field.path === "display.visualAnnotation" ||
      field.path === "display.value" ||
      field.path === "appearance.color" ||
      field.path.startsWith("parameters."),
  );
  const perItemFields = perItem.flatMap((field) =>
    (context.items ?? []).map((item) => ({
      ...field,
      path: `${field.path}.${item.key}`,
      label: `${field.label} · ${item.key}`,
    })),
  );
  const dictionaries = new Set(perItem.map((field) => field.path));
  return propertyCodeSpans(source, undefined, [
    ...fields,
    ...perItemFields,
  ]).filter(
    (span) =>
      !(
        dictionaries.has(span.field.path) &&
        typeof span.value === "object" &&
        span.value !== null &&
        !Array.isArray(span.value)
      ),
  );
}
