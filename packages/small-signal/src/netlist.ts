import type { CircuitProject } from "@icm/model";
import {
  analyzeDesignNetlistForAuthoring,
  type DesignNetlistCell,
  type DesignNetlistIR,
  type DesignNetlistInstance,
} from "@icm/netlist";

/**
 * Level-1 stand-ins for every transistor and diode, whatever process model
 * the drawing names: the solver linearizes square-law and exponential
 * devices, not BSIM or PDK subcircuits. A drawing's own W and L are kept.
 */
export const SMALL_SIGNAL_MODEL_CARDS = {
  nmos: ".model nmos_l1 NMOS (LEVEL=1 KP=200u VTO=0.5 LAMBDA=0.05)",
  pmos: ".model pmos_l1 PMOS (LEVEL=1 KP=100u VTO=-0.5 LAMBDA=0.05)",
  npn: ".model npn_l1 NPN (IS=1e-15 BF=100 VAF=50)",
  pnp: ".model pnp_l1 PNP (IS=1e-15 BF=50 VAF=50)",
  diode: ".model diode_l1 D (IS=1e-14 N=1)",
} as const;
type ModelKind = keyof typeof SMALL_SIGNAL_MODEL_CARDS;

export interface SmallSignalSource {
  name: string;
  kind: "voltage" | "current";
  nodes: [string, string];
}

export interface SmallSignalNetlist {
  /** The flat solver netlist (contract dialect, ground `0`). */
  text: string;
  /** Every node the netlist names, ground first. */
  nets: string[];
  /** Independent sources the analysis can use as its input. */
  sources: SmallSignalSource[];
  /** Element values the drawing does not state, written without a value. */
  missing: string[];
  /** What the translation changed or left out, for the panel to show. */
  notes: string[];
}

const LETTER: Partial<Record<DesignNetlistInstance["deviceClass"], string>> = {
  resistor: "R",
  capacitor: "C",
  inductor: "L",
  "voltage-source": "V",
  "current-source": "I",
  vcvs: "E",
  vccs: "G",
  cccs: "F",
  ccvs: "H",
  mos: "M",
  bjt: "Q",
  diode: "D",
};

/** The device a library symbol draws, for process-bound (`X…`) cards. */
function modelKindOfSymbol(symbolId: string | undefined): ModelKind | null {
  if (!symbolId) return null;
  if (/pmos|pfet/u.test(symbolId)) return "pmos";
  if (/nmos|nfet|ndmos/u.test(symbolId)) return "nmos";
  if (/pnp/u.test(symbolId)) return "pnp";
  if (/npn/u.test(symbolId)) return "npn";
  if (/diode|zener/u.test(symbolId)) return "diode";
  return null;
}

/** The behavioral ideal op-amp's own default open-loop gain. */
const IDEAL_OPAMP_GAIN = "1e6";

function parameter(
  instance: DesignNetlistInstance,
  scope: ReadonlyMap<string, string>,
  ...names: string[]
): string | undefined {
  const wanted = names.map((name) => name.toLowerCase());
  const found = instance.parameters.find((item) =>
    wanted.includes(item.name.toLowerCase()),
  );
  let value = found?.rawValue.trim();
  // A child Cell's `{gain}` is its caller's value or the Cell's default.
  const formal = value?.match(/^\{\s*([A-Za-z_]\w*)\s*\}$/u)?.[1];
  if (formal) value = scope.get(formal.toLowerCase());
  return value ? value : undefined;
}

/** Bare numbers are microns in every process this editor binds. */
function micron(value: string): string {
  return /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/iu.test(value)
    ? `${value}u`
    : value;
}

/** SPICE identifiers: the drawing's names may carry characters SPICE splits on. */
function identifier(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/gu, "_");
}

/**
 * Translate the drawing into the solver's netlist: hierarchy flattened
 * (a child Cell's nets and parts are suffixed with the calling instance),
 * every transistor and diode bound to a level-1 card.
 */
export function smallSignalNetlist(
  project: CircuitProject,
  options: { rootDocumentId?: string } = {},
): SmallSignalNetlist | null {
  const analysis = analyzeDesignNetlistForAuthoring(project, {
    format: "spice",
    rootAsTopLevel: true,
    groundPin: "global",
    ...(options.rootDocumentId
      ? { rootDocumentId: options.rootDocumentId }
      : {}),
  });
  const ir = analysis.ir;
  if (!ir) return null;
  return translate(project, ir);
}

function translate(
  project: CircuitProject,
  ir: DesignNetlistIR,
): SmallSignalNetlist {
  const cellsByName = new Map(ir.cells.map((cell) => [cell.name, cell]));
  const behavioral = new Set(
    (ir.generatedDefinitions ?? [])
      .filter((definition) => definition.kind === "behavioral")
      .map((definition) => definition.name),
  );
  const top = ir.cells.find((cell) => cell.id === ir.topCellId);
  const lines: string[] = [];
  const nets = new Set<string>(["0"]);
  const sources: SmallSignalSource[] = [];
  const missing: string[] = [];
  const notes: string[] = [];
  const usedModels = new Set<ModelKind>();
  const usedNames = new Set<string>();
  let floating = 0;

  const symbolOf = (cell: DesignNetlistCell, id: string) =>
    (
      project.documents
        .find((document) => document.id === cell.id)
        ?.instances.find((instance) => instance.id === id) as
        { symbolId?: string } | undefined
    )?.symbolId;

  function uniqueName(letter: string, reference: string, suffix: string) {
    const body = identifier(reference.replace(/^X(?=[A-Za-z])/iu, ""));
    let name = body.toUpperCase().startsWith(letter) ? body : letter + body;
    if (suffix) name += `_${suffix}`;
    let unique = name;
    for (let n = 2; usedNames.has(unique.toLowerCase()); n += 1)
      unique = `${name}_${n}`;
    usedNames.add(unique.toLowerCase());
    return unique;
  }

  function emitCell(
    cell: DesignNetlistCell,
    suffix: string,
    portNets: Map<string, string>,
    scope: ReadonlyMap<string, string>,
    depth: number,
  ) {
    const globals = new Set([
      ...ir.globals,
      ...cell.nets.filter((net) => net.scope === "global").map((n) => n.name),
    ]);
    const net = (name: string) => {
      if (name.startsWith("<unconnected:")) {
        floating += 1;
        return `nc${floating}`;
      }
      const mapped = portNets.get(name);
      if (mapped) return mapped;
      if (name === "0" || globals.has(name)) return identifier(name);
      return identifier(suffix ? `${name}_${suffix}` : name);
    };
    // F/H name their controlling source by its reference in this Cell.
    const renamed = new Map<string, string>();
    const deferred: Array<() => void> = [];

    for (const instance of cell.instances) {
      const nodes = instance.nodes.map((node) => net(node.netName));
      nodes.forEach((node) => nets.add(node));
      const label = `${instance.reference}${suffix ? ` in ${suffix}` : ""}`;

      const child =
        instance.deviceClass === "hierarchical" && instance.target
          ? cellsByName.get(instance.target)
          : undefined;
      if (child) {
        if (depth > 32) {
          notes.push(`${label}: hierarchy too deep, left out`);
          continue;
        }
        const childPorts = new Map<string, string>();
        instance.nodes.forEach((node, index) => {
          const port = child.ports.find((item) => item.name === node.pinName);
          const outer = nodes[index];
          if (port && outer) childPorts.set(port.netName, outer);
        });
        const childSuffix = identifier(
          [instance.reference.replace(/^X/iu, ""), suffix]
            .filter(Boolean)
            .join("_"),
        );
        const childScope = new Map<string, string>();
        for (const formal of child.formalParameters ?? [])
          if (formal.defaultValue !== undefined)
            childScope.set(formal.name.toLowerCase(), formal.defaultValue);
        for (const actual of instance.parameters) {
          const value = parameter(instance, scope, actual.name);
          if (value) childScope.set(actual.name.toLowerCase(), value);
        }
        emitCell(child, childSuffix, childPorts, childScope, depth + 1);
        continue;
      }

      // The behavioral ideal op-amp clips at its rails; small-signal it is
      // its linear core, a VCVS of open-loop gain A.
      if (
        instance.deviceClass === "hierarchical" &&
        instance.target &&
        behavioral.has(instance.target) &&
        /opamp/iu.test(instance.target)
      ) {
        const pin = (name: string) => {
          const index = instance.nodes.findIndex(
            (node) => node.pinName === name,
          );
          return index < 0 ? undefined : nodes[index];
        };
        const [out, plus, minus] = [pin("VOUT"), pin("VIP"), pin("VIN")];
        if (!out || !plus || !minus) {
          notes.push(
            `${label}: only single-ended op-amps are modeled, left out`,
          );
          continue;
        }
        const name = uniqueName("E", instance.reference, suffix);
        renamed.set(instance.reference, name);
        const gain = parameter(instance, scope, "gain");
        if (!gain)
          notes.push(
            `${name}: ideal op-amp as a VCVS of gain ${IDEAL_OPAMP_GAIN}`,
          );
        lines.push(
          `${name} ${out} 0 ${plus} ${minus} ${gain ?? IDEAL_OPAMP_GAIN}`,
        );
        continue;
      }

      const kind: ModelKind | null =
        instance.deviceClass === "mos" ||
        instance.deviceClass === "bjt" ||
        instance.deviceClass === "diode" ||
        instance.deviceClass === "hierarchical"
          ? (modelKindOfSymbol(symbolOf(cell, instance.id)) ??
            (instance.deviceClass === "diode" ? "diode" : null))
          : null;
      const letter =
        kind === "nmos" || kind === "pmos"
          ? "M"
          : kind === "npn" || kind === "pnp"
            ? "Q"
            : kind === "diode"
              ? "D"
              : LETTER[instance.deviceClass];
      if (!letter || (instance.deviceClass === "hierarchical" && !kind)) {
        if (instance.deviceClass !== "net-marker")
          notes.push(
            `${label}: ${instance.target ?? instance.deviceClass} has no small-signal model, left out`,
          );
        continue;
      }
      const name = uniqueName(letter, instance.reference, suffix);
      renamed.set(instance.reference, name);
      const card = [name, ...nodes];
      const value = (...names: string[]) => {
        const found = parameter(instance, scope, ...names);
        if (!found) missing.push(name);
        return found;
      };

      switch (letter) {
        case "R":
        case "C":
        case "L": {
          const found = value("value");
          if (found) card.push(found);
          break;
        }
        case "V":
        case "I": {
          const dc = parameter(instance, scope, "dc", "offset");
          card.push("DC", dc ?? "0");
          const ac = parameter(instance, scope, "acMagnitude");
          if (ac) card.push("AC", ac);
          sources.push({
            name,
            kind: letter === "V" ? "voltage" : "current",
            nodes: [nodes[0] ?? "0", nodes[1] ?? "0"],
          });
          break;
        }
        case "E":
        case "G": {
          const found = value(letter === "G" ? "gm" : "gain");
          if (found) card.push(found);
          break;
        }
        case "F":
        case "H": {
          deferred.push(() => {
            const control = instance.controlSourceReference
              ? renamed.get(instance.controlSourceReference)
              : undefined;
            if (!control) {
              notes.push(`${label}: controlling source not found, left out`);
              return;
            }
            const gain = parameter(
              instance,
              scope,
              letter === "H" ? "rm" : "gain",
            );
            if (!gain) missing.push(name);
            lines.push([...card, control, ...(gain ? [gain] : [])].join(" "));
          });
          continue;
        }
        case "M": {
          const model = kind as "nmos" | "pmos";
          usedModels.add(model);
          const w = parameter(instance, scope, "w");
          const l = parameter(instance, scope, "l");
          if (!w || !l)
            notes.push(
              `${name}: no W/L drawn, sized W=L=1u for the bias point`,
            );
          card.push(
            `${model}_l1`,
            `W=${micron(w ?? "1")}`,
            `L=${micron(l ?? "1")}`,
          );
          const m = parameter(instance, scope, "m", "mult");
          if (m) card.push(`M=${m}`);
          break;
        }
        case "Q":
        case "D": {
          const model = kind ?? "diode";
          usedModels.add(model);
          card.push(`${model}_l1`);
          const area = parameter(instance, scope, "area");
          if (area) card.push(area);
          break;
        }
      }
      lines.push(card.join(" "));
    }
    deferred.forEach((emit) => emit());
  }

  if (top) emitCell(top, "", new Map(), new Map(), 0);
  if (floating)
    notes.push(
      `${floating} unconnected pin${floating === 1 ? "" : "s"} left floating`,
    );
  if (missing.length)
    notes.push(`No value drawn for ${missing.join(", ")}: kept symbolic`);

  const models = [...usedModels].map((kind) => SMALL_SIGNAL_MODEL_CARDS[kind]);
  const text = [
    `* ${top?.name ?? "circuit"} (small-signal netlist from Analog Canvas)`,
    ...lines,
    ...models,
    ".end",
    "",
  ].join("\n");
  const sortedNets = [...nets].filter((n) => n !== "0").sort();
  return {
    text,
    nets: ["0", ...sortedNets],
    sources,
    missing,
    notes,
  };
}
