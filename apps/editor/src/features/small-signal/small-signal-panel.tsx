import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CircuitProject } from "@icm/model";
import {
  ANALOG_CANVAS_MATH_PROFILE_ID,
  CANONICAL_FORMULA_FONT_SIZE,
  cachedFormulaResult,
  prepareFormula,
  type FormulaRequest,
  type FormulaTypesetResult,
} from "@icm/math-typesetting/cache";
import { FORMULA_MAX_LATEX_LENGTH } from "@icm/math-typesetting/profile";
import {
  createSmallSignalClient,
  DEFAULT_SUPPLY_VOLTAGE,
  isSmallSignalError,
  smallSignalNetlist,
  type ComplexPoint,
  type Root,
  type BjtOperatingPoint,
  type MosOperatingPoint,
  type SmallSignalClient,
  type DeviceOperatingPoint,
  type SmallSignalSource,
  type SmallSignalQuantity,
  type SmallSignalRequest,
  type SmallSignalResponse,
} from "@icm/small-signal";
import {
  browserStaleBuildRecovery,
  diagnoseModuleLoadFailure,
  recoverFromStaleBuild,
} from "../../components/stale-build-recovery";
import "./small-signal-panel.css";

const SOLVE_DEBOUNCE_MS = 120;
const SI = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*(meg|[fpnumkgt])?/iu;
const SI_SCALE: Record<string, number> = {
  f: 1e-15,
  p: 1e-12,
  n: 1e-9,
  u: 1e-6,
  m: 1e-3,
  k: 1e3,
  meg: 1e6,
  g: 1e9,
  t: 1e12,
};

/** `1k, 10meg` → [1000, 1e7]; anything unreadable is dropped. */
export function parseFrequencies(text: string): number[] {
  return text
    .split(/[\s,;]+/u)
    .map((token) => {
      const match = SI.exec(token);
      if (!match) return NaN;
      return Number(match[1]) * (SI_SCALE[match[2]?.toLowerCase() ?? ""] ?? 1);
    })
    .filter((value) => Number.isFinite(value) && value >= 0);
}

export function formatEngineering(value: number, unit = ""): string {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return `0${unit ? ` ${unit}` : ""}`;
  const prefixes = ["f", "p", "n", "µ", "m", "", "k", "M", "G", "T"];
  const exponent = Math.min(
    12,
    Math.max(-15, Math.floor(Math.log10(Math.abs(value)) / 3) * 3),
  );
  const scaled = value / 10 ** exponent;
  const prefix = prefixes[exponent / 3 + 5] ?? "";
  return `${Number(scaled.toPrecision(4))}${unit || prefix ? " " : ""}${prefix}${unit}`;
}

/**
 * Set when the typesetter chunk 404s: this page is from a build a newer
 * deploy replaced, so the panel offers the editor's stale-build recovery.
 */
const StaleBuildContext = createContext<() => void>(() => {});

function Formula({ latex }: { latex: string }) {
  const onStale = useContext(StaleBuildContext);
  const request: FormulaRequest = {
    latex,
    display: "block",
    profileId: ANALOG_CANVAS_MATH_PROFILE_ID,
    bold: false,
  };
  const [prepared, setPrepared] = useState<{
    latex: string;
    result: FormulaTypesetResult;
  }>();
  const tooLong = latex.length > FORMULA_MAX_LATEX_LENGTH;
  const [failed, setFailed] = useState<string | null>(null);
  const result =
    prepared?.latex === latex ? prepared.result : cachedFormulaResult(request);
  useEffect(() => {
    if (tooLong) return;
    let active = true;
    void prepareFormula({
      latex,
      display: "block",
      profileId: ANALOG_CANVAS_MATH_PROFILE_ID,
      bold: false,
    }).then(
      (next) => {
        if (active) setPrepared({ latex, result: next });
      },
      (error: unknown) => {
        if (active) setFailed(latex);
        // The LaTeX source stays readable; a retired chunk also offers a reload.
        void diagnoseModuleLoadFailure(error, {
          currentUrl: window.location.href,
          fetch: (input, init) => fetch(input, init),
        }).then((diagnosis) => {
          if (active && diagnosis.kind === "stale-build") onStale();
        });
      },
    );
    return () => {
      active = false;
    };
  }, [latex, tooLong, onStale]);
  // While the typesetter loads, hold the space quietly; raw TeX reads as
  // broken. Only a formula that cannot be typeset shows its source.
  if (!tooLong && !result && failed !== latex)
    return <span className="small-signal-formula-pending" aria-busy="true" />;
  if (tooLong || !result?.ok)
    return <code className="small-signal-latex-source">{latex}</code>;
  const artifact = result.artifact;
  // Long expressions keep their size and scroll sideways rather than
  // shrinking past legibility.
  return (
    <div className="small-signal-formula-scroll">
      <img
        className="small-signal-formula"
        alt={latex}
        src={`data:image/svg+xml,${encodeURIComponent(artifact.svg)}`}
        style={{
          width: `${artifact.width / CANONICAL_FORMULA_FONT_SIZE}em`,
          height: `${artifact.height / CANONICAL_FORMULA_FONT_SIZE}em`,
        }}
      />
    </div>
  );
}

/** A unitless value (a voltage gain) as a plain number: -3.85, 1.2e-5. */
export function formatPlain(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const magnitude = Math.abs(value);
  return magnitude !== 0 && (magnitude < 1e-3 || magnitude >= 1e6)
    ? value.toExponential(3)
    : String(Number(value.toPrecision(4)));
}

function formatValue(value: number, unit: string): string {
  return unit ? formatEngineering(value, unit) : formatPlain(value);
}

export { pointText as pointTextForTest };

function pointText(point: ComplexPoint, unit: string): string {
  if (point.inf || point.re === null || point.im === null) return "∞";
  // Rounding residue in a real quantity is not a phase.
  if (Math.abs(point.im) <= 1e-12 * Math.abs(point.re))
    return formatValue(point.re, unit);
  const magnitude = Math.hypot(point.re, point.im);
  const phase = (Math.atan2(point.im, point.re) * 180) / Math.PI;
  return `${formatValue(magnitude, unit)} ∠ ${phase.toFixed(1)}°`;
}

/** Poles/zeros in Hz, e.g. "−16.3 MHz" or "−1 ± j2 kHz". */
function rootText(root: Root): string {
  if (root.im === 0) return formatEngineering(root.re, "Hz");
  if (root.im < 0) return "";
  return `${formatEngineering(root.re)} ± j${formatEngineering(root.im, "Hz")}`;
}

function ExactFormula({
  symbol,
  quantity,
}: {
  symbol: string;
  quantity: SmallSignalQuantity;
}) {
  if (quantity.exact.latex === null) {
    return (
      <p className="small-signal-muted">
        The exact expression is too large to typeset.
      </p>
    );
  }
  return <Formula latex={`${symbol} = ${quantity.exact.latex}`} />;
}

function formatPercent(fraction: number): string {
  const percent = fraction * 100;
  return percent < 0.1 ? "<0.1%" : `${percent.toPrecision(2)}%`;
}

/** One result: its equation, its value, and its poles. */
function QuantityCard({
  title,
  symbol,
  quantity,
  unit,
}: {
  title: string;
  symbol: string;
  quantity: SmallSignalQuantity;
  unit: string;
}) {
  // The simpler form appears only when it actually dropped terms.
  const simpler =
    quantity.simplified && !quantity.simplified.same
      ? quantity.simplified
      : null;
  const value = quantity.values?.[0];
  const terms = quantity.exact.terms;
  const exactIsLong =
    quantity.exact.latex === null ||
    (terms ? terms.num + terms.den > 6 : quantity.exact.latex.length > 160);
  const simplerNote = simpler?.assumption
    ? `assuming ${simpler.assumption}`
    : `within ${formatPercent(simpler?.maxRelError ?? 0)} of the exact form`;
  const poleCount = quantity.poles?.length ?? 0;
  const poles = (quantity.poles ?? []).map(rootText).filter(Boolean);
  return (
    <section className="small-signal-card" aria-label={title}>
      <header>
        <span>{title}</span>
        {value ? (
          <strong>
            {pointText(value, unit)}
            {quantity.values?.length === 1 &&
            value.f > 0 &&
            (quantity.poles?.length || quantity.zeros?.length) ? (
              <small> at {formatEngineering(value.f, "Hz")}</small>
            ) : null}
          </strong>
        ) : null}
      </header>
      {simpler && exactIsLong ? (
        <>
          {/* A long exact form would bury the result: lead with the
              readable one and keep the exact form a click away. */}
          <Formula latex={`${symbol} \\approx ${simpler.latex}`} />
          <small className="small-signal-muted">{simplerNote}</small>
          <details className="small-signal-exact">
            <summary>Exact</summary>
            <ExactFormula symbol={symbol} quantity={quantity} />
          </details>
        </>
      ) : (
        <>
          <ExactFormula symbol={symbol} quantity={quantity} />
          {simpler ? (
            <div className="small-signal-simpler">
              <Formula latex={`\\approx ${simpler.latex}`} />
              <small>{simplerNote}</small>
            </div>
          ) : null}
        </>
      )}
      {quantity.values && quantity.values.length > 1 ? (
        <table className="small-signal-values">
          <tbody>
            {quantity.values.map((point) => (
              <tr key={point.f}>
                <th scope="row">{formatEngineering(point.f, "Hz")}</th>
                <td>{pointText(point, unit)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {poles.length ? (
        <small className="small-signal-muted">
          {poleCount === 1 ? "Pole" : "Poles"} {poles.join(", ")}
        </small>
      ) : null}
    </section>
  );
}

function volts(value: number): string {
  return formatEngineering(value, "V");
}

/** One line per transistor: its region and the numbers that set gm and ro. */
function DeviceLine({
  name,
  device,
}: {
  name: string;
  device: DeviceOperatingPoint;
}) {
  if (device.type === "nmos" || device.type === "pmos") {
    const m = device as MosOperatingPoint;
    // In the device's own frame (positive for a conducting PMOS too).
    const sign = m.type === "pmos" ? -1 : 1;
    const vov = sign * m.vgs - sign * m.vth;
    return (
      <li>
        <b>{name}</b>{" "}
        <span className={`small-signal-region is-${m.region}`}>{m.region}</span>
        <span>
          I<sub>D</sub> {formatEngineering(Math.abs(m.id), "A")} · V
          <sub>ov</sub> {volts(vov)} · V<sub>DS</sub> {volts(sign * m.vds)} · g
          <sub>m</sub> {formatEngineering(m.gm, "S")} · r<sub>o</sub>{" "}
          {m.gds > 0 ? formatEngineering(1 / m.gds, "Ω") : "∞"}
        </span>
      </li>
    );
  }
  if (device.type === "npn" || device.type === "pnp") {
    const q = device as BjtOperatingPoint;
    const sign = q.type === "pnp" ? -1 : 1;
    const region = q.region === "forward-active" ? "active" : q.region;
    return (
      <li>
        <b>{name}</b>{" "}
        <span className={`small-signal-region is-${region}`}>{region}</span>
        <span>
          I<sub>C</sub> {formatEngineering(Math.abs(q.ic), "A")} · V
          <sub>CE</sub> {volts(sign * q.vce)} · g<sub>m</sub>{" "}
          {formatEngineering(q.gm, "S")} · r<sub>π</sub>{" "}
          {formatEngineering(1 / q.gpi, "Ω")}
        </span>
      </li>
    );
  }
  return null;
}

/** `v_{out}` for a net named Vout or out, `i_{1}` for a source named I1. */
export function signalLabel(letter: "v" | "i", name: string): string {
  const body = new RegExp(`^${letter}(?=.)`, "iu").test(name)
    ? name.slice(1)
    : name;
  return `${letter}_{${body.replace(/_/gu, "\\_")}}`;
}

/**
 * A net named like an output, else the first that is neither driven by a
 * source nor a supply rail (a rail is AC ground, never a useful output).
 */
export function preferredOutput(
  nets: string[],
  sourceNodes: Set<string>,
  supplies: string[] = [],
) {
  const candidates = nets.filter(
    (net) => net !== "0" && !supplies.includes(net),
  );
  return (
    candidates.find((net) => /out/iu.test(net)) ??
    candidates.find((net) => !sourceNodes.has(net)) ??
    candidates[0] ??
    "0"
  );
}

function sourceLabel(source: SmallSignalSource): string {
  return source.pin ?? source.name;
}

/**
 * Inputs drawn as a pair (Vin1/Vin2, Vin+/Vin−, Vinp/Vinn, INP/INN): offered
 * first, as a differential drive.
 */
export function differentialPairs(
  sources: SmallSignalSource[],
): Array<[SmallSignalSource, SmallSignalSource]> {
  const voltage = sources.filter((source) => source.kind === "voltage");
  const pairs: Array<[SmallSignalSource, SmallSignalSource]> = [];
  const split = (label: string) => {
    const match = /^(.*?)(\+|-|−|p|n|P|N|1|2)$/u.exec(label);
    if (!match) return null;
    const sign = match[2] ?? "";
    const positive = ["+", "p", "P", "1"].includes(sign);
    return { stem: match[1] ?? "", positive };
  };
  for (const plus of voltage) {
    const a = split(sourceLabel(plus));
    if (!a?.positive || !a.stem) continue;
    const minus = voltage.find((other) => {
      const b = split(sourceLabel(other));
      return other !== plus && b && !b.positive && b.stem === a.stem;
    });
    if (minus) pairs.push([plus, minus]);
  }
  return pairs;
}

const DIFF_PREFIX = "diff:";

/** Symbolic small-signal analysis of the open Cell, solved in a worker. */
export function SmallSignalPanel({
  project,
  rootDocumentId,
}: {
  project: CircuitProject;
  rootDocumentId?: string;
}) {
  const [supply, setSupply] = useState(String(DEFAULT_SUPPLY_VOLTAGE));
  const supplyVoltage = parseFrequencies(supply)[0] ?? DEFAULT_SUPPLY_VOLTAGE;
  // DC values typed for undriven Pins (inputs and bias nodes).
  const [pinBiasText, setPinBiasText] = useState<Record<string, string>>({});
  const pinBias = useMemo(() => {
    const values: Record<string, number> = {};
    for (const [pin, text] of Object.entries(pinBiasText)) {
      const value = Number.parseFloat(text);
      if (text.trim() && Number.isFinite(value)) values[pin] = value;
    }
    return values;
  }, [pinBiasText]);
  const netlist = useMemo(
    () =>
      smallSignalNetlist(project, {
        ...(rootDocumentId ? { rootDocumentId } : {}),
        supplyVoltage,
        pinBias,
      }),
    [project, rootDocumentId, supplyVoltage, pinBias],
  );
  const [input, setInput] = useState<string | null>(null);
  const [output, setOutput] = useState<string | null>(null);
  const [reference, setReference] = useState("0");
  const [frequencies, setFrequencies] = useState("1k");
  // Hand-analysis mode: no bias, every transistor taken as saturated.
  const [assumeSaturation, setAssumeSaturation] = useState(false);
  // Matched pairs the user turned off (keys like "M1=M2").
  const [unmatched, setUnmatched] = useState<ReadonlySet<string>>(new Set());
  const [candidates, setCandidates] = useState<string[][]>([]);
  const [response, setResponse] = useState<SmallSignalResponse | null>(null);
  const [staleBuild, setStaleBuild] = useState(false);
  const markStale = useCallback(() => setStaleBuild(true), []);
  const [solving, setSolving] = useState(false);
  const clientRef = useRef<SmallSignalClient | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    // Start loading the typesetter now, before the first result arrives.
    void prepareFormula({
      latex: "g_m",
      display: "block",
      profileId: ANALOG_CANVAS_MATH_PROFILE_ID,
      bold: false,
    }).catch(() => {});
    const client = createSmallSignalClient();
    clientRef.current = client;
    return () => {
      client.dispose();
      clientRef.current = null;
    };
  }, []);

  // `nc…` nets stand in for unconnected pins: never something to pick.
  const nets = (netlist?.nets ?? []).filter((net) => !/^nc\d+$/u.test(net));
  const sources = netlist?.sources ?? [];
  const sourceNodes = new Set(sources.flatMap((source) => source.nodes));
  const pairs = differentialPairs(sources);
  const pairValue = ([plus, minus]: [SmallSignalSource, SmallSignalSource]) =>
    `${DIFF_PREFIX}${plus.name}|${minus.name}`;
  const validInput =
    input &&
    (sources.some((source) => source.name === input) ||
      pairs.some((pair) => pairValue(pair) === input));
  // A drawn input pair is the natural default for a differential stage.
  const chosenInput = validInput
    ? input
    : pairs[0]
      ? pairValue(pairs[0])
      : (sources.find((source) => /in/iu.test(sourceLabel(source)))?.name ??
        sources[0]?.name ??
        null);
  const differential = chosenInput?.startsWith(DIFF_PREFIX)
    ? (chosenInput.slice(DIFF_PREFIX.length).split("|") as [string, string])
    : null;
  // Pairs from an earlier solve, kept only while all their elements exist.
  const elementNames = new Set(
    (netlist?.text ?? "")
      .split("\n")
      .map((line) => line.split(" ")[0]?.toLowerCase() ?? ""),
  );
  const liveCandidates = candidates.filter((pair) =>
    pair.every((name) => elementNames.has(name.toLowerCase())),
  );
  const match = liveCandidates.filter((pair) => !unmatched.has(pair.join("=")));
  const chosenOutput =
    output && nets.includes(output)
      ? output
      : preferredOutput(nets, sourceNodes, netlist?.supplies ?? []);
  const chosenReference = nets.includes(reference) ? reference : "0";
  // Ground and supply rails are AC ground: if nothing else exists, there is
  // nothing to measure (e.g. the output is drawn on ground).
  const noOutput = Boolean(netlist) && chosenOutput === "0";

  // An open pin makes every number meaningless: refuse rather than guess.
  const unconnected = netlist?.unconnected ?? [];
  const noDcPath = netlist?.noDcPath ?? [];
  const unknownBias = netlist?.unknownBias ?? [];
  // Without every bias value there is no operating point: hand analysis.
  const handAnalysis = assumeSaturation || unknownBias.length > 0;
  const request: SmallSignalRequest | null =
    netlist &&
    chosenInput &&
    !unconnected.length &&
    !noDcPath.length &&
    !noOutput
      ? {
          input: differential ? differential[0] : chosenInput,
          ...(differential
            ? { inputNeg: differential[1], mode: "differential" as const }
            : {}),
          ...(match.length ? { match } : {}),
          output: chosenOutput,
          ref: chosenReference === "0" ? null : chosenReference,
          freqs: parseFrequencies(frequencies),
          rin: true,
          rout: true,
          ...(handAnalysis ? { symbolic: true } : {}),
        }
      : null;
  const requestKey =
    netlist && request ? JSON.stringify([netlist.text, request]) : null;

  useEffect(() => {
    if (!requestKey) {
      setResponse(null);
      return;
    }
    // The key is the whole job: the netlist text and every request field.
    const [text, job] = JSON.parse(requestKey) as [string, SmallSignalRequest];
    const current = ++generation.current;
    const timer = setTimeout(() => {
      const client = clientRef.current;
      if (!client) return;
      setSolving(true);
      void client.analyze(text, job).then((next) => {
        if (current !== generation.current) return;
        setResponse(next);
        if (!isSmallSignalError(next) && next.matchCandidates) {
          const found = next.matchCandidates.map(
            (candidate) => candidate.elements,
          );
          setCandidates((prev) =>
            JSON.stringify(prev) === JSON.stringify(found) ? prev : found,
          );
        }
        setSolving(false);
      });
    }, SOLVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // requestKey covers the netlist text and every request field.
  }, [requestKey]);

  const blocked = unconnected.length > 0 || noDcPath.length > 0 || noOutput;
  const result =
    response && !isSmallSignalError(response) && !blocked ? response : null;
  const error =
    response && isSmallSignalError(response) && !blocked
      ? response.error
      : null;
  const inputSource = sources.find(
    (source) => source.name === (differential ? differential[0] : chosenInput),
  );
  const minusSource = differential
    ? sources.find((source) => source.name === differential[1])
    : undefined;
  const outputLabel =
    chosenReference === "0"
      ? signalLabel("v", chosenOutput)
      : `${signalLabel("v", chosenOutput)} - ${signalLabel("v", chosenReference)}`;
  const inputLabel = minusSource
    ? `${signalLabel("v", inputSource ? sourceLabel(inputSource) : "")} - ${signalLabel("v", sourceLabel(minusSource))}`
    : signalLabel(
        inputSource?.kind === "current" ? "i" : "v",
        inputSource ? sourceLabel(inputSource) : "",
      );
  const devices = Object.entries(result?.op?.devices ?? {});
  const allGood =
    result &&
    !result.warnings?.length &&
    devices.every(([, device]) =>
      ["saturation", "forward-active"].includes(String(device.region)),
    );
  const pinsNeedingBias = sources.filter(
    (source) => source.pin && unknownBias.includes(source.pin),
  );
  const otherUnknown = unknownBias.filter(
    (name) => !sources.some((source) => source.pin === name),
  );

  return (
    <StaleBuildContext.Provider value={markStale}>
      <section
        className="small-signal-panel"
        aria-label="Small-signal analysis"
        data-testid="small-signal-panel"
      >
        <header className="small-signal-header">
          <h2>Small-Signal</h2>
          {solving ? (
            <span className="small-signal-muted" role="status">
              Solving…
            </span>
          ) : null}
        </header>
        {staleBuild ? (
          <div className="small-signal-alert is-error" role="alert">
            <p>This page is an older version of the site.</p>
            <button
              type="button"
              onClick={() =>
                void recoverFromStaleBuild(browserStaleBuildRecovery())
              }
            >
              Reload to update
            </button>
          </div>
        ) : null}
        {!netlist ? (
          <p className="small-signal-muted">Draw a circuit to analyze it.</p>
        ) : (
          <>
            <div className="small-signal-io">
              <label>
                Input
                <select
                  aria-label="Input"
                  value={chosenInput ?? ""}
                  disabled={!sources.length}
                  onChange={(event) => setInput(event.currentTarget.value)}
                >
                  {sources.length ? null : (
                    <option value="">Add a source or Pin</option>
                  )}
                  {pairs.map((pair) => (
                    <option key={pairValue(pair)} value={pairValue(pair)}>
                      {sourceLabel(pair[0])} − {sourceLabel(pair[1])}
                    </option>
                  ))}
                  {sources.map((source) => (
                    <option key={source.name} value={source.name}>
                      {sourceLabel(source)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Output
                <select
                  aria-label="Output"
                  value={chosenOutput}
                  onChange={(event) => setOutput(event.currentTarget.value)}
                >
                  {nets
                    .filter((net) => net !== "0")
                    .map((net) => (
                      <option key={net} value={net}>
                        {net}
                      </option>
                    ))}
                </select>
              </label>
            </div>

            {unconnected.length ? (
              <div className="small-signal-alert is-error" role="alert">
                <p>
                  <b>{unconnected.join(", ")}</b>{" "}
                  {unconnected.length === 1 ? "is" : "are"} not connected.
                </p>
                <small>
                  Touching parts aren&apos;t connected. Draw a wire to it (W).
                </small>
              </div>
            ) : noOutput ? (
              <div className="small-signal-alert is-error" role="alert">
                <p>There is no output node to measure.</p>
                <small>
                  Every net is ground or a supply. Check that the output
                  isn&apos;t wired to ground.
                </small>
              </div>
            ) : noDcPath.length ? (
              <div className="small-signal-alert is-error" role="alert">
                <p>
                  Nothing sets the voltage of <b>{noDcPath.join(", ")}</b>.
                </p>
                <small>
                  Only gates or capacitors connect to it. Wire it to the
                  circuit, or mark it with a Pin to use it as an input.
                </small>
              </div>
            ) : error ? (
              <div className="small-signal-alert is-error" role="alert">
                <p>{error}</p>
              </div>
            ) : result?.warnings?.length ? (
              <div className="small-signal-alert is-warning" role="alert">
                <ul>
                  {result.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            ) : handAnalysis && result ? (
              <div className="small-signal-alert is-info" role="status">
                <p>Hand analysis: transistors assumed saturated.</p>
                {pinsNeedingBias.length || otherUnknown.length ? (
                  <small>
                    Enter bias voltages below for a real operating point.
                  </small>
                ) : null}
              </div>
            ) : allGood && devices.length ? (
              <div className="small-signal-alert is-ok" role="status">
                <p>
                  {devices.length === 1
                    ? `${devices[0]?.[0] ?? "The transistor"} is`
                    : "All transistors are"}{" "}
                  in saturation.
                </p>
              </div>
            ) : null}

            {liveCandidates.length && result ? (
              <div className="small-signal-match" aria-label="Matched pairs">
                <span>Matched</span>
                {liveCandidates.map((pair) => {
                  const key = pair.join("=");
                  const on = !unmatched.has(key);
                  return (
                    <button
                      key={key}
                      type="button"
                      aria-pressed={on}
                      title={
                        on
                          ? "Shares one set of symbols. Click to treat separately."
                          : "Click to treat as a matched pair."
                      }
                      onClick={() =>
                        setUnmatched((prev) => {
                          const next = new Set(prev);
                          if (on) next.add(key);
                          else next.delete(key);
                          return next;
                        })
                      }
                    >
                      {pair.join(" = ")}
                    </button>
                  );
                })}
              </div>
            ) : null}

            {pinsNeedingBias.length || otherUnknown.length ? (
              <div className="small-signal-bias-inputs">
                {pinsNeedingBias.map((source) => {
                  const pin = source.pin ?? source.name;
                  return (
                    <label key={pin}>
                      {pin} DC
                      <input
                        aria-label={`${pin} DC voltage`}
                        inputMode="decimal"
                        placeholder="V"
                        value={pinBiasText[pin] ?? ""}
                        onChange={(event) => {
                          const text = event.currentTarget.value;
                          setPinBiasText((prev) => ({ ...prev, [pin]: text }));
                        }}
                      />
                    </label>
                  );
                })}
                {otherUnknown.length ? (
                  <small className="small-signal-muted">
                    Set the DC value of {otherUnknown.join(", ")} in Properties.
                  </small>
                ) : null}
              </div>
            ) : null}

            {result?.gain ? (
              <QuantityCard
                title="Gain"
                symbol={`\\frac{${outputLabel}}{${inputLabel}}`}
                quantity={result.gain}
                unit={inputSource?.kind === "current" ? "Ω" : ""}
              />
            ) : null}
            {result?.rin ? (
              <QuantityCard
                title="Input impedance"
                symbol="Z_{in}"
                quantity={result.rin}
                unit="Ω"
              />
            ) : null}
            {result?.rout ? (
              <QuantityCard
                title="Output impedance"
                symbol="Z_{out}"
                quantity={result.rout}
                unit="Ω"
              />
            ) : null}

            {result && devices.length ? (
              <section className="small-signal-card" aria-label="Bias point">
                <header>
                  <span>Bias point</span>
                </header>
                <ul className="small-signal-devices">
                  {devices.map(([name, device]) => (
                    <DeviceLine key={name} name={name} device={device} />
                  ))}
                </ul>
              </section>
            ) : null}

            <details className="small-signal-options">
              <summary>Options</summary>
              <div>
                <label>
                  Frequencies
                  <input
                    aria-label="Frequencies"
                    value={frequencies}
                    placeholder="1k, 1meg"
                    onChange={(event) =>
                      setFrequencies(event.currentTarget.value)
                    }
                  />
                </label>
                <label>
                  Measured against
                  <select
                    aria-label="Output reference"
                    value={chosenReference}
                    onChange={(event) =>
                      setReference(event.currentTarget.value)
                    }
                  >
                    {nets.map((net) => (
                      <option key={net} value={net}>
                        {net === "0" ? "ground" : net}
                      </option>
                    ))}
                  </select>
                </label>
                {netlist.supplies.length ? (
                  <label>
                    {netlist.supplies.join(", ")} (V)
                    <input
                      aria-label="Supply voltage"
                      inputMode="decimal"
                      value={supply}
                      onChange={(event) => setSupply(event.currentTarget.value)}
                    />
                  </label>
                ) : null}
                <label className="small-signal-check">
                  <input
                    type="checkbox"
                    checked={assumeSaturation}
                    onChange={(event) =>
                      setAssumeSaturation(event.currentTarget.checked)
                    }
                  />
                  Hand analysis (assume saturation)
                </label>
                <small className="small-signal-muted">
                  Transistors use level-1 square-law models (W/L as drawn).
                </small>
                <details>
                  <summary>Solver netlist</summary>
                  <pre>{netlist.text}</pre>
                </details>
              </div>
            </details>
          </>
        )}
      </section>
    </StaleBuildContext.Provider>
  );
}
