// Inline controls for a Route's code view. They need the JSON grammar, so
// they live apart from the Route's value and parser, which the editor uses
// on startup; only the lazy code view imports this (#1673).
import type { CanvasPropertyField } from "./component-property-fields";
import { propertyCodeSpans } from "./component-property-code-assists";
import type { PropertyJsonEditorAdapter } from "./component-property-json-editor";
import { parseRoutePropertyCode } from "./route-property-code";

const fields: readonly CanvasPropertyField[] = [
  {
    path: "appearance.color",
    label: "Wire color",
    kind: "color",
    description: "",
  },
  {
    path: "display.visualAnnotation",
    label: "Rail label",
    kind: "boolean",
    description: "",
    help: "Show or hide the rail's name label without changing its Net.",
  },
  {
    path: "net.scope",
    label: "Net scope",
    kind: "choice",
    options: [
      { value: "local", label: "Local to Cell" },
      { value: "global", label: "Global across Cells" },
    ],
    description: "",
  },
  {
    path: "appearance.lineStyle",
    label: "Line style",
    kind: "choice",
    options: [
      { value: "solid", label: "Solid" },
      { value: "dashed", label: "Dashed" },
      { value: "dotted", label: "Dotted" },
    ],
    description: "",
  },
  {
    path: "appearance.directionArrow",
    label: "Direction arrow",
    kind: "choice",
    options: [
      { value: "none", label: "No arrow" },
      { value: "middle", label: "Arrow at middle" },
      { value: "end", label: "Arrow at end" },
    ],
    description: "",
  },
];

export function routePropertyCodeAdapter(
  powerRail = false,
): PropertyJsonEditorAdapter {
  const routeFields = powerRail
    ? fields.map((field) =>
        field.path === "net.scope"
          ? {
              ...field,
              label: "Connection",
              options: [
                { value: "local", label: "Cell Pin" },
                { value: "global", label: "Global" },
              ],
            }
          : field,
      )
    : fields;
  const spans = (source: string) =>
    propertyCodeSpans(source, undefined, routeFields);
  return {
    parse: parseRoutePropertyCode,
    spans,
    changes(source, values) {
      const ranges = spans(source);
      const changes = Object.entries(values).map(([path, value]) => {
        const matches = ranges.filter((span) => span.field.path === path);
        const span = matches.length === 1 ? matches[0] : undefined;
        return span
          ? { from: span.from, to: span.to, insert: JSON.stringify(value) }
          : null;
      });
      if (changes.some((change) => change === null)) return [];
      const sorted = changes
        .filter((change) => change !== null)
        .sort((left, right) => left.from - right.from);
      let candidate = source;
      for (const change of [...sorted].reverse())
        candidate =
          candidate.slice(0, change.from) +
          change.insert +
          candidate.slice(change.to);
      return parseRoutePropertyCode(candidate).ok ? sorted : [];
    },
  };
}
