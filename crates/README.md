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
   1 Hz–100 GHz stays within `tolerance`. Magnitude pruning (here, in noise
   and in distortion) moves no coefficient of a numerator or denominator by
   more than `tolerance` of itself, drops terms of equal size together, and
   cancels the common factors left.

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
[--nonlinear M1,Q2] [--order 2|3] [--amplitude A] [--tol 0.05] [--verify] [--symbolic]`, or
`analyze(netlist, request)` in WASM, where `request` holds the same fields
(`input`, `inputNeg`, `mode`, `match`, `output`, `ref`, `freqs`, `rin`, `rout`,
`noise`, `noiseBand`, `nonlinear`, `order`, `amplitude`, `tolerance`, `verify`,
`symbolic`, `maxTerms`). The response is JSON, or
`{"error": "..."}` on failure, including when an exact polynomial of
gain, rin or rout (a determinant, or the sum or difference of two) would
exceed `maxTerms` terms (default 2,000,000).

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
  power of s), labelled `assumption: "ro ≫ R, 1/gm"`, then the same limit
  g_mb → 0 (labelled `"ro ≫ R, 1/gm and gmb ≪ gm"` when that drops a term),
  except where it leaves a pure number (a follower into an ideal current
  source keeps g_m/(g_m + g_mb)). The r_o of a device
  outside saturation (MOS triode, BJT saturation) stays finite in every
  leading-order form, with the region warning. Symbolic mode, which has no
  operating point, knows one such case: two MOSFETs of one type and model
  on a shared gate, one's drain on the other's source; that one is in
  triode. Then `values`
  (`f, re, im, mag, phaseDeg`; `inf: true` with null parts when infinite),
  `poles` and `zeros` (in Hz), and `check`.
- `op` (null in symbolic mode) holds node voltages, source branch currents, and
  per-device region, currents, voltages and small-signal conductances.
- `params` lists each symbol's name, LaTeX, value and unit; `warnings` collects
  devices out of their intended region, ignored model parameters,
  cross-coupled (latch) pairs that may have several DC solutions, junctions
  forward-biased by ideal sources (also named in the DC error when that is
  why DC fails), two-terminal elements with both ends on one node
  ("CSB has both ends at 0"), and so on.

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
  fraction}`. When the output PSD is positive and finite, the listed
  fractions plus `omitted.fraction` sum to 1; when it is 0, every fraction
  is 0; when it is infinite, finite sources have fraction 0 and the
  infinite ones null.
- `sources`: `[{element, kind, psd (LaTeX, with M when a MOSFET's M ≠ 1), white, flicker: {coef, exp}}]`.
- `integrated` (with `noiseBand`, finite, 0 < fLow < fHigh, at most 40
  decades): `{fLow, fHigh, outputRms, inputRms, outputV2, inputV2, relError,
  evaluations, converged}`. Adaptive Simpson in ln(f/fLow), so any valid band
  integrates however narrow (10 panels per decade plus the gain's pole and
  zero frequencies as breakpoints, none merged away), refined globally (the
  panel with the largest |S₂ − S₁| is split) until those differences sum to
  ≤ 1e-6 of each integral (`converged`) or 200 000 evaluations. `relError` is
  that sum relative to the integral plus κ₁·eps of the band's solves (on the
  row- and column-equilibrated matrix); when that LU bound exceeds 1e-6 a
  warning says so ("ill-conditioned in the band"), as for the spectra. A gain zero on the jω axis (|re| ≤ 1e-9·|im|) in the closed band
  (within 1e-12 of an endpoint counts as at it) where the output noise does
  not vanish makes `inputV2`/`inputRms` null, with
  `unavailable`. (ngspice's own `inoise_total` can be off by percent; compare
  with an integral of its spectrum.)
- `inputLowFreq`: S_in at s → 0 from thermal and shot sources in closed form,
  `4kT·(…) + 2q·(…)`, e.g. `4kT\left(\frac{2}{3 g_{m1}} + \frac{1}{{g_{m1}}^{2} R_{D}}\right)`
  for a CS stage. `exact`, `display` (junction leakage dropped when that moves
  it ≤ 1e-3) and `simplified` (r_o → ∞ leading order of the display form,
  in symbolic mode then g_mb → 0 with the same labels as above, then
  magnitude pruning; the smallest form within `tolerance`; when even the
  display form misses `tolerance`, the exact form, `method: "exact form"`),
  each `{latex,
  value, thermal: {num, den}, shot: {num, den}, terms}`; `currents` lists the
  bias-current symbols I_{C1}, I_{B1}, I_{D1} (one per matched group, e.g.
  I_{D1,2}); `check` compares the exact value with the numeric DC solve,
  within rounding and the match tolerance. Flicker is numeric only.
  `unavailable` says why when there is no DC limit: no gain at DC (also when
  it vanishes at the values or once matched symbols merge), singular at
  s = 0, or too large: any determinant, product, sum or difference in it
  over `maxTerms` (the spectra are still given), including the full model's
  form, needed when the junctions omitted for the gain matter for the noise.
  Built from S_in = Σ S_k (N_k/N_A)² with Cramer numerators on the gain
  system at s = 0, so the determinant cancels exactly.

## Distortion (`nonlinear: ["M1", ...]`, `order` 2|3 (default 3), `amplitude` (default 10 mV, or 1 µA for a current input))

Each listed device's DC current is expanded to `order` about the operating
point in all of its controlling voltages, exactly (truncated Taylor
arithmetic on the device equations). MOSFET I_D(v_GS, v_DS, v_BS) (in the
effective frame when v_DS < 0) and its bulk junction currents I_BS, I_BD,
BJT I_C and I_B in (v_BE, v_CE), diode I_D(v_D):
i = (small-signal model) + Σ K_α·u^α over 2 ≤ |α| ≤ order, where u are the
small-signal control voltages. The linear part is the derivative of the DC
current, so a₁ is the slope of the DC transfer curve: under forward body bias
(v_BS > 0) g_mb is γ·g_m/(2√φ), not ngspice's AC γ·g_m/(2·sarg), and a warning
says so (a₁ can then differ from the gain). Matched devices whose corrected
g_mb differ by more than MATCH_REL get one g_mb symbol each (with a
warning); otherwise their difference joins the match mismatch. A device biased where its
equations switch branch (v_GS = V_TH, v_DS = V_DSAT, v_DS = 0 with λ or γ,
v_BS = 0 with γ and the bulk not tied to the source, a junction at −3·V_T,
each within 1e-9 V) gets a warning: its expansion is one-sided. Past the
exponential's clamp (709·V_T forward) a junction's current is linear, as in
the DC model, so it has no higher-order coefficients. Names: `K_{2g,M1}` (plain `K2g_M1`) =
½∂²I_D/∂v_GS²; `K_{g\,d,M1}` = ∂²I_D/∂v_GS∂v_DS; `K_{2g\,d,M1}` =
½∂³I_D/∂v_GS²∂v_DS; variables g, d, b; BJT `K^{C}_{2be,Q1}`,
`K^{B}_{be\,ce,Q1}` (`KC2be_Q1`, `KBbece_Q1`); MOS bulk junction
`K^{BS}_{2b,M1}` (`KBS2b_M1`); diode `K_{2,D1}`. Matched devices (any of their
parameters merged into one symbol: g_m, or r_bs for a MOSFET in cutoff)
with equal coefficients share one symbol
(`K_{2g,M1,2}`), so a matched pair's even orders cancel exactly. Coefficients
that are exactly zero, or whose omission moves no requested a_n (n ≤
`order`) by more than 1e-9 (proven on the full numeric model, smallest
first), are left out of the closed
form. Junction leakage coefficients (bulk junctions, and the collector-base
branch i_μ = I_BC/BR + gmin·v_BC in I_C and I_B) go with r_bs, r_bd, r_μ.

Method of nonlinear currents: A·x₁ = b, A·x₂ = −i₂(u₁), A·x₃ = −i₃(u₁, u₂)
with the same MNA matrix, so v_out = a₁v_in + a₂v_in² + a₃v_in³ (memoryless,
s → 0) in closed form: a_n = N_n/(vid^n·D^{2n−1}) from Cramer numerators and
transfer cofactors. Response `distortion`:

- `coefficients`: `[{order, value, numeric, latex, plain, terms, display, simplified}]`
  for a₁…a_order (`numeric` from the direct numeric solve, full model).
- `hd2` = |a₂|A/(2|a₁|), `hd3` = |a₃|A²/(4|a₁|), `iip3` = √(4|a₁|/(3|a₃|)) (input
  amplitude), each `{latex, value, display, simplified}`,
  latex like `\frac{A}{2}\left|\frac{K_{2g,M1}}{g_{m1}}\right|`. Infinite
  (HD with a₁ = 0 and the other a_n ≠ 0, IIP3 with a₃ = 0) is
  `{latex: "\infty", value: null, display: {latex: "\infty", value: null},
  simplified: (same)}`. Null means unavailable: `hd3` and `iip3` for
  `order` 2, and any of the three where it is 0/0 at DC (a₁ = 0 with a₂ or
  a₃ = 0, e.g. an input blocked by a coupling capacitor), or where the
  value exceeds f64 at a huge amplitude (with a warning; never `\infty`,
  which only a₁ = 0 gives). An a_n (a₁ included) counts as 0 here when
  within 1e-12 of the size of its terms (see `check`).
- `vsFreq`: `[{f, hd2, hd3}]` at `freqs` from H₂(jω,jω) and H₃(jω,jω,jω)
  (LU solves at ω, 2ω and, for `order` 3, 3ω on the full model; a singular
  system at 2ω or 3ω leaves only that order null). A value is null when
  unavailable (also beyond f64, warned) or infinite; `hd2Infinite: true` (`hd3Infinite: true`) is
  present only when it is infinite (H₁ = 0, H₂ (H₃) ≠ 0, each by the same
  1e-12 rule at that frequency: a notch at f leaves H₁ a roundoff residual).
- `taylor`: every nonzero coefficient `{element, current, monomial, order, value, kept}`;
  `symbols`: the K symbols in the numerators of the a_n and HD_n shown in
  closed form (`[]` when none is);
  `omissionError`; `check` `{ok, maxRelDiff, orders, matchBound}`: each
  exact a_n that materialized against the numeric reference (`orders` lists
  which; null when none did), allowing 4× `matchBound`, the relative effect
  of the accepted match mismatch (mismatch·Σ|p·∂a_n/∂p| over merged linear
  parameters and Taylor coefficients; a merged a_n that cancels to 0 keeps
  that residual numerically). The difference is
  relative to the largest of the two values and the size of the terms a_n
  sums: each Taylor coefficient's part Σ|K·∂a_n/∂K|, and for v_out and
  v_ref the largest size of the sum a defining row gives for x_c,
  (|rhs_r| + Σ_{k≠c} |A_rk|·s_k)/|A_rc|, over its KCL row (A_cc ≠ 0) and
  each constraint row on it (voltage source, VCVS, inductor), where s_k is
  |x_k| in a KCL row and node k's own size (recursively) in a constraint
  row, so a buffered node is as large as what it buffers. An a_n that
  cancels exactly (a matched pair's a₂) is then not compared with its
  numeric roundoff alone.
- Every field is always present. Sums are taken in a canonical order and
  held to the term budget whole, so terms that cancel never decide it. The
  term budget holds per quantity: one
  whose exact closed form would exceed 100k terms or `maxTerms` (its
  numerator or the parts it is built from, which for a_n include
  a_{n−1}'s, or the D^{2n−1} under it; e.g. a 5T OTA's a₃ with junction
  leakage kept) is `skipped` (value numeric) while lower orders stay exact,
  and its `display` comes from the leakage-free model (its Taylor
  coefficients without leakage), accepted only within 1e-3; a leakage-free
  form with a₁ = 0 (leakage carries the fundamental) is no display, so a
  finite numeric value is shown with `leakageMatters`, never null or
  `\infty`. When the
  analysis model's form misses the full numeric a_n by more than 1e-11 the
  full model's forms are used instead (each under the same budget), and a
  match the full model's junctions break is warned
  (`"M1 and M2 differ, not matched"`).
- `display`/`simplified` work as for the other quantities; simplified is the
  r_o → ∞ leading order (Taylor coefficients with a v_DS/v_CE derivative count
  as output conductances), then magnitude pruning, within `tolerance`.
