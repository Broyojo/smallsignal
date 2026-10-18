# Small-Signal Assumptions

Status: `proposed`

Primary owner: `crates/smallsignal-core` (`assume.rs`)

Per-device assumptions an engineer makes in hand analysis (neglect r_o, g_mb,
r_π, r_μ, bulk junctions; take a passive open or shorted; split a feedback
capacitance by the Miller approximation; expect a region),
applied by the solver to the formulas it shows while every number stays the
full model's. The solver's general contract is in
[crates/README.md](../../crates/README.md#contract). The panel sets them
in its Assumptions section, and its Suggestions section applies
`suggestions` items to the same store.

## Rules

- An assumption other than a Miller split is an exact limit taken before
  expansion, never a dominance
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
- A Miller split replaces a capacitance C between two signal nodes a and b
  (an explicit capacitor, or a device's capacitance) by C_in = C(1 − K)
  from a to ground and C_out = C(K − 1)/K from b to ground, where
  K = v_b(0)/v_a(0): an LU solve at s = 0 of the gain's assumed model (its
  restored terms back) under the gain's excitation. Every capacitance is
  open at DC, so taking C out does not change K.
- One K serves every quantity, so one split model serves gain, Zin, Zout,
  noise and distortion, as in hand analysis. Miller's theorem keeps the
  node voltages only of the excitation that defines K: Zin with a voltage
  or current input is that excitation, Zout (a test current at the output)
  is not, and its `fullModelError` shows the difference. K under Zout's own
  excitation is not used: v_a(0) is 0 wherever C is the only path back.
- An explicit capacitor is oriented so that |K| ≥ 1 (as written in
  symbolic mode); a device's capacitance keeps its terminals' order:
  K = v_d/v_g for C_gd, v_c/v_b for C_μ, v_s/v_g for C_gs. The split model is
  the same either way round.
- C_in and C_out are two independent parameters, so the determinant stays
  multilinear. After expansion each form is mapped exactly onto C and the
  symbol K (C_in → C(1 − K), C_out → C(K − 1)/K, numerator and denominator
  times K^m, m the highest power of C_out): the forms are exact for the
  split model, and `fullModelError` and the root pairs show what it costs
  (Miller's RHP zero g_m/C is `assumed: null`, removed).
- A split is refused, with a warning, for a capacitance not between two
  signal nodes (`No Miller split for CL, it is not between two signal
  nodes`; ground, a supply or two merged nodes), with no DC signal at a or
  no DC solution (`K is undefined`), with none at b (`K is 0`; for an
  explicit capacitor, at either end), or absent from the model (`it is not
  in the model`). A negative capacitance is allowed and warned:
  `Miller C_in of CC is negative, K > 1`,
  `Miller C_out of cgs of M1 is negative, 0 < K < 1`.
- Matched elements share assumptions, terms, Miller splits and declared
  regions alike: a group whose members differ is not matched
  (`M1 and M2 have different assumptions, not matched`). Each split keeps
  its own C and K.
- Noise drops a source from the closed form only where an assumption takes
  its PSD to 0 or shorts it: r_π (β → ∞, so I_B → 0) drops base shot and
  flicker, an open or shorted R or diode drops its sources.
- Distortion drops the Taylor terms of the dependence an ignored
  conductance linearizes: MOS r_o the v_DS terms of I_D, g_mb its v_BS
  terms, r_bs and r_bd the bulk junction currents; BJT r_o the v_CE terms of
  I_C without leakage, r_π I_B without leakage, r_μ the collector–base
  branch; an open or shorted diode all of its terms.
- Suggestions (`suggest`) need an operating point and are numeric only, so
  they hold over the term budget. A candidate is one unit not in effect
  (a term of one element or of a matched group the solver merged; not the
  other of an open or short asked for, even one absent from the model),
  or one transistor type's term over all its units when it has two or
  more (`scope: "type"`). A Miller split is never a candidate, and what a
  split in effect keeps (its capacitance, a capacitor's or diode's open
  and short) is none either. Its `alone` is the `fullModelError`
  metric, by LU on the model the analysis would build (splits included)
  with it added to the
  current assumptions, restore included, on the same check grid. A
  candidate that changes what the quantity puts back is left out
  (`unbounded`). Those with `alone` ≤ the threshold are sorted ascending
  and taken greedily: each is kept when the deviation of everything kept
  with it is still ≤ the threshold (`cumulative`), else skipped (null).
  `combined` is the kept set's deviation; applied, it is the analysis's
  `assumed.maxRelError` to within the 1e-9 of a value that proven junction
  omissions allow.
- Evaluation stops once `timeLimit` seconds (default 20; 0 evaluates
  nothing) have passed, or after `maxCandidates` (default 400, type-wide
  candidates first), and `capped` says which.
- Certificates (`--certificate`) cover the gain's assumed element list, a
  Miller split's C_in and C_out as two parameters.

## Contract

Request `assume` (CLI `--ignore M1:ro,C1:short`, `--region M3:triode`,
`--miller CC,M2:cgd`):

```json
{
  "ignore": [{ "element": "M1", "term": "ro" }],
  "regions": [{ "element": "M3", "region": "triode" }],
  "miller": [{ "element": "CC" }, { "element": "M2", "term": "cgd" }]
}
```

- `miller` items name a capacitance as `ignore` names a term: an explicit
  capacitor by its element alone (no term, or null: the capacitor is the
  capacitance), a device's by a capacitance term (`cgs`, `cgd`, `cgb`,
  `cbs`, `cbd`, `cpi`, `cmu`, `ccs`, `cj`). A repeat is one split.

- Terms: `ro`, `gmb`, `rbs`, `rbd`, and the capacitances `cgs`, `cgd`,
  `cgb`, `cbs`, `cbd` taken to 0 (MOSFET); `ro`, `rpi`, `rmu`, `cpi`, `cmu`,
  `ccs` (BJT); `open`, `short` (R, C, L, diode) and `cj` (diode). Regions: `saturation`, `triode`,
  `cutoff` (MOSFET); `forward-active`, `saturation`, `reverse-active`,
  `cutoff` (BJT).
- Errors: `assume: no element 'M9'`, `assume: M1 has no term rpi`,
  `assume: C1 cannot be both open and short`, `assume: M1 has no region
active`, `assume: M1 has two regions`, `assume: CC cannot be both open
and Miller` (or short), `assume: cgd of M1 cannot be both neglected and
Miller`, `assume: R1 is not a capacitance`, `assume: ro of M1 is not a
capacitance`, `assume: M1 needs a capacitance term for Miller`.

Response:

- `assumable` (always): `[{element, type, terms, miller}]`, the terms each
  element's full model has (`short` always), and its capacitances between
  two signal nodes of the full model's gain system that a split can take
  (the term, null for a capacitor; empty when none).
- `assumptions` (with `assume`): `applied` `[{element, term, latex}]`
  (latex such as `r_{o1,2} \to \infty`, `g_{mb1} = 0`, `C_{1} \to \infty`),
  `absent` `[{element, term}]` (asked for, not in the model), `regions`
  `[{element, assumed, actual}]` (`actual` null without an operating point),
  `miller` `[{element, term, latex, symbol, k, definition}]`, the splits
  made: `latex` the capacitance (`C_{C}`, `C_{gd2}`), `symbol` its K
  (`K_{CC}`, `K_{gd2}`; in `params` as `K_CC`, `K_cgd_M2` with K's value),
  `k` null in symbolic mode, `definition` `{latex, num, den}` the exact DC
  ratio of the Cramer numerators of the model K's value comes from (every
  junction kept, its symbols in `params`; junction leakage left out where
  it moves K by at most 1e-3), null without an exact form or past 400
  terms. C_in and C_out appear in no form and no `params`. A form whose
  substitution passes `maxTerms` is numeric, as an over-budget
  determinant is.
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

Request `suggest` (CLI `--suggest gain:0.01`): `{quantity: "gain" | "rin"
| "rout", threshold?: 0.01, timeLimit?: 20, maxCandidates?: 400}`; rin
and rout need `rin` and `rout`. Errors: `suggest: needs a bias point`,
`suggest: no quantity 'zin' (use gain, rin or rout)`, `suggest: rout needs
rout in the request`, `suggest: threshold must be above 0`.

Response `suggestions`: `{quantity, threshold, base, items, combined,
candidates, evaluated, unbounded, capped}`, `base` the current
assumptions' deviation (null when the quantity is unbounded throughout),
`capped` null, `"time"` or `"candidates"`. `items`
`[{elements, term, type, scope, alone, cumulative}]`, `scope` `part`,
`group` or `type`: one item can cover several elements, which Apply
writes one by one.
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
- Miller: K, refusals, warnings, the split as two grounded capacitances,
  the substitution at random points and at K = 1 (C open):
  `crates/smallsignal-core/tests/miller.rs` and `miller.rs`; K and the
  split's values against `oracle/indep.py` (`assume_ota_miller_cc`,
  `assume_cs_cgd_miller`); the split forms against hand KCL in K, and
  their poles with the textbook K against −1/(R_S(C_gs + C_gd(1 + g_m R_D)))
  and the dominant pole with C_C(1 + A_2): `oracle/textbook.py`
  (`miller_split_*`).
- Lean certificates for an assumed element list: `lean/check_all.sh`.
- Suggestions within the threshold, equal to a direct solve of the applied
  set, in matched-group units, never restoring, capped:
  `crates/smallsignal-core/tests/suggestions.rs`; applied sets against the
  rebuild: `oracle/compare.py` (sidecar `suggest`).
- Every emitted field is declared:
  `packages/small-signal/src/end-to-end.test.ts`.
