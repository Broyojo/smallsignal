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
/**
 * Charge parameters, ngspice's defaults: none of them adds a capacitance
 * until set (TOX = 0 means no Meyer gate capacitances, CBD = CBS = 0 means
 * CJ·AD and CJ·AS instead). A card writes them only when they differ.
 */
const MOS_CAPACITANCES = {
  TOX: 0,
  CGSO: 0,
  CGDO: 0,
  CGBO: 0,
  CJ: 0,
  MJ: 0.5,
  CJSW: 0,
  MJSW: 0.5,
  PB: 0.8,
  FC: 0.5,
  CBD: 0,
  CBS: 0,
};
const BJT_CAPACITANCES = {
  CJE: 0,
  VJE: 0.75,
  MJE: 0.33,
  CJC: 0,
  VJC: 0.75,
  MJC: 0.33,
  XCJC: 1,
  CJS: 0,
  TF: 0,
  FC: 0.5,
};
const DIODE_CAPACITANCES = { CJO: 0, VJ: 1, M: 0.5, TT: 0, FC: 0.5 };

/** The charge parameters of each kind (the Models panel's Capacitances). */
export const CAPACITANCE_PARAMETERS: Readonly<
  Record<"nmos" | "pmos" | "npn" | "pnp" | "diode", readonly string[]>
> = {
  nmos: Object.keys(MOS_CAPACITANCES),
  pmos: Object.keys(MOS_CAPACITANCES),
  npn: Object.keys(BJT_CAPACITANCES),
  pnp: Object.keys(BJT_CAPACITANCES),
  diode: Object.keys(DIODE_CAPACITANCES),
};

export const DEFAULT_MODEL_PARAMETERS = {
  // KF and AF: flicker noise, off (KF = 0) unless set.
  nmos: {
    KP: 200e-6,
    VTO: 0.5,
    LAMBDA: 0.05,
    GAMMA: 0,
    PHI: 0.6,
    KF: 0,
    AF: 1,
    ...MOS_CAPACITANCES,
  },
  pmos: {
    KP: 100e-6,
    VTO: -0.5,
    LAMBDA: 0.05,
    GAMMA: 0,
    PHI: 0.6,
    KF: 0,
    AF: 1,
    ...MOS_CAPACITANCES,
  },
  npn: { IS: 1e-15, BF: 100, VAF: 50, KF: 0, AF: 1, ...BJT_CAPACITANCES },
  pnp: { IS: 1e-15, BF: 50, VAF: 50, KF: 0, AF: 1, ...BJT_CAPACITANCES },
  diode: { IS: 1e-14, N: 1, KF: 0, AF: 1, ...DIODE_CAPACITANCES },
} as const;
export type ModelKind = keyof typeof DEFAULT_MODEL_PARAMETERS;
/** The parameters a device kind's card lets a caller set. */
export type ModelParameter<K extends ModelKind> =
  keyof (typeof DEFAULT_MODEL_PARAMETERS)[K];
/** Overrides of the default parameters, per device kind. */
export type ModelOverrides = {
  readonly [K in ModelKind]?: Readonly<
    Partial<Record<ModelParameter<K>, number>>
  >;
};

const MODEL_CARD_HEAD: Record<ModelKind, string> = {
  nmos: ".model nmos_l1 NMOS (LEVEL=1",
  pmos: ".model pmos_l1 PMOS (LEVEL=1",
  npn: ".model npn_l1 NPN (",
  pnp: ".model pnp_l1 PNP (",
  diode: ".model diode_l1 D (",
};

/** The model card a device kind gets, defaults overridden by `overrides`. */
export function modelCard(kind: ModelKind, overrides: ModelOverrides = {}) {
  // Only the editable parameters, and only finite values: anything else
  // (LEVEL, a typo) never reaches the card.
  const params: Record<string, number> = { ...DEFAULT_MODEL_PARAMETERS[kind] };
  for (const [name, value] of Object.entries(overrides[kind] ?? {})) {
    if (name in params && typeof value === "number" && Number.isFinite(value))
      params[name] = value;
  }
  // Charge parameters at their default are left off: the card then reads
  // as before, and CBD = 0 would override CJ·AD in ngspice.
  const defaults: Record<string, number> = DEFAULT_MODEL_PARAMETERS[kind];
  const body = Object.entries(params)
    .filter(
      ([name, value]) =>
        !CAPACITANCE_PARAMETERS[kind].includes(name) ||
        value !== defaults[name],
    )
    .map(([name, value]) => `${name}=${value}`)
    .join(" ");
  const head = MODEL_CARD_HEAD[kind];
  return `${head}${head.endsWith("(") ? "" : " "}${body})`;
}

/** DC value for supply symbols (VDD, VDD Rail) that no source drives. */
export const DEFAULT_SUPPLY_VOLTAGE = 1.8;

/** Symbols that mark a supply: VDD Rail (a global Net) and VDD (a Cell Pin). */
const SUPPLY_SYMBOLS = new Set(["vdd", "vdd-port"]);

/** Undriven nets named like a positive supply rail. */
const SUPPLY_NAME = /^(a|d)?v(dd|cc|pp)[a-z0-9_]*$/iu;

/** Global rails held at 0 V rather than the supply voltage. */
const GROUND_RAIL = /^(v?ss|gnd|agnd|dgnd)/iu;

export interface SmallSignalSource {
  name: string;
  kind: "voltage" | "current";
  nodes: [string, string];
  /** DC value as drawn (the bias it sets), e.g. "0.7". */
  dc: string;
  /** Set for the source standing in for an undriven Pin, as that Pin's name. */
  pin?: string;
}

/** A drawn part as the solver names it. */
export interface SmallSignalElement {
  /** The netlist name, e.g. M1 (assumptions and results use it). */
  name: string;
  /**
   * Instance ids from the top Cell down to the part: stable when parts are
   * renamed, distinct for each placement of one child Cell.
   */
  instancePath: string[];
  kind: SmallSignalElementKind;
}

export type SmallSignalElementKind =
  | ModelKind
  | "resistor"
  | "capacitor"
  | "inductor"
  | "voltage-source"
  | "current-source"
  | "vcvs"
  | "vccs"
  | "cccs"
  | "ccvs";

const KIND_OF_LETTER: Record<string, SmallSignalElementKind> = {
  R: "resistor",
  C: "capacitor",
  L: "inductor",
  V: "voltage-source",
  I: "current-source",
  E: "vcvs",
  G: "vccs",
  F: "cccs",
  H: "ccvs",
};

export interface SmallSignalNetlist {
  /** The flat solver netlist (contract dialect, ground `0`). */
  text: string;
  /** Every drawn part in the netlist (not the sources added for supplies
   * and Pins). */
  elements: SmallSignalElement[];
  /** Every node the netlist names, ground first. */
  nets: string[];
  /** Independent sources the analysis can use as its input. */
  sources: SmallSignalSource[];
  /** Element values the drawing does not state, written without a value. */
  missing: string[];
  /** What the translation changed or left out, for the panel to show. */
  notes: string[];
  /** Supply nets drawn with a VDD symbol and driven by an added DC source. */
  supplies: string[];
  /** The DC each of `supplies` is held at: the supply voltage, or 0 V for
   * a ground-like rail (VSS, GND). */
  supplyVolts: Record<string, number>;
  /** Every supply rail the drawing marks (VDD symbols, supply and ground
   * rail nets), driven by an added source or a drawn one. */
  rails: string[];
  /**
   * Pins the drawing leaves unconnected, as `R1.1`. Touching parts are not
   * connected in Analog Canvas (only wires connect), and an open pin makes
   * any result meaningless, so the panel refuses to analyze until it is empty.
   */
  unconnected: string[];
  /**
   * Bias values the drawing does not give: sources without a DC value and
   * undriven Pins (inputs or bias nodes). Without them no operating point
   * exists, so the analysis is symbolic (transistors taken as saturated).
   */
  unknownBias: string[];
  /**
   * Nets nothing sets the voltage of: reached only by gates, capacitors or
   * current sources, with no Pin to drive them. There is no operating point,
   * so the panel refuses to analyze until they are connected or driven.
   */
  noDcPath: string[];
  /** Device kinds that use a level-1 model card (the editable ones). */
  models: ModelKind[];
  /**
   * The solver node of each pin drawn in the open Cell, by instance id then
   * pin name: where a node's DC voltage can be shown on the drawing.
   */
  terminals: Record<string, Record<string, string>>;
}

export interface SmallSignalNetlistOptions {
  rootDocumentId?: string;
  /** DC value for undriven supply symbols; defaults to 1.8 V. */
  supplyVoltage?: number;
  /** DC values for undriven Pins, by Pin name. */
  pinBias?: Readonly<Record<string, number>>;
  /** Model parameters replacing the level-1 defaults, per device kind. */
  models?: ModelOverrides;
}

/** Cell Pin symbols that may mark an input or a bias node. */
const PIN_SYMBOLS = new Set(["port", "port-filled"]);

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
/**
 * SPICE-safe names that never merge two different drawn names: `Vin+` and
 * `Vin−` must stay two nets (`Vinp`, `Vinn`), so a sanitized name already
 * taken by another original gets a suffix.
 */
export function createIdentifier(): (name: string) => string {
  const byOriginal = new Map<string, string>();
  const taken = new Set<string>();
  return (name: string) => {
    const known = byOriginal.get(name);
    if (known !== undefined) return known;
    const base = name
      .replace(/\+/gu, "p")
      .replace(/[-−]/gu, "n")
      .replace(/[^A-Za-z0-9_]/gu, "_");
    let id = base;
    for (let n = 2; taken.has(id.toLowerCase()); n += 1) id = `${base}_${n}`;
    byOriginal.set(name, id);
    taken.add(id.toLowerCase());
    return id;
  };
}

/**
 * Translate the drawing into the solver's netlist: hierarchy flattened
 * (a child Cell's nets and parts are suffixed with the calling instance),
 * every transistor and diode bound to a level-1 card.
 */
export function smallSignalNetlist(
  project: CircuitProject,
  options: SmallSignalNetlistOptions = {},
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
  return translate(
    project,
    ir,
    options.supplyVoltage ?? DEFAULT_SUPPLY_VOLTAGE,
    options.pinBias ?? {},
    options.models ?? {},
  );
}

/**
 * Pins that give their net a DC path (fix its voltage or conduct to it), by
 * element letter. A net reached only by gates, capacitors and current
 * sources has no DC path, so a Pin on it must be driven by something.
 */
const DC_PATH_PINS: Record<string, number[] | "all"> = {
  R: "all",
  L: "all",
  V: "all",
  D: "all",
  Q: "all",
  E: [0, 1],
  H: [0, 1],
  M: [0, 2],
};

function translate(
  project: CircuitProject,
  ir: DesignNetlistIR,
  supplyVoltage: number,
  pinBias: Readonly<Record<string, number>>,
  modelOverrides: ModelOverrides,
): SmallSignalNetlist {
  // Net and element names are separate SPICE namespaces.
  const identifier = createIdentifier();
  const partIdentifier = createIdentifier();
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
  const supplyNets = new Set<string>();
  const dcPath = new Set<string>();
  const unknownBias: string[] = [];
  const elements: SmallSignalElement[] = [];
  let floating = 0;
  const unconnected: string[] = [];
  const terminals: Record<string, Record<string, string>> = {};

  const symbolOf = (cell: DesignNetlistCell, id: string) =>
    (
      project.documents
        .find((document) => document.id === cell.id)
        ?.instances.find((instance) => instance.id === id) as
        { symbolId?: string } | undefined
    )?.symbolId;

  function uniqueName(letter: string, reference: string, suffix: string) {
    const body = partIdentifier(reference.replace(/^X(?=[A-Za-z])/iu, ""));
    const plain = body.toUpperCase().startsWith(letter) ? body : letter + body;
    // A part inside a placed Cell keeps its own name (M1, so g_{m1}) unless
    // that name is taken; only then does it carry the instance suffix.
    const name =
      suffix && usedNames.has(plain.toLowerCase())
        ? `${plain}_${suffix}`
        : plain;
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
    path: readonly string[],
  ) {
    const globals = new Set([
      ...ir.globals,
      ...cell.nets.filter((net) => net.scope === "global").map((n) => n.name),
    ]);
    const net = (name: string) => {
      // Supply symbols (VDD, VDD Rail) become global nets; they are driven
      // below if no source drives them.
      if (name !== "0" && globals.has(name)) supplyNets.add(identifier(name));
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
      const nodes = instance.nodes.map((node) => {
        if (node.netName.startsWith("<unconnected:"))
          unconnected.push(
            `${instance.reference}${suffix ? `_${suffix}` : ""}.${node.pinName}`,
          );
        return net(node.netName);
      });
      nodes.forEach((node) => nets.add(node));
      if (depth === 0)
        instance.nodes.forEach((node, index) => {
          const solved = nodes[index];
          if (solved && !/^nc\d+$/u.test(solved))
            (terminals[instance.id] ??= {})[node.pinName] = solved;
        });
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
        const childSuffix = partIdentifier(
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
        emitCell(child, childSuffix, childPorts, childScope, depth + 1, [
          ...path,
          instance.id,
        ]);
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
        elements.push({
          name,
          instancePath: [...path, instance.id],
          kind: "vcvs",
        });
        const gain = parameter(instance, scope, "gain");
        if (!gain)
          notes.push(
            `${name}: ideal op-amp as a VCVS of gain ${IDEAL_OPAMP_GAIN}`,
          );
        lines.push(
          `${name} ${out} 0 ${plus} ${minus} ${gain ?? IDEAL_OPAMP_GAIN}`,
        );
        dcPath.add(out);
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
      elements.push({
        name,
        instancePath: [...path, instance.id],
        kind: kind ?? KIND_OF_LETTER[letter] ?? "resistor",
      });
      const card = [name, ...nodes];
      const conducting = DC_PATH_PINS[letter];
      nodes.forEach((node, index) => {
        if (conducting === "all" || (conducting && conducting.includes(index)))
          dcPath.add(node);
      });
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
          if (dc === undefined) unknownBias.push(name);
          card.push("DC", dc ?? "0");
          const ac = parameter(instance, scope, "acMagnitude");
          if (ac) card.push("AC", ac);
          sources.push({
            name,
            kind: letter === "V" ? "voltage" : "current",
            nodes: [nodes[0] ?? "0", nodes[1] ?? "0"],
            dc: dc ?? "0",
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
          // Junction geometry, when the part carries it (the editor's
          // MOSFETs do not: their bulk junctions come from CBD and CBS).
          for (const key of ["ad", "as", "pd", "ps"]) {
            const found = parameter(instance, scope, key);
            if (found) card.push(`${key.toUpperCase()}=${found}`);
          }
          break;
        }
        case "Q":
        case "D": {
          const model = kind ?? "diode";
          usedModels.add(model);
          card.push(`${model}_l1`);
          const area = parameter(instance, scope, "area");
          if (area) card.push(area);
          // Parallel devices, as the SPICE export writes them.
          const m = parameter(instance, scope, "m", "mult");
          if (m) card.push(`M=${m}`);
          break;
        }
      }
      lines.push(card.join(" "));
    }
    deferred.forEach((emit) => emit());
  }

  if (top) emitCell(top, "", new Map(), new Map(), 0, []);

  // The editor's power Nets (a supply label or rail) and undriven nets
  // named like a supply are rails too.
  if (top) {
    for (const net of top.nets) {
      const name = identifier(net.name);
      if (name === "0" || !nets.has(name)) continue;
      if (net.id.startsWith("net-power-") || SUPPLY_NAME.test(net.name))
        supplyNets.add(name);
    }
  }

  // A VDD symbol in the top Cell is a Cell Pin there (Plain Pin symbols such
  // as an output label are not): nothing outside drives it, so it is a rail.
  if (top) {
    const document = project.documents.find((item) => item.id === top.id) as
      | {
          instances: Array<{ id: string; symbolId?: string }>;
          netlist?: {
            terminals?: Array<{
              name: string;
              interfaceInstanceIds?: string[];
            }>;
          };
        }
      | undefined;
    const symbolById = new Map(
      (document?.instances ?? []).map((item) => [item.id, item.symbolId]),
    );
    for (const terminal of document?.netlist?.terminals ?? []) {
      const isSupply = (terminal.interfaceInstanceIds ?? []).some((id) =>
        SUPPLY_SYMBOLS.has(symbolById.get(id) ?? ""),
      );
      const name = identifier(terminal.name);
      if (isSupply && nets.has(name) && name !== "0") supplyNets.add(name);
      // A Pin on a net nothing drives (only gates, capacitors…) is an input
      // or a bias node: give it a source, AC ground unless chosen as the
      // input, at its DC value if one is known.
      const isPin = (terminal.interfaceInstanceIds ?? []).some((id) =>
        PIN_SYMBOLS.has(symbolById.get(id) ?? ""),
      );
      if (!isPin || isSupply || !nets.has(name) || name === "0") continue;
      if (dcPath.has(name)) continue;
      const source = uniqueName("V", `PIN_${name}`, "");
      const bias = pinBias[terminal.name];
      if (bias === undefined) unknownBias.push(terminal.name);
      lines.push(`${source} ${name} 0 DC ${bias ?? 0}`);
      dcPath.add(name);
      sources.push({
        name: source,
        kind: "voltage",
        nodes: [name, "0"],
        dc: bias === undefined ? "?" : String(bias),
        pin: terminal.name,
      });
    }
  }

  // A supply rail with no voltage source on it is a fixed DC rail, which is
  // AC ground in the small-signal circuit.
  const supplies: string[] = [];
  const supplyVolts: Record<string, number> = {};
  for (const supply of supplyNets) {
    const driven = sources.some(
      (source) => source.kind === "voltage" && source.nodes.includes(supply),
    );
    if (driven) continue;
    const volts = GROUND_RAIL.test(supply) ? 0 : supplyVoltage;
    const name = uniqueName("V", `SUP_${supply}`, "");
    lines.push(`${name} ${supply} 0 DC ${volts}`);
    dcPath.add(supply);
    supplies.push(supply);
    supplyVolts[supply] = volts;
    notes.push(`${supply} has no source: held at ${volts} V DC (AC ground)`);
  }
  if (missing.length)
    notes.push(`No value drawn for ${missing.join(", ")}: kept symbolic`);

  const models = [...usedModels].map((kind) => modelCard(kind, modelOverrides));
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
    elements,
    nets: ["0", ...sortedNets],
    sources,
    missing,
    notes,
    supplies,
    supplyVolts,
    rails: [...supplyNets].filter((net) => nets.has(net)).sort(),
    unconnected,
    unknownBias,
    models: [...usedModels],
    terminals,
    noDcPath: [...nets].filter(
      (net) => net !== "0" && !dcPath.has(net) && !/^nc\d+$/u.test(net),
    ),
  };
}
