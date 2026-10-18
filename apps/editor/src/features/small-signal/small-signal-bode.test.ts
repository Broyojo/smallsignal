import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseProject } from "@icm/project-protocol";
import {
  smallSignalNetlist,
  type SmallSignalAssumptions,
  type SmallSignalQuantity,
  type SmallSignalRequest,
  type SmallSignalResult,
  type SweepPoint,
} from "@icm/small-signal";
import {
  bodeCurve,
  bodeCurves,
  frequencyTicks,
  isFlat,
  magnitudeTicks,
  nearestIndex,
  phaseTicks,
  rootFrequencies,
  unwrapPhase,
} from "./small-signal-bode-data";

describe("Bode plot data", () => {
  it("unwraps a phase that falls past −180° instead of jumping", () => {
    // Three poles: −90° per pole, −270° in all.
    const points: SweepPoint[] = [0, 60, 120, 180, 240, 270].map((deg) => {
      const rad = (-deg * Math.PI) / 180;
      return [Math.cos(rad), Math.sin(rad)];
    });
    const phase = unwrapPhase(points);
    expect(phase.map((p) => Math.round(p!) + 0)).toEqual([
      0, -60, -120, -180, -240, -270,
    ]);
    // A second curve starts on the first one's branch.
    expect(Math.round(unwrapPhase([[-1, -1e-9]], 180)[0]!)).toBe(180);
    expect(unwrapPhase([null, [0, 0], [1, 0]])).toEqual([null, null, 0]);
  });

  it("puts the assumed and ≈ curves on the full model's phase branch", () => {
    const curves = bodeCurves({
      full: [[-1, 1e-12]],
      assumed: [[-1, -1e-12]],
      approx: null,
    });
    expect(curves.map((c) => c.kind)).toEqual(["full", "assumed"]);
    expect(Math.round(curves[1]!.phase[0]!)).toBe(180);
  });

  it("calls a response that does not move flat", () => {
    expect(
      isFlat(
        bodeCurve("full", [
          [2, 0],
          [2, 0],
          [2, 1e-9],
        ]),
      ),
    ).toBe(true);
    expect(
      isFlat(
        bodeCurve("full", [
          [2, 0],
          [1, -1],
        ]),
      ),
    ).toBe(false);
  });

  it("ticks in dB steps, decades of ohms, 45° and 90° of phase", () => {
    expect(magnitudeTicks(0, 5, true).map((t) => t * 20)).toEqual([
      0, 20, 40, 60, 80, 100,
    ]);
    expect(magnitudeTicks(2.1, 5.4, false)).toEqual([3, 4, 5]);
    // Within a decade: round 1-2-5 values.
    const narrow = magnitudeTicks(1.9, 2.4, false).map((t) =>
      Math.round(10 ** t),
    );
    expect(narrow).toEqual([100, 200]);
    // One round value beats two odd ends.
    expect(
      magnitudeTicks(Math.log10(1.18e6), Math.log10(2.55e6), false).map((t) =>
        Math.round(10 ** t),
      ),
    ).toEqual([2e6]);
    expect(phaseTicks(-100, 190)).toEqual([-90, 0, 90, 180]);
    expect(frequencyTicks(1, 1e11)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(frequencyTicks(10, 1e5)).toEqual([1, 2, 3, 4, 5]);
  });

  it("marks one root per conjugate pair, none at DC", () => {
    const marks = rootFrequencies([
      { re: -3, im: 4 },
      { re: -3, im: -4 },
      { re: 0, im: 0 },
      { re: -10, im: 0 },
    ]);
    expect(marks.map((m) => m.f)).toEqual([5, 10]);
    expect(nearestIndex([1, 10, 100, 1000], 40)).toBe(2);
  });
});

/** A plain-text form of the solver (`num`, `den`) at complex s. */
function evalPlain(
  text: string,
  values: ReadonlyMap<string, number>,
  s: [number, number],
): [number, number] {
  type C = [number, number];
  const mul = (a: C, b: C): C => [
    a[0] * b[0] - a[1] * b[1],
    a[0] * b[1] + a[1] * b[0],
  ];
  const tokens = text.match(
    /\d+(?:\.\d+)?(?:e[+-]?\d+)?|[A-Za-z_]\w*|[-+*^()]/gu,
  )!;
  let at = 0;
  const peek = () => tokens[at];
  const next = () => tokens[at++]!;
  const expr = (): C => {
    let sign = 1;
    if (peek() === "-") {
      next();
      sign = -1;
    }
    let sum = term().map((x) => x * sign) as C;
    while (peek() === "+" || peek() === "-") {
      const op = next();
      const t = term();
      sum =
        op === "+"
          ? [sum[0] + t[0], sum[1] + t[1]]
          : [sum[0] - t[0], sum[1] - t[1]];
    }
    return sum;
  };
  const term = (): C => {
    let product = power();
    while (peek() === "*") {
      next();
      product = mul(product, power());
    }
    return product;
  };
  const power = (): C => {
    const base = atom();
    if (peek() !== "^") return base;
    next();
    let out: C = [1, 0];
    for (let n = Number(next()); n > 0; n -= 1) out = mul(out, base);
    return out;
  };
  const atom = (): C => {
    const token = next();
    if (token === "(") {
      const inner = expr();
      next();
      return inner;
    }
    if (/^\d/u.test(token)) return [Number(token), 0];
    if (token === "s") return s;
    const value = values.get(token);
    if (value === undefined) throw new Error(`no value for ${token}`);
    return [value, 0];
  };
  const result = expr();
  if (at !== tokens.length) throw new Error(`unparsed ${tokens.slice(at)}`);
  return result;
}

// Runs the real solver when the WASM has been built (wasm-pack, see
// crates/README.md); skipped otherwise.
const wasmDir = new URL(
  "../../../../../packages/small-signal/wasm/",
  import.meta.url,
);
const built = existsSync(new URL("smallsignal_wasm_bg.wasm", wasmDir));

describe.skipIf(!built)("Bode points are the solver's numbers", () => {
  const solve = async (request: SmallSignalRequest) => {
    const wasm = await import(
      /* @vite-ignore */ new URL("smallsignal_wasm.js", wasmDir).href
    );
    wasm.initSync({
      module: readFileSync(new URL("smallsignal_wasm_bg.wasm", wasmDir)),
    });
    const netlist = smallSignalNetlist(
      parseProject(
        readFileSync(
          new URL(
            "../../../../../packages/small-signal/test-fixtures/two-stage-miller-ota.icproj.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ),
    )!;
    const result = JSON.parse(
      wasm.analyze(netlist.text, JSON.stringify(request)),
    ) as SmallSignalResult & { error?: string };
    expect(result.error).toBeUndefined();
    return result;
  };
  const base: SmallSignalRequest = {
    input: "VINP",
    inputNeg: "VINN",
    mode: "differential",
    matchAuto: true,
    output: "vout",
    rout: true,
  };
  const dB = (z: [number, number]) => 20 * Math.log10(Math.hypot(z[0], z[1]));
  const degrees = (z: [number, number]) =>
    (Math.atan2(z[1], z[0]) * 180) / Math.PI;
  /** Equal phases, modulo the unwrapping's whole turns. */
  const samePhase = (a: number, b: number) =>
    Math.abs(((a - b + 540) % 360) - 180) < 1e-9;

  const cases: [string, SmallSignalAssumptions | undefined][] = [
    ["full model", undefined],
    ["Miller split of CC", { miller: [{ element: "CC" }] }],
  ];
  for (const [label, assume] of cases) {
    it(`${label}: every curve point equals a direct evaluation`, async () => {
      const swept = await solve({
        ...base,
        sweep: {},
        ...(assume ? { assume } : {}),
      });
      const f = swept.sweep!.f;
      expect(f.length).toBeGreaterThan(100);
      // Every tenth swept frequency, solved again as plain `freqs`.
      const picks = f.filter((_, index) => index % 10 === 0);
      const at = await solve({
        ...base,
        freqs: picks,
        ...(assume ? { assume } : {}),
      });
      const values = new Map(
        at.params!.map((param) => [param.name, param.value]),
      );
      for (const name of ["gain", "rout"] as const) {
        const q = swept[name] as SmallSignalQuantity;
        const full = bodeCurve("full", q.sweep!.full);
        const assumed = assume ? bodeCurve("assumed", q.sweep!.assumed!) : null;
        const approx = bodeCurve("approx", q.sweep!.approx!);
        const plain = q.simplified!;
        picks.forEach((freq, k) => {
          const index = k * 10;
          const point = at[name]!.values![k]!;
          const direct: [number, number] = [point.re!, point.im!];
          expect(full.log[index]! * 20).toBeCloseTo(dB(direct), 9);
          expect(samePhase(full.phase[index]!, degrees(direct))).toBe(true);
          if (assumed) {
            const a = at[name]!.assumed!.values[k]!;
            expect(assumed.log[index]! * 20).toBeCloseTo(dB([a.re!, a.im!]), 9);
          }
          // The ≈ curve is the simplified form itself, at the params.
          const s: [number, number] = [0, 2 * Math.PI * freq];
          const num = evalPlain(plain.num!, values, s);
          const den = evalPlain(plain.den!, values, s);
          const scale = den[0] ** 2 + den[1] ** 2;
          const h: [number, number] = [
            (num[0] * den[0] + num[1] * den[1]) / scale,
            (num[1] * den[0] - num[0] * den[1]) / scale,
          ];
          expect(approx.log[index]! * 20).toBeCloseTo(dB(h), 6);
          expect(
            Math.abs(((approx.phase[index]! - degrees(h) + 540) % 360) - 180),
          ).toBeLessThan(1e-6);
        });
      }
    });
  }
});
