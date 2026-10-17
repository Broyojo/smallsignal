# Small-Signal Assumptions

Status: `proposed`

Primary owner: `crates/smallsignal-core` (`assume.rs`)

Per-device assumptions an engineer makes in hand analysis (neglect r_o, g_mb,
r_π, r_μ, bulk junctions; take a passive open or shorted; expect a region),
applied by the solver to the formulas it shows while every number stays the
full model's. The solver's general contract is in
[crates/README.md](../../crates/README.md#contract); the panel that sets
assumptions is a later change.

## Rules

- An assumption is an exact limit taken before expansion, never a dominance
  approximation: a neglected conductance is substituted by 0 (each minor is
  multilinear, so this is the limit r → ∞ or g_mb → 0), a short (C → ∞,
  R, L or r_d → 0) is the coefficient of that parameter, which merges its
  nodes, and an open (C → 0, R, L or r_d → ∞) leaves the element out.
  g_m cannot be neglected.
- The operating point always comes from the full netlist. A region is
  checked against it and never imposed: a match drops the generic region
  warning, a mismatch warns `M2 is in saturation, assumed triode`. Without
  an operating point a declared region only decides which r_o the
  hand-analysis form keeps finite (MOS triode, BJT saturation).
- `values`, `poles`, `zeros`, `poleCount`, `zeroCount`, the noise spectra
  and contributors, distortion `numeric` and `vsFreq` stay the full
  model's, computed exactly as without assumptions. `exact`, `display`,
  `simplified` and `check` describe the assumed model.
- `maxRelError`, `relError` and `tolerance` stay relative to the model the
  forms describe. `fullModelError` on each form is its distance from the
  full model: over the check grid, |H − H_full| / max(|H_full|, 1e-3·peak),
  null when unbounded or without numbers.
- A quantity whose denominator the assumptions make vanish at s = 0 (a pole
  at DC, or no solution), with junction leakage left out as hand analysis
  leaves it out, where the full model's does not, gets back the union of the
  smallest sets of assumption units (one unit per term and matched group)
  that avoid it. Every set of one or two units is searched, and of three
  while there are at most 30 units. Past that it is an irreducible set,
  found in group and term order, never the request's. It is listed in
  `assumed.restored` and warned:
  `ro of M1 kept, gain is unbounded without it` (gain, Zin, Zout).
- Matched elements share assumptions: a group whose members differ is not
  matched (`M1 and M2 have different assumptions, not matched`).
- Noise drops a source from the closed form only where an assumption takes
  its PSD to 0 or shorts it: r_π (β → ∞, so I_B → 0) drops base shot and
  flicker, an open or shorted R or diode drops its sources.
- Distortion drops the Taylor terms of the dependence an ignored
  conductance linearizes: MOS r_o the v_DS terms of I_D, g_mb its v_BS
  terms, r_bs and r_bd the bulk junction currents; BJT r_o the v_CE terms of
  I_C without leakage, r_π I_B without leakage, r_μ the collector–base
  branch; an open or shorted diode all of its terms.
- Certificates (`--certificate`) cover the gain's assumed element list.

## Contract

Request `assume` (CLI `--ignore M1:ro,C1:short`, `--region M3:triode`):

```json
{
  "ignore": [{ "element": "M1", "term": "ro" }],
  "regions": [{ "element": "M3", "region": "triode" }]
}
```

- Terms: `ro`, `gmb`, `rbs`, `rbd` (MOSFET); `ro`, `rpi`, `rmu` (BJT);
  `open`, `short` (R, C, L, diode). Regions: `saturation`, `triode`,
  `cutoff` (MOSFET); `forward-active`, `saturation`, `reverse-active`,
  `cutoff` (BJT).
- Errors: `assume: no element 'M9'`, `assume: M1 has no term rpi`,
  `assume: C1 cannot be both open and short`, `assume: M1 has no region
active`, `assume: M1 has two regions`.

Response:

- `assumable` (always): `[{element, type, terms}]`, the terms each
  element's full model has (`short` always).
- `assumptions` (with `assume`): `applied` `[{element, term, latex}]`
  (latex such as `r_{o1,2} \to \infty`, `g_{mb1} = 0`, `C_{1} \to \infty`),
  `absent` `[{element, term}]` (asked for, not in the model), `regions`
  `[{element, assumed, actual}]` (`actual` null without an operating point).
- Each of `gain`, `rin`, `rout`: `assumed` `{values, relError,
maxRelError, infinite?, resolution, restored: [{element, term, latex}],
poles, zeros}`, the root lists as pairs `{assumed, full, relError}`
  (greedy by |ln|a| − ln|f|| + |Δarg| within a factor of 10, DC roots only
  with DC roots, unpaired on one side null). `maxRelError` equals
  `exact.fullModelError`; `resolution` is the comparison's own rounding.
- `fullModelError` on every `exact`, `display` and `simplified` form, on the
  noise `inputLowFreq` forms and on the distortion forms; `ignored: true`
  on noise `sources` and distortion `taylor` entries left out.
- `params`, `omittedJunctions` and `omissionError` describe the assumed
  models; `verify` checks the gain's.
- Types: [`packages/small-signal/src/types.ts`](../../packages/small-signal/src/types.ts).
  The editor netlist names each part's `instancePath` (instance ids from the
  top Cell down) so stored assumptions follow a part across renames.

## Acceptance criteria

- The multilinearity identity, restoration, unchanged values, matching,
  regions, noise and distortion filters and errors:
  `crates/smallsignal-core/tests/assumptions.rs`.
- Assumed values against an independent 60-digit rebuild and ngspice
  equivalents, assumed poles against the assumed determinant:
  `oracle/compare.py` on the `assume_*` corpus circuits.
- Exact forms equal the limit of hand KCL: `oracle/textbook.py`
  (`assume_*` cases).
- Lean certificates for an assumed element list: `lean/check_all.sh`.
- Every emitted field is declared:
  `packages/small-signal/src/end-to-end.test.ts`.
