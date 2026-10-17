import {
  ASSUMPTION_REGIONS,
  ASSUMPTION_TERMS,
  type AssumableElement,
  type AssumptionTerm,
  type MillerAssumption,
  type SmallSignalAssumptions,
  type SmallSignalElement,
} from "@icm/small-signal";

// Per-device assumptions as the panel keeps them: defaults per transistor
// type for every circuit, and each circuit's own choices per part, keyed by
// instance path so they follow a part across renames.

export const DEFAULTS_STORAGE_KEY = "smallsignal.assumptionDefaults";
export const CIRCUITS_STORAGE_KEY = "smallsignal.assumptions";
/** Circuits kept in storage; the least recently used go first. */
export const MAX_STORED_CIRCUITS = 200;

export type AssumableType = AssumableElement["type"];
export type TransistorType = keyof typeof ASSUMPTION_REGIONS;
export const TRANSISTOR_TYPES = Object.keys(
  ASSUMPTION_REGIONS,
) as TransistorType[];

/** Terms neglected in every circuit, per transistor type. */
export type AssumptionDefaults = Partial<
  Record<TransistorType, AssumptionTerm[]>
>;

/**
 * A capacitance a Miller split can take: a device's by its term, or a
 * capacitor's own (null).
 */
export type MillerTerm = AssumptionTerm | null;

/** The device capacitances a Miller split is offered for. */
export const MILLER_TERMS: readonly AssumptionTerm[] = ["cgd", "cmu"];

/**
 * One part's own choices: a term neglected (true) or kept (false) where that
 * differs from the default, the capacitances split by the Miller
 * approximation, and the region it is expected in.
 */
export interface PartAssumptions {
  ignore?: Partial<Record<AssumptionTerm, boolean>>;
  miller?: MillerTerm[];
  region?: string;
}

/** A circuit's parts, by `partKey` of their instance path. */
export type CircuitAssumptions = Readonly<Record<string, PartAssumptions>>;

export interface StoredCircuit {
  /** When the circuit was last opened or edited (ms since the epoch). */
  used: number;
  parts: CircuitAssumptions;
}

/** Circuits by `circuitStorageKey`. */
export type StoredAssumptions = Readonly<Record<string, StoredCircuit>>;

export function circuitStorageKey(
  projectId: string,
  rootDocumentId: string,
): string {
  return `${projectId}/${rootDocumentId}`;
}

/** An instance path as JSON: ids may hold any character, "/" included. */
export function partKey(instancePath: readonly string[]): string {
  return JSON.stringify(instancePath);
}

/**
 * A stored part key as `partKey` writes it. A bare id (no "/") from before
 * paths were JSON is read as a one-id path; ids joined with "/" could be
 * either of two paths, so they are dropped.
 */
function readPartKey(key: string): string | null {
  if (!key.startsWith("["))
    return key && !key.includes("/") ? partKey([key]) : null;
  try {
    const path: unknown = JSON.parse(key);
    return Array.isArray(path) &&
      path.length > 0 &&
      path.every((id) => typeof id === "string" && id)
      ? partKey(path as string[])
      : null;
  } catch {
    return null;
  }
}

export function isTransistor(type: string): type is TransistorType {
  return type in ASSUMPTION_REGIONS;
}

export function isAssumable(type: string): type is AssumableType {
  return type in ASSUMPTION_TERMS;
}

const KNOWN_TERMS = new Set<string>(Object.values(ASSUMPTION_TERMS).flat());
const KNOWN_REGIONS = new Set<string>(Object.values(ASSUMPTION_REGIONS).flat());

function parse(stored: string | null): unknown {
  try {
    return JSON.parse(stored ?? "{}");
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Stored defaults, keeping only the terms each type accepts. */
export function readDefaults(stored: string | null): AssumptionDefaults {
  const parsed = parse(stored);
  const defaults: AssumptionDefaults = {};
  if (!isRecord(parsed)) return defaults;
  for (const type of TRANSISTOR_TYPES) {
    const terms = parsed[type];
    if (!Array.isArray(terms)) continue;
    const known = ASSUMPTION_TERMS[type].filter((term) => terms.includes(term));
    if (known.length) defaults[type] = known;
  }
  return defaults;
}

function readPart(value: unknown): PartAssumptions | null {
  if (!isRecord(value)) return null;
  const part: PartAssumptions = {};
  if (isRecord(value.ignore)) {
    const ignore: Partial<Record<AssumptionTerm, boolean>> = {};
    for (const [term, on] of Object.entries(value.ignore))
      if (KNOWN_TERMS.has(term) && typeof on === "boolean")
        ignore[term as AssumptionTerm] = on;
    // Open and short at once is no choice at all.
    if (ignore.open && ignore.short) {
      delete ignore.open;
      delete ignore.short;
    }
    if (Object.keys(ignore).length) part.ignore = ignore;
  }
  // A split the part also neglects, opens or shorts is no choice at all
  // (stored before splits existed, or edited by hand): the split goes.
  if (Array.isArray(value.miller)) {
    const miller: MillerTerm[] = [];
    for (const term of value.miller as unknown[])
      if (
        (term === null || MILLER_TERMS.includes(term as AssumptionTerm)) &&
        !miller.includes(term as MillerTerm) &&
        !conflicts(part, term as MillerTerm)
      )
        miller.push(term as MillerTerm);
    if (miller.length) part.miller = miller;
  }
  if (typeof value.region === "string" && KNOWN_REGIONS.has(value.region))
    part.region = value.region;
  return part.ignore || part.miller || part.region ? part : null;
}

/** Whether a part's own choices take `term` to a limit a split excludes. */
function conflicts(part: PartAssumptions, term: MillerTerm): boolean {
  return term === null
    ? Boolean(part.ignore?.open || part.ignore?.short)
    : Boolean(part.ignore?.[term]);
}

/** The most recently used circuits, at most MAX_STORED_CIRCUITS. */
function newest(
  circuits: Record<string, StoredCircuit>,
): Record<string, StoredCircuit> {
  return Object.fromEntries(
    Object.entries(circuits)
      .sort(([, a], [, b]) => b.used - a.used)
      .slice(0, MAX_STORED_CIRCUITS),
  );
}

/** Stored circuits, dropping malformed entries and unknown terms. */
export function readCircuits(stored: string | null): StoredAssumptions {
  const parsed = parse(stored);
  const circuits: Record<string, StoredCircuit> = {};
  if (!isRecord(parsed)) return circuits;
  for (const [key, value] of Object.entries(parsed)) {
    if (
      !isRecord(value) ||
      typeof value.used !== "number" ||
      !Number.isFinite(value.used) ||
      !isRecord(value.parts)
    )
      continue;
    const parts: Record<string, PartAssumptions> = {};
    for (const [stored, part] of Object.entries(value.parts)) {
      const path = readPartKey(stored);
      const read = readPart(part);
      if (path && read) parts[path] = read;
    }
    if (Object.keys(parts).length) circuits[key] = { used: value.used, parts };
  }
  return newest(circuits);
}

function isEmpty(part: PartAssumptions): boolean {
  return (
    !part.region &&
    !Object.keys(part.ignore ?? {}).length &&
    !part.miller?.length
  );
}

/**
 * `circuits` with one circuit's parts replaced and marked used at `now`:
 * parts not in `paths` (when given) and empty ones are dropped, and so is
 * the circuit when nothing is left.
 */
export function storeCircuit(
  circuits: StoredAssumptions,
  key: string,
  parts: CircuitAssumptions,
  now: number,
  paths?: ReadonlySet<string>,
): StoredAssumptions {
  const kept = Object.fromEntries(
    Object.entries(parts).filter(
      ([path, part]) => (!paths || paths.has(path)) && !isEmpty(part),
    ),
  );
  const rest = Object.fromEntries(
    Object.entries(circuits).filter(([other]) => other !== key),
  );
  return newest(
    Object.keys(kept).length
      ? { ...rest, [key]: { used: now, parts: kept } }
      : rest,
  );
}

/** `circuits` with `key` marked used at `now` (unchanged if not stored). */
export function touchCircuit(
  circuits: StoredAssumptions,
  key: string,
  now: number,
): StoredAssumptions {
  const circuit = circuits[key];
  return circuit
    ? newest({ ...circuits, [key]: { ...circuit, used: now } })
    : circuits;
}

function byDefault(
  type: AssumableType,
  term: AssumptionTerm,
  defaults: AssumptionDefaults,
): boolean {
  return isTransistor(type) && (defaults[type]?.includes(term) ?? false);
}

/** Whether a part splits `term` (null: a capacitor's own) by Miller. */
export function isMiller(
  term: MillerTerm,
  part: PartAssumptions | undefined,
): boolean {
  return part?.miller?.includes(term) ?? false;
}

/**
 * Whether a part neglects `term`: its own choice, else its type's default.
 * A Miller split of the term (or of a capacitor, for open and short)
 * overrides the default.
 */
export function isIgnored(
  type: AssumableType,
  term: AssumptionTerm,
  part: PartAssumptions | undefined,
  defaults: AssumptionDefaults,
): boolean {
  if (isMiller(term === "open" || term === "short" ? null : term, part))
    return false;
  return part?.ignore?.[term] ?? byDefault(type, term, defaults);
}

/**
 * Whether parts of one type make the same choices, every term, the Miller
 * splits and the region: the solver matches only parts that do.
 */
export function sameChoices(
  type: AssumableType,
  paths: readonly string[],
  defaults: AssumptionDefaults,
  parts: CircuitAssumptions,
): boolean {
  const choices = (path: string) =>
    JSON.stringify([
      ASSUMPTION_TERMS[type].map((term) =>
        isIgnored(type, term, parts[path], defaults),
      ),
      MILLER_TERMS.map((term) => isMiller(term, parts[path])),
      parts[path]?.region ?? null,
    ]);
  const first = paths[0];
  return (
    first === undefined ||
    paths.every((path) => choices(path) === choices(first))
  );
}

/** `part` without the Miller splits in `terms`. */
function withoutMiller(
  part: PartAssumptions,
  terms: readonly MillerTerm[],
): PartAssumptions {
  const { miller, ...rest } = part;
  const kept = (miller ?? []).filter((term) => !terms.includes(term));
  return kept.length ? { ...rest, miller: kept } : rest;
}

/**
 * A part's `terms` neglected (or kept), stored only where that differs from
 * the default. Taking a passive open un-shorts it, and the reverse.
 * Neglecting a capacitance, or taking a capacitor open or shorted, ends its
 * Miller split.
 */
export function withTerms(
  parts: CircuitAssumptions,
  path: string,
  type: AssumableType,
  terms: readonly AssumptionTerm[],
  on: boolean,
  defaults: AssumptionDefaults,
): CircuitAssumptions {
  let part = parts[path] ?? {};
  const ignore = { ...part.ignore };
  for (const term of terms) {
    delete ignore[term];
    if (on !== byDefault(type, term, defaults)) ignore[term] = on;
  }
  if (on && terms.includes("open")) delete ignore.short;
  if (on && terms.includes("short")) delete ignore.open;
  if (on)
    part = withoutMiller(
      part,
      terms.map((term) => (term === "open" || term === "short" ? null : term)),
    );
  return { ...parts, [path]: { ...part, ignore } };
}

/**
 * A part's capacitance `term` (null: a capacitor's own) split by Miller, or
 * no longer. A split keeps the capacitance (neither neglected nor open nor
 * shorted), whatever the default.
 */
export function withMiller(
  parts: CircuitAssumptions,
  path: string,
  term: MillerTerm,
  on: boolean,
): CircuitAssumptions {
  const part = withoutMiller(parts[path] ?? {}, [term]);
  if (!on) return { ...parts, [path]: part };
  const ignore = { ...part.ignore };
  if (term === null) {
    delete ignore.open;
    delete ignore.short;
  } else delete ignore[term];
  return {
    ...parts,
    [path]: { ...part, ignore, miller: [...(part.miller ?? []), term] },
  };
}

/** The region parts are expected in; null checks none. */
export function withRegion(
  parts: CircuitAssumptions,
  paths: readonly string[],
  region: string | null,
): CircuitAssumptions {
  const next = { ...parts };
  for (const path of paths) {
    const { region: _old, ...part } = parts[path] ?? {};
    next[path] = region ? { ...part, region } : part;
  }
  return next;
}

/**
 * A type's default for `terms` set in every circuit, and the circuit's own
 * choices for them on `paths` cleared so all of the type follow it.
 */
export function withDefault(
  defaults: AssumptionDefaults,
  parts: CircuitAssumptions,
  type: TransistorType,
  terms: readonly AssumptionTerm[],
  on: boolean,
  paths: readonly string[],
): { defaults: AssumptionDefaults; parts: CircuitAssumptions } {
  const kept = (defaults[type] ?? []).filter((term) => !terms.includes(term));
  const typeTerms = ASSUMPTION_TERMS[type].filter(
    (term) => kept.includes(term) || (on && terms.includes(term)),
  );
  const { [type]: _old, ...others } = defaults;
  const next = { ...parts };
  for (const path of paths) {
    let part = parts[path];
    if (!part?.ignore && !part?.miller) continue;
    // Neglected everywhere: a part's split of the term ends too.
    if (on) part = withoutMiller(part, terms);
    const ignore = { ...part.ignore };
    for (const term of terms) delete ignore[term];
    next[path] = { ...part, ignore };
  }
  return {
    defaults: typeTerms.length ? { ...others, [type]: typeTerms } : others,
    parts: next,
  };
}

/** The solver's `assume` for the drawn parts; null when nothing is assumed. */
export function assumptionRequest(
  elements: readonly SmallSignalElement[],
  defaults: AssumptionDefaults,
  parts: CircuitAssumptions,
): SmallSignalAssumptions | null {
  const ignore: { element: string; term: AssumptionTerm }[] = [];
  const regions: { element: string; region: string }[] = [];
  const miller: MillerAssumption[] = [];
  for (const { name, kind, instancePath } of elements) {
    if (!isAssumable(kind)) continue;
    const part = parts[partKey(instancePath)];
    for (const term of ASSUMPTION_TERMS[kind])
      if (isIgnored(kind, term, part, defaults))
        ignore.push({ element: name, term });
    for (const term of part?.miller ?? [])
      if (
        term === null
          ? kind === "capacitor"
          : (ASSUMPTION_TERMS[kind] as readonly string[]).includes(term)
      )
        miller.push(
          term === null ? { element: name } : { element: name, term },
        );
    const region = part?.region;
    if (
      region &&
      isTransistor(kind) &&
      (ASSUMPTION_REGIONS[kind] as readonly string[]).includes(region)
    )
      regions.push({ element: name, region });
  }
  if (!ignore.length && !regions.length && !miller.length) return null;
  return {
    ...(ignore.length ? { ignore } : {}),
    ...(regions.length ? { regions } : {}),
    ...(miller.length ? { miller } : {}),
  };
}

export function loadDefaults(): AssumptionDefaults {
  try {
    return readDefaults(window.localStorage.getItem(DEFAULTS_STORAGE_KEY));
  } catch {
    return {};
  }
}

export function loadCircuits(): StoredAssumptions {
  try {
    return readCircuits(window.localStorage.getItem(CIRCUITS_STORAGE_KEY));
  } catch {
    return {};
  }
}

export function saveDefaults(defaults: AssumptionDefaults) {
  try {
    window.localStorage.setItem(DEFAULTS_STORAGE_KEY, JSON.stringify(defaults));
  } catch {
    // Private windows: the choices still apply until the page closes.
  }
}

export function saveCircuits(circuits: StoredAssumptions) {
  try {
    window.localStorage.setItem(CIRCUITS_STORAGE_KEY, JSON.stringify(circuits));
  } catch {
    // As above.
  }
}
