import { deviceDescriptor } from "@icm/devices";
import type { CircuitProject } from "@icm/model";

// A drawn part's values where the part is drawn: the few parameters the
// small-signal netlist reads, edited in the part's menu instead of the
// Properties code.

export interface PartField {
  /** The parameter, "value", "dc", "w". */
  name: string;
  /** "Value", "DC", "W". */
  label: string;
  /** "Ω", "V"; empty where a bare number is not in base units. */
  unit: string;
  /** As drawn; empty when unset. */
  value: string;
  placeholder: string;
  required: boolean;
}

/** The parameters the netlist reads, in menu order, with short labels. */
const READ: Record<string, string> = {
  value: "Value",
  dc: "DC",
  w: "W",
  l: "L",
  m: "M",
  area: "Area",
  gain: "Gain",
  gm: "gm",
  rm: "rm",
};

/** W and L: a bare number is microns here, not metres. */
const NO_UNIT = new Set(["w", "l", "m", "area"]);

const UNIT: Record<string, string> = { Ohm: "Ω", ohm: "Ω" };

type Instance = CircuitProject["documents"][number]["instances"][number];

function instanceIn(
  project: CircuitProject,
  documentId: string | undefined,
  instanceId: string,
): Instance | undefined {
  const document =
    project.documents.find((item) => item.id === documentId) ??
    project.documents[0];
  return document?.instances.find((item) => item.id === instanceId);
}

/** The part's editable values, empty for a part with none. */
export function partFields(
  project: CircuitProject,
  documentId: string | undefined,
  instanceId: string,
): PartField[] {
  const instance = instanceIn(project, documentId, instanceId);
  if (!instance?.netlist) return [];
  const descriptor = deviceDescriptor(instance.symbolId, project);
  const drawn = instance.netlist.parameters;
  return (descriptor?.parameters ?? [])
    .filter((parameter) => parameter.name in READ)
    .sort(
      (a, b) =>
        Object.keys(READ).indexOf(a.name) - Object.keys(READ).indexOf(b.name),
    )
    .map((parameter) => ({
      name: parameter.name,
      label: READ[parameter.name] ?? parameter.label,
      unit: NO_UNIT.has(parameter.name)
        ? ""
        : (UNIT[parameter.unitHint ?? ""] ?? parameter.unitHint ?? ""),
      value: drawn[parameter.name] ?? "",
      placeholder: parameter.placeholder ?? parameter.defaultValue ?? "",
      required: parameter.required,
    }));
}

/** A Cell parameter, `{gain}`, passes as written. */
const EXPRESSION = /^\{\s*[A-Za-z_]\w*\s*\}$/u;

/**
 * The edit a typed value makes: set it, clear it (an optional one left
 * empty), or none (unchanged, or not a number the solver reads).
 */
export function fieldEdit(
  field: PartField,
  text: string,
  readable: (text: string) => boolean,
): { set: Record<string, string> } | { unset: string[] } | null {
  const value = text.trim();
  if (value === field.value.trim()) return null;
  if (!value) return field.required ? null : { unset: [field.name] };
  if (!EXPRESSION.test(value) && !readable(value)) return null;
  return { set: { [field.name]: value } };
}
