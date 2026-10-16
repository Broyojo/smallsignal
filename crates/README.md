# smallsignal solver

Symbolic small-signal analysis for the Analog Canvas editor. Draw a circuit,
pick an input source and an output net, and get the gain, Zin and Zout as
equations (exact, plus a simplified form with its measured error), together
with numeric values, poles and zeros, and the operating point.

- `smallsignal-core`: the solver library (pure Rust).
- `smallsignal-cli`: the `smallsignal` binary, used by the oracle tests.
- `smallsignal-wasm`: the `analyze(netlist, requestJson) -> responseJson` export
  that `packages/small-signal` runs in a Web Worker.

## Pipeline

1. **Parse** a SPICE subset: R C L V I E G F H M Q D, `.model` and `.options gmin=`.
   An element drawn without a value (or a transistor without a model) makes the
   analysis purely symbolic.
2. **DC operating point** by Newton–Raphson with ngspice's limiting
   (pnjlim/fetlim/limvds), falling back to gmin and then source stepping. The
   device equations follow ngspice exactly: MOS level 1 with body effect and
   bulk junctions; Gummel–Poon with IS, BF, BR and VAF; diode IS and N.
3. **Linearize**: MOSFETs get gm, ro and gmb (gmb only when body ≠ source);
   BJTs get gm, rπ, ro, plus rμ when significant; diodes get rd.
4. **Symbolic MNA**. The determinant is computed division-free by memoized
   Laplace expansion over the sparse matrix. Monomials are parameter bitsets,
   because every minor is multilinear in the element parameters (and s is
   implicit in C/L). The numerator comes from Cramer's rule.
5. **Display**: conductances become resistances, common factors cancel, and
   terms are sorted by magnitude. The simplified form drops the smallest terms
   within each power of s, up to the coarsest pruning whose error over
   1 Hz–100 GHz stays within `tolerance`.

## Correctness checks

- `oracle/`: 29 hand-built circuits plus a seeded random-circuit fuzzer, each
  compared with ngspice (`.op`, `.ac`) at 1e-6. See `oracle/README.md`.
- `verify: true`: an exact check of the symbolic solution, A·N = b·D as a
  polynomial identity, tested modulo 2⁶¹−1 at random points (Schwartz–Zippel).
- Every response: the symbolic result is cross-checked against an independent
  complex LU solve at 49 frequencies. The check fails only when the two
  disagree by more than the floating-point error bounds of either side (the
  sum's cancellation bound and κ₁(A)·eps·‖x‖/|xᵢ|). It is reported as
  `check.ok`.

```sh
cargo test --release
cargo run --release -p smallsignal-core --example bench_det
cd oracle && SMALLSIGNAL_BIN=$PWD/../target/release/smallsignal uv run compare.py
```

## Contract

`smallsignal analyze <netlist> --input <V|I source> --output <node>[:<ref>]
[--freq f1,f2] [--rin] [--rout] [--tol 0.05] [--verify] [--symbolic]`, or
`analyze(netlist, request)` in WASM, where `request` holds the same fields
(`input`, `output`, `ref`, `freqs`, `rin`, `rout`, `tolerance`, `verify`,
`symbolic`, `maxTerms`). The response is JSON, or `{"error": "..."}` on failure.

- `gain`: V(out) − V(ref) per unit AC of the input (V/V, or V/A for an I source).
- `rin`: the impedance the input source sees looking into the circuit.
- `rout`: the impedance at out/ref with every independent source zeroed.
- Each quantity carries `exact` and `simplified` (`latex`, `num`, `den`,
  `terms`, plus `maxRelError` for simplified), `values`
  (`f, re, im, mag, phaseDeg`; `inf: true` with null parts when infinite),
  `poles` and `zeros` (in Hz), and `check`.
- `op` (null in symbolic mode) holds node voltages, source branch currents, and
  per-device region, currents, voltages and small-signal conductances.
- `params` lists each symbol's name, LaTeX, value and unit; `warnings` collects
  devices out of their intended region, ignored model parameters, and so on.

Parameter symbols: `R1` → R_{1}; MOSFET `M1` → g_{m1}, r_{o1}, g_{mb1}; BJT
`Q1` → g_{m1}, r_{π1}, r_{o1}; C/L by name; the s variable stays as `s`.
