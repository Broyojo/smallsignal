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
   BJTs get gm, rπ, ro; diodes get rd. Junction conductances (MOS bulk
   gbs/gbd, BJT gμ) are all in the model; a set of them is left out of the
   exact expression only when the full numeric system proves no reported
   value (gain, rin, rout at DC and every check-grid frequency) moves by more
   than 1e-9 (absolute floors 1e-12, 1e-9 Ω). They are tried all at once, then
   put back largest first (matched twins together). The cross-check always
   solves the full system. Symbolic mode leaves them out, as hand analysis
   does. Response: `omittedJunctions`, `omissionError`.
4. **Symbolic MNA**. The determinant is computed division-free by memoized
   Laplace expansion over the sparse matrix. Monomials are parameter bitsets,
   because every minor is multilinear in the element parameters (and s is
   implicit in C/L). The numerator comes from Cramer's rule.
5. **Display**: conductances become resistances, common factors cancel, and
   terms are sorted by magnitude. The simplified form drops the smallest terms
   within each power of s, up to the coarsest pruning whose error over
   1 Hz–100 GHz stays within `tolerance`.

## Correctness checks

- `oracle/`: hand-built circuits (`corpus/`) plus a seeded random-circuit fuzzer, each
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
[--input-neg <source>] [--mode differential|common] [--match M1,M2;M3,M4]
[--freq f1,f2] [--rin] [--rout] [--noise] [--noise-band fLow,fHigh]
[--tol 0.05] [--verify] [--symbolic]`, or
`analyze(netlist, request)` in WASM, where `request` holds the same fields
(`input`, `inputNeg`, `mode`, `match`, `output`, `ref`, `freqs`, `rin`, `rout`,
`noise`, `noiseBand`, `tolerance`, `verify`,
`symbolic`, `maxTerms`). The response is JSON, or
`{"error": "..."}` on failure.

- `gain`: V(out) − V(ref) per unit AC of the input (V/V, or V/A for an I source).
  With `inputNeg`, `mode` "differential" (the default) drives the two sources
  ±1/2, so the gain is A_d = v_out/(v_in+ − v_in−); "common" drives both with
  +1, giving A_cm. The response's `mode` says which applied.
- `rin`: the impedance the input source sees looking into the circuit. In
  differential mode it is the impedance between the two sources' + nodes with
  both sources removed; in common mode, 1/(total input current) with both at 1 V.
- `match`: groups of elements that share one set of symbols (g_{m1,2},
  r_{o1,2}, R_{D1,2}). Exact: merging happens after the multilinear solve, by
  mapping parameters onto symbols with exponents. In numeric mode a group
  merges only if its values agree to 1e-9 (else a warning says what differs);
  symbolic mode assumes equality. `matchCandidates` lists pairs with the same
  type, model and geometry (and, in numeric mode, small-signal values), plus
  passives with equal values (`kind: "passive"`).
- Common factors of numerator and denominator cancel (exact multivariate GCD),
  so e.g. a matched diff pair reads −g_{m1,2}(r_{o1,2} ∥ R_{D1,2}).
- `rout`: the impedance at out/ref with every independent source zeroed.
- Each quantity also carries `display`: the exact expression with junction
  leakage (r_bs, r_bd, r_μ) taken to zero conductance (their monomials dropped,
  then cancelled and normalized as usual), with `maxRelError` against the full
  model and `same` when it equals `exact`. If dropping the leakage would move
  a value by more than 1e-3, `display` keeps it (`leakageMatters: true`).
  `simplified` is derived from `display`, so neither shows leakage that does
  not matter; `values` always come from the full model.
- Each quantity carries `exact` and `simplified` (`latex`, `latexExpanded`,
  `num`, `den`, `terms`; `same` when nothing was dropped). In numeric mode
  `simplified` drops numerically small terms within `maxRelError`; in symbolic
  mode it is the hand-analysis limit r_o → ∞ (every device output resistance
  r_o, r_μ, bulk junction scaled as r/ε, the lowest order in ε kept for each
  power of s), labelled `assumption: "ro ≫ R, 1/gm"`. Then `values`
  (`f, re, im, mag, phaseDeg`; `inf: true` with null parts when infinite),
  `poles` and `zeros` (in Hz), and `check`.
- `op` (null in symbolic mode) holds node voltages, source branch currents, and
  per-device region, currents, voltages and small-signal conductances.
- `params` lists each symbol's name, LaTeX, value and unit; `warnings` collects
  devices out of their intended region, ignored model parameters,
  cross-coupled (latch) pairs that may have several DC solutions, junctions
  forward-biased by ideal sources (also named in the DC error when that is
  why DC fails), and so on.

Parameter symbols: `R1` → R_{1}; MOSFET `M1` → g_{m1}, r_{o1}, g_{mb1}; BJT
`Q1` → g_{m1}, r_{π1}, r_{o1}; C/L by name; the s variable stays as `s`.

## Noise (`noise: true`, optional `noiseBand: [fLow, fHigh]`)

Sources are ngspice's at 27 °C (k = 1.38064852e-23, q = 1.6021766208e-19,
T = 300.15 K), each a current between two nodes, checked against ngspice-47
to 1e-6 (`oracle/`):

| element | source (`kind`) | PSD (A²/Hz) |
|---|---|---|
| R | `thermal` | 4kT/R |
| MOSFET | `thermal` (every region) | (2/3)·4kT·gm |
| MOSFET | `flicker` | KF·gm²/(Cox·M·W·L·f^AF), Cox = 3.9ε₀/TOX (TOX default 1e-7) |
| BJT | `shot_c` (c–e), `shot_b` (b–e) | 2q·\|Ic\|, 2q·\|Ib\| |
| BJT | `flicker` (b–e) | KF·\|Ib\|^AF/f |
| diode | `shot`, `flicker` | 2q·\|Id\|, KF·\|Id\|^AF/f |

Device conductances (r_o, r_π, r_d, junction leakage) carry no noise, as in
ngspice. Junction currents include the DC solve's gmin·v, as ngspice's own
noise does. (ngspice-47's level-1 flicker is the gm² form above, not SPICE2's
KF·Id^AF/(Cox·L²·f). With TOX given and KP not, KP = UO·Cox, UO default 600.)

Output PSD S_out = Σ|Z_k|²·S_k with every transfer Z_k from one adjoint LU
solve per frequency on the full model (input source zeroed); input-referred
S_in = S_out/|gain|² (V²/Hz, or A²/Hz for a current input). Response `noise`:

- `output`, `input`: `[{f, v2}]` at `freqs` (v2 null where infinite or
  undefined). At 0 Hz a flicker source with AF > 0 gives the f → 0 limit of
  \|Z(f)\|²·c/f^AF: for a transfer Z with a zero of order k at DC (k = 0: none),
  0 when 2k > AF, c·\|lim Z/fᵏ\|² when 2k = AF, null (∞) when 2k < AF.
  `input` is null at 0 Hz when the gain vanishes there.
- `contributors`: `[{f, sources: [{element, kind, v2, fraction}], omitted?}]`,
  per frequency, sorted by output contribution. At most the 32 largest
  sources are listed; the rest are summed in `omitted: {count, v2,
  fraction}`. The listed fractions plus `omitted.fraction` sum to 1.
- `sources`: `[{element, kind, psd (LaTeX, with M when a MOSFET's M ≠ 1), white, flicker: {coef, exp}}]`.
- `integrated` (with `noiseBand`, finite, 0 < fLow < fHigh, at most 40
  decades): `{fLow, fHigh, outputRms, inputRms, outputV2, inputV2, relError,
  evaluations, converged}`. Adaptive Simpson in ln(f/fLow), so any valid band
  integrates however narrow (10 panels per decade plus the gain's pole and
  zero frequencies as breakpoints, none merged away), refined globally (the
  panel with the largest |S₂ − S₁| is split) until those differences sum to
  ≤ 1e-6 of each integral (`converged`) or 200 000 evaluations. `relError` is
  that sum relative to the integral plus κ₁·eps of the band's solves (on the
  row- and column-equilibrated matrix). A gain zero on the jω axis (|re| ≤ 1e-9·|im|) in the band where the
  output noise does not vanish makes `inputV2`/`inputRms` null, with
  `unavailable`. (ngspice's own `inoise_total` can be off by percent; compare
  with an integral of its spectrum.)
- `inputLowFreq`: S_in at s → 0 from thermal and shot sources in closed form,
  `4kT·(…) + 2q·(…)`, e.g. `4kT\left(\frac{2}{3 g_{m1}} + \frac{1}{{g_{m1}}^{2} R_{D}}\right)`
  for a CS stage. `exact`, `display` (junction leakage dropped when that moves
  it ≤ 1e-3) and `simplified` (r_o → ∞ leading order of the display form, then
  magnitude pruning; the smallest form within `tolerance`), each `{latex,
  value, thermal: {num, den}, shot: {num, den}, terms}`; `currents` lists the
  bias-current symbols I_{C1}, I_{B1}, I_{D1} (one per matched group, e.g.
  I_{D1,2}); `check` compares the exact value with the numeric DC solve,
  within rounding and the match tolerance. Flicker is numeric only.
  `unavailable` says why when there is no DC limit: no gain at DC (also when
  it vanishes at the values or once matched symbols merge), singular at
  s = 0, or too large: any determinant, product, sum or difference in it
  over `maxTerms` (the spectra are still given).
  Built from S_in = Σ S_k (N_k/N_A)² with Cramer numerators on the gain
  system at s = 0, so the determinant cancels exactly.
