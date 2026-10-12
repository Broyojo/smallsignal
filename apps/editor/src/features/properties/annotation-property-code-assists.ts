// Inline controls for an annotation's or drawing's code view. They need the
// JSON grammar, so they live apart from the values and parsers the editor
// uses on startup; only the lazy property views import this (#1673).
import {
  ROTATION_OPTIONS,
  MIRROR_OPTIONS,
  type CanvasPropertyField,
} from "./component-property-fields";
import { propertyCodeSpans } from "./component-property-code-assists";
import type { PropertyJsonEditorAdapter } from "./component-property-json-editor";
import type { PropertyResult } from "./annotation-property-code";

export function annotationPropertyAdapter<T>(
  parseCode: (source: string) => PropertyResult<T>,
  closed: boolean,
  colorLabel = closed ? "Border" : "Text",
): PropertyJsonEditorAdapter {
  const fields: CanvasPropertyField[] = [
    {
      path: "appearance.color",
      label: colorLabel,
      kind: "color",
      description: "",
    },
    {
      path: "appearance.fillColor",
      label: "Fill",
      kind: "color",
      description: "",
    },
    {
      path: "placement.rotation",
      label: "Rotation",
      kind: "choice",
      options: ROTATION_OPTIONS,
      description: "",
      help: "Clockwise angle: 0° right, 90° down. Choose a common angle or type a custom angle in the code. Text uses 45° steps.",
    },
    {
      path: "placement.mirror",
      label: "Mirror",
      kind: "choice",
      options: MIRROR_OPTIONS,
      description: "",
    },
    {
      path: "appearance.lineStyle",
      label: "Line style",
      kind: "choice",
      options: [
        { value: "solid", label: "Solid — continuous line" },
        { value: "dashed", label: "Dashed — short dashes" },
        { value: "dotted", label: "Dotted — dots" },
      ],
      description: "",
    },
    {
      path: "appearance.arrowShape",
      label: "Arrow shape",
      kind: "choice",
      options: [
        { value: "line", label: "Line" },
        { value: "outline", label: "Outline" },
      ],
      description: "",
      help: "Outline arrows require a straight path. Endpoint styles are controlled independently below.",
    },
    ...(["start", "end"] as const).map((end) => ({
      path: `appearance.${end}Style`,
      label: end === "start" ? "Start style" : "End style",
      kind: "choice" as const,
      options: [
        { value: "small-arrow", label: "Small arrow" },
        { value: "medium-arrow", label: "Medium arrow" },
        { value: "large-arrow", label: "Large arrow" },
        { value: "dot", label: "Dot" },
        { value: "none", label: "None" },
        { value: "open-arrow", label: "Open arrow" },
      ],
      description: "",
      help: `${end === "start" ? "First" : "Last"} endpoint of the drawn path; stays with that endpoint when rotated or mirrored.`,
    })),
    {
      path: "stacking.layer",
      label: "Layer",
      kind: "choice",
      options: [
        { value: "front", label: "Front — in front of the circuit" },
        { value: "back", label: "Back — behind the circuit" },
      ],
      description: "",
    },
    {
      path: "appearance.alignment",
      label: "Text alignment",
      kind: "choice",
      options: [
        { value: "start", label: "Start — left" },
        { value: "middle", label: "Middle — centered" },
        { value: "end", label: "End — right" },
      ],
      description: "",
    },
    {
      path: "appearance.weight",
      label: "Text weight",
      kind: "choice",
      options: [
        { value: "normal", label: "Normal" },
        { value: "bold", label: "Bold" },
      ],
      description: "",
    },
    ...[
      {
        path: "geometry.closed",
        label: "Closed path",
        on: "Closed",
        off: "Open",
      },
      {
        path: "appearance.italic",
        label: "Italic",
        on: "Italic",
        off: "Upright",
      },
      {
        path: "display.visible",
        label: "Visibility",
        on: "Visible",
        off: "Hidden",
      },
      { path: "locked", label: "Lock", on: "Locked", off: "Unlocked" },
    ].map(({ path, label, on, off }): CanvasPropertyField => ({
      path,
      label,
      kind: "choice",
      description: "",
      options: [
        { value: false, label: off },
        { value: true, label: on },
      ],
    })),
  ];
  const spans = (source: string) =>
    propertyCodeSpans(source, undefined, fields);
  return {
    parse: parseCode,
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
      if (changes.some((change) => !change)) return [];
      const sorted = changes
        .filter((change) => change !== null)
        .sort((a, b) => a.from - b.from);
      let candidate = source;
      for (const change of [...sorted].reverse())
        candidate =
          candidate.slice(0, change.from) +
          change.insert +
          candidate.slice(change.to);
      return parseCode(candidate).ok ? sorted : [];
    },
  };
}
