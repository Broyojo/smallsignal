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

/** The parameters the netlist reads of each device class, in menu order. */
const READ: Record<string, readonly string[]> = {
  resistor: ["value"],
  capacitor: ["value"],
  inductor: ["value"],
  "voltage-source": ["dc"],
  "current-source": ["dc"],
  vcvs: ["gain"],
  vccs: ["gm"],
  cccs: ["gain"],
  ccvs: ["rm"],
  mos: ["w", "l", "m"],
  bjt: ["area", "m"],
  diode: ["area", "m"],
};

const LABEL: Record<string, string> = {
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

/** A bare W or L is microns here, not metres; M and area have none. */
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

/**
 * The part's editable values: those the netlist reads of its class, the
 * descriptor's label, unit and placeholder where it has the parameter.
 */
export function partFields(
  project: CircuitProject,
  documentId: string | undefined,
  instanceId: string,
): PartField[] {
  const instance = instanceIn(project, documentId, instanceId);
  if (!instance?.netlist) return [];
  const descriptor = deviceDescriptor(instance.symbolId, project);
  const drawn = instance.netlist.parameters;
  return (READ[descriptor?.deviceClass ?? ""] ?? []).map((name) => {
    const parameter = descriptor?.parameters.find((item) => item.name === name);
    return {
      name,
      label: LABEL[name] ?? name,
      unit: NO_UNIT.has(name)
        ? ""
        : (UNIT[parameter?.unitHint ?? ""] ?? parameter?.unitHint ?? ""),
      value: drawn[name] ?? "",
      // Area and M default to one device.
      placeholder:
        parameter?.placeholder ??
        parameter?.defaultValue ??
        (name === "area" || name === "m" ? "1" : ""),
      required: parameter?.required ?? false,
    };
  });
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
