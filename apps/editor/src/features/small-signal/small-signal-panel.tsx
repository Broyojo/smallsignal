import { useEffect, useMemo, useRef, useState } from "react";
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
  type SmallSignalClient,
  type SmallSignalQuantity,
  type SmallSignalRequest,
  type SmallSignalResponse,
  type SmallSignalResult,
} from "@icm/small-signal";
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

function Formula({ latex }: { latex: string }) {
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
      () => {
        /* The LaTeX source stays readable if the typesetter fails to load. */
      },
    );
    return () => {
      active = false;
    };
  }, [latex, tooLong]);
  if (tooLong || !result?.ok)
    return <code className="small-signal-latex-source">{latex}</code>;
  const artifact = result.artifact;
  return (
    <img
      className="small-signal-formula"
      alt={latex}
      src={`data:image/svg+xml,${encodeURIComponent(artifact.svg)}`}
      style={{
        width: `${artifact.width / CANONICAL_FORMULA_FONT_SIZE}em`,
        height: `${artifact.height / CANONICAL_FORMULA_FONT_SIZE}em`,
      }}
    />
  );
}

function pointText(point: ComplexPoint, unit: string): string {
  if (point.inf || point.re === null || point.im === null) return "∞";
  const suffix = unit ? ` ${unit}` : "";
  return point.im === 0
    ? formatEngineering(point.re, unit)
    : `${magnitudePhase(point.re, point.im)}${suffix}`;
}

/** Poles/zeros in Hz, e.g. "−16.3 MHz" or "−1 ± j2 kHz". */
function rootText(root: Root): string {
  if (root.im === 0) return formatEngineering(root.re, "Hz");
  if (root.im < 0) return "";
  return `${formatEngineering(root.re)} ± j${formatEngineering(root.im, "Hz")}`;
}

function RootsRow({
  label,
  roots,
}: {
  label: string;
  roots: Root[] | undefined;
}) {
  const items = (roots ?? []).map(rootText).filter(Boolean);
  if (!items.length) return null;
  return (
    <p className="small-signal-muted">
      {label}: {items.join(", ")}
    </p>
  );
}

function magnitudePhase(re: number, im: number): string {
  const magnitude = Math.hypot(re, im);
  const phase = (Math.atan2(im, re) * 180) / Math.PI;
  return `${formatEngineering(magnitude)} ∠ ${phase.toFixed(1)}°`;
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

function QuantityView({
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
  const simplified = quantity.simplified;
  return (
    <section className="small-signal-quantity" aria-label={title}>
      <h3>{title}</h3>
      {simplified ? (
        <>
          <Formula latex={`${symbol} \\approx ${simplified.latex}`} />
          {simplified.maxRelError !== undefined ? (
            <p className="small-signal-muted">
              Simplified · within{" "}
              {(simplified.maxRelError * 100).toPrecision(2)}% of the exact
              result
            </p>
          ) : null}
          <details>
            <summary>Exact</summary>
            <ExactFormula symbol={symbol} quantity={quantity} />
          </details>
        </>
      ) : (
        <ExactFormula symbol={symbol} quantity={quantity} />
      )}
      {quantity.values?.length ? (
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
      <RootsRow label="Poles" roots={quantity.poles} />
      <RootsRow label="Zeros" roots={quantity.zeros} />
    </section>
  );
}

function OperatingPoint({ result }: { result: SmallSignalResult }) {
  const devices = Object.entries(result.op?.devices ?? {});
  if (!devices.length) return null;
  return (
    <details className="small-signal-op">
      <summary>Operating point</summary>
      <table>
        <tbody>
          {devices.map(([name, device]) => (
            <tr key={name}>
              <th scope="row">{name}</th>
              <td>
                {"gm" in device && typeof device.gm === "number"
                  ? `gm ${formatEngineering(device.gm, "S")}`
                  : null}
                {"gds" in device && typeof device.gds === "number"
                  ? ` · ro ${formatEngineering(1 / device.gds, "Ω")}`
                  : null}
                {"go" in device && typeof device.go === "number"
                  ? ` · ro ${formatEngineering(1 / device.go, "Ω")}`
                  : null}
                {"id" in device && typeof device.id === "number"
                  ? ` · Id ${formatEngineering(device.id, "A")}`
                  : null}
                {"ic" in device && typeof device.ic === "number"
                  ? ` · Ic ${formatEngineering(device.ic, "A")}`
                  : null}
                {"region" in device && typeof device.region === "string"
                  ? ` · ${device.region}`
                  : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

function preferredOutput(nets: string[], sourceNodes: Set<string>) {
  return (
    nets.find((net) => /^v?out/iu.test(net)) ??
    nets.find((net) => net !== "0" && !sourceNodes.has(net)) ??
    nets.find((net) => net !== "0") ??
    "0"
  );
}

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
  const netlist = useMemo(
    () =>
      smallSignalNetlist(project, {
        ...(rootDocumentId ? { rootDocumentId } : {}),
        supplyVoltage,
      }),
    [project, rootDocumentId, supplyVoltage],
  );
  const [input, setInput] = useState<string | null>(null);
  const [output, setOutput] = useState<string | null>(null);
  const [reference, setReference] = useState("0");
  const [frequencies, setFrequencies] = useState("1k");
  const [rin, setRin] = useState(true);
  const [rout, setRout] = useState(true);
  const [response, setResponse] = useState<SmallSignalResponse | null>(null);
  const [solving, setSolving] = useState(false);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const clientRef = useRef<SmallSignalClient | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    const client = createSmallSignalClient();
    clientRef.current = client;
    return () => {
      client.dispose();
      clientRef.current = null;
    };
  }, []);

  const nets = netlist?.nets ?? [];
  const sources = netlist?.sources ?? [];
  const sourceNodes = new Set(sources.flatMap((source) => source.nodes));
  const chosenInput =
    input && sources.some((source) => source.name === input)
      ? input
      : (sources.find((source) => /in/iu.test(source.name))?.name ??
        sources[0]?.name ??
        null);
  const chosenOutput =
    output && nets.includes(output)
      ? output
      : preferredOutput(nets, sourceNodes);
  const chosenReference = nets.includes(reference) ? reference : "0";

  const request: SmallSignalRequest | null =
    netlist && chosenInput
      ? {
          input: chosenInput,
          output: chosenOutput,
          ref: chosenReference === "0" ? null : chosenReference,
          freqs: parseFrequencies(frequencies),
          rin,
          rout,
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
      const started = performance.now();
      void client.analyze(text, job).then((next) => {
        if (current !== generation.current) return;
        setElapsed(performance.now() - started);
        setResponse(next);
        setSolving(false);
      });
    }, SOLVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // requestKey covers the netlist text and every request field.
  }, [requestKey]);

  const result = response && !isSmallSignalError(response) ? response : null;
  const inputSource = sources.find((source) => source.name === chosenInput);
  const outputLabel =
    chosenReference === "0"
      ? `v_{${chosenOutput}}`
      : `v_{${chosenOutput}} - v_{${chosenReference}}`;
  const inputLabel =
    inputSource?.kind === "current"
      ? `i_{${chosenInput}}`
      : `v_{${chosenInput}}`;

  return (
    <section
      className="small-signal-panel"
      aria-label="Small-signal analysis"
      data-testid="small-signal-panel"
    >
      <header className="small-signal-header">
        <h2>Small-Signal</h2>
        <span className="small-signal-muted" role="status">
          {solving
            ? "Solving…"
            : elapsed !== null
              ? `${elapsed < 10 ? elapsed.toFixed(1) : Math.round(elapsed)} ms`
              : ""}
        </span>
      </header>
      {!netlist ? (
        <p className="small-signal-muted">Draw a circuit to analyze it.</p>
      ) : (
        <>
          <div className="small-signal-controls">
            {netlist.supplies.length ? (
              <label title="DC value of the VDD symbols that no source drives">
                <span>{netlist.supplies.join(", ")}</span>
                <input
                  aria-label="Supply voltage"
                  value={supply}
                  onChange={(event) => setSupply(event.currentTarget.value)}
                />
                <span>V</span>
              </label>
            ) : null}
            <label>
              <span>Input</span>
              <select
                aria-label="Input source"
                value={chosenInput ?? ""}
                disabled={!sources.length}
                onChange={(event) => setInput(event.currentTarget.value)}
              >
                {sources.length ? null : (
                  <option value="">Add a V or I source</option>
                )}
                {sources.map((source) => (
                  <option key={source.name} value={source.name}>
                    {source.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Output</span>
              <select
                aria-label="Output net"
                value={chosenOutput}
                onChange={(event) => setOutput(event.currentTarget.value)}
              >
                {nets.map((net) => (
                  <option key={net} value={net}>
                    {net}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Ref</span>
              <select
                aria-label="Output reference net"
                value={chosenReference}
                onChange={(event) => setReference(event.currentTarget.value)}
              >
                {nets.map((net) => (
                  <option key={net} value={net}>
                    {net === "0" ? "0 (ground)" : net}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>f</span>
              <input
                aria-label="Frequencies"
                value={frequencies}
                placeholder="1k, 1meg"
                onChange={(event) => setFrequencies(event.currentTarget.value)}
              />
            </label>
            <label className="small-signal-check">
              <input
                type="checkbox"
                checked={rin}
                onChange={(event) => setRin(event.currentTarget.checked)}
              />
              <span>
                R<sub>in</sub>
              </span>
            </label>
            <label className="small-signal-check">
              <input
                type="checkbox"
                checked={rout}
                onChange={(event) => setRout(event.currentTarget.checked)}
              />
              <span>
                R<sub>out</sub>
              </span>
            </label>
          </div>
          {response && isSmallSignalError(response) ? (
            <p role="alert">{response.error}</p>
          ) : null}
          {result?.gain ? (
            <QuantityView
              title="Gain"
              symbol={`\\frac{${outputLabel}}{${inputLabel}}`}
              quantity={result.gain}
              unit={inputSource?.kind === "current" ? "Ω" : ""}
            />
          ) : null}
          {result?.rin ? (
            <QuantityView
              title="Input impedance"
              symbol="Z_{in}"
              quantity={result.rin}
              unit="Ω"
            />
          ) : null}
          {result?.rout ? (
            <QuantityView
              title="Output impedance"
              symbol="Z_{out}"
              quantity={result.rout}
              unit="Ω"
            />
          ) : null}
          {result?.warnings?.length ? (
            <ul className="small-signal-notes" aria-label="Solver warnings">
              {result.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}
          {result ? <OperatingPoint result={result} /> : null}
          {netlist.notes.length ? (
            <ul className="small-signal-notes">
              {netlist.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          ) : null}
          <details className="small-signal-netlist">
            <summary>Solver netlist</summary>
            <pre>{netlist.text}</pre>
          </details>
        </>
      )}
    </section>
  );
}
