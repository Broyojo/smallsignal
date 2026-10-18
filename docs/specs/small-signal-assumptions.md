# Small-Signal Assumptions

Status: `proposed`

Primary owner: `crates/smallsignal-core` (`assume.rs`)

Per-device assumptions an engineer makes in hand analysis (neglect r_o, g_mb,
r_π, r_μ, bulk junctions; take a passive open or shorted; split a feedback
capacitance by the Miller approximation; impose a MOSFET's region),
applied by the solver to the formulas it shows while every number stays the
full model's, and chosen by the numbers for the numeric ≈ forms. The
solver's general contract is in
[crates/README.md](../../crates/README.md#contract). The panel sets them
in its Assumptions section and a device menu on the drawing, its
Suggestions section applies `suggestions` items to the same store, and its
Options choose how ≈ forms are made.

## Rules

- An assumption other than a Miller split is an exact limit taken before
  expansion, never a dominance
  approximation: a neglected conductance is substituted by 0 (each minor is
  multilinear, so this is the limit r → ∞ or g_mb → 0), a short (C → ∞,
  R, L or r_d → 0) is the coefficient of that parameter, which merges its
  nodes, and an open (C → 0, R, L or r_d → ∞) leaves the element out.
  g_m cannot be neglected.
- The operating point always comes from the full netlist. A MOSFET's
  `saturation` or `triode` is imposed on it: the device is linearized with
  that region's ngspice-47 level-1 equations at the same V_GS, V_DS, V_BS,
  in the same effective frame (drain and source swapped when V_DS < 0).
  Saturation: g_m = β(1 + λV_DS)V_ov, g_ds = λβV_ov²/2, Meyer C_gs =
  ⅔C_ox·W·L and C_gd = C_gb = 0 before overlap. Triode: g_m = β(1 +
  λV_DS)V_DS, g_ds = β(1 + λV_DS)(V_ov − V_DS) + λβV_DS(V_ov − V_DS/2),
  Meyer's triode split. Both: g_mb = g_m·γ/(2·sarg), V_ov = V_GS − V_TH,
  β = KP·W/L·M, the output conductance r_o (saturation) or R_on (triode).
  Every other assumption applies to that model, and `fullModelError`
  shows the cost. Warning: `M1 bias says triode`.
- A region is refused, keeping the bias's linearization, when the channel
  is off (`M1 is off, cannot assume saturation`), and triode when V_DS ≥
  V_ov, where the triode current falls with V_DS (`M1 is saturated,
  cannot assume triode`). So in numeric mode triode is either the bias's
  region or refused. The bias's own region changes nothing and drops the
  generic region warning.
- Without an operating point a declared MOS region decides r_o or R_on
  and the capacitances (Meyer C_gd in triode), over the wiring's
  inference. BJT regions and MOS `cutoff` are only checked: a mismatch
  warns `Q2 is in saturation, assumed forward-active`; without an
  operating point a BJT's saturation keeps its r_o finite.
- The noise and distortion closed forms of an imposed region use its
  linearization (the thermal source's g_m, that region's Taylor
  coefficients). Their spectra and numeric values stay the full model's.
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
- A MOSFET in triode (by its operating point; in symbolic mode inferred or
  declared, as above) has its channel's R_on (`ron_M1`, R_{on1}, the same
  1/g_ds) in place of r_o, in the forms, `params` and the panel's bias
  table. It has no `ro` term: `assumable` leaves it out, a request for it
  (a type default too) is `absent`, and it is never a suggestion or named
  candidate. R_on → ∞ opens the switch, which is no hand-analysis limit.

## Panel

- While the panel is open, a plain click (no drag) on a transistor,
  capacitor or diode drawn in the open Cell, its canvas badge, or its row's
  name in the Assumptions table opens its device menu beside it (a sheet
  along the bottom below 600 px). It offers the part's `assumable` terms
  (leakage as one), C_gd or C_μ Miller where offered, a capacitor's or
  diode's open, short or Miller, and a MOSFET's region (Auto, Saturation,
  Triode), with its bias region, the solver's sentences about it and the
  gain's distance from the full model. Choices apply at once. Esc, Close
  or a press elsewhere closes it (Esc does nothing else in the editor);
  from the keyboard focus moves in and back.
- The menu and the table write one store: a matched group's row applies
  to every member and the menu says so; a type default shows dashed, from
  "All NMOS". Regions are per part only: a type default would impose one
  circuit's region on every circuit.
- A part with any choice in effect has a badge at its top right: its
  region, else open, short or Miller, else ≈; amber when the bias
  disagrees with the region or refuses it.
- The table keeps every choice in one overview, collapsed by default. Its
  Region column is the MOSFETs' (auto, saturation, triode). The panel sends
  no BJT or cutoff region, which the solver would only check.
- A card with an imposed region notes it (`M1 assumed saturated`); the
  bias table shows that region's g_m and r_o, marked assumed, with the
  bias's region.

## Named simplified forms

- In numeric mode, with `approx: "named"` (the default), the `simplified`
  form of gain, Zin and Zout is a named limit of the model under the
  request's assumptions: element limits by the same substitution and
  restore as `assume`, then `display`'s junction-leakage rule and
  common-factor cancellation, optionally followed by the hand-analysis
  limit r_o ≫ R, 1/g_m. It drops no nameless term.
- Element candidates are the suggestion candidates of the terms `ro`,
  `gmb`, `rbs`, `rbd`, `rmu` and the device capacitances, per element or
  matched group (none type-wide), whose symbol appears in the display
  form. Never r_π, a passive's open or short, or a Miller split; a split
  in effect keeps its K. Their set is the suggestions' greedy one with
  threshold `tolerance`; if its form is over the budget or the
  tolerance, the set without its last assumption is tried, four sets at
  most.
- The hand-analysis limit is symbolic mode's leading order: the output
  resistances (r_o, r_μ, junction leakage; not a triode channel's R_on)
  of a set of devices scaled as r/ε together, numerator and denominator
  each cut to their lowest order in ε per power of s, then cancelled. It
  is taken on the display form and on the element set's form, per device
  or matched group: on all of them, and, when that is over the
  tolerance, on the subset with the fewest terms within it (every subset
  while there are at most 8 devices and 2,000 terms, else devices left
  out one at a time, the closest first).
- Every form is measured on the same check grid and metric against the
  model the forms describe: the full model, or the request's assumed one
  (whose own cost each form's `fullModelError` reports). Of those whose
  reported error (that distance plus the proven junction omission) is
  within `tolerance` and with fewer terms than the display form, the one
  with the fewest terms is shown; on a tie, element limits alone, then
  fewer of them, then the smaller error. A form that vanishes
  identically (a limit that cuts the only signal path) is measured the
  same way.
- Without one, `simplified` is the display form with `named: []`, and
  `none: true` when some candidate appeared in the form.
- The label (`assumption`) names what the form takes, element limits
  grouped by kind (r_o, g_mb, junction leakage, capacitances): one by its
  symbol, "r_o2 → ∞"; several by kind and element, "r_o → ∞ for M2, M4",
  or by kind alone when they are every candidate of that kind in the form,
  "g_mb → 0"; then the hand limit, "r_o ≫ R, 1/g_m", with its devices
  when not all of those in the form ("r_o ≫ R, 1/g_m for M1, M2"); joined
  "A, B and C"; "_" starts a subscript up to the next space.
- `approx: "terms"` keeps the smallest-terms form
  ([crates/README.md](../../crates/README.md#pipeline)). Symbolic mode
  keeps its hand-analysis limit whatever `approx` says. The noise and
  distortion closed forms keep their own simplification.
- The panel's Options offer "Named assumptions" (default) and "Smallest
  terms", kept in `localStorage` (`smallsignal.approx`). A named form's
  note reads "r_o2 → ∞, within 0.25%", under assumptions "…, 2.1% from
  full model" (signs and large distances:
  [small-signal-panel.md](small-signal-panel.md#rules)); `none` reads
  "No simple form within 5.0%."

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
  `[{element, assumed, actual, effect, linearized?}]` (`actual` null without
  an operating point; `effect` `imposed`, `same`, `refused` or `checked`;
  `linearized` `{gm, gds, gmb}` of a region imposed on a bias),
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

Request `approx` (CLI `--approx named|terms`): `"named"` (default) or
`"terms"`; else `approx: no method 'x' (use named or terms)`. Each
numeric `simplified` carries `method` (`"named"` or `"terms"`); a named
one also `named` `[{elements, term, latex}]` (the element limits, latex
such as `r_{o2} \to \infty`), `leadingOrder` `{elements, all}` (when the
hand limit is taken), `assumption` (the label, when either is) and
`none` (only when true). Its `maxRelError` is against the model the
forms describe.

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
- Imposed regions: the saturated linearization at a triode bias and its
  hand form, refusals, the source/drain swap, noise and distortion on the
  imposed model, symbolic override of the wiring:
  `crates/smallsignal-core/tests/assumptions.rs`, Meyer's branch in
  `caps.rs`; the linearization, its capacitances and the assumed values
  against `oracle/indep.py`'s own level-1 equations at ngspice's bias:
  `oracle/compare.py` (`assume_inverter_saturation`,
  `assume_cs_triode_refused`); the inverter's −(g_m1 + g_m2)(r_o1 ∥ r_o2)
  with the level-1 saturation values: `oracle/textbook.py`
  (`inverter_forced_saturation`).
- Device menu: its model, badges, labels and placement:
  `apps/editor/src/features/small-signal/small-signal-device-menu.test.ts`;
  a click on M1 that neglects r_o with the card and table agreeing,
  saturation on the triode inverter, dragging and selection unchanged, the
  narrow sheet: `apps/editor/e2e/small-signal.spec.ts` (`device menu: …`).
- Lean certificates for an assumed element list: `lean/check_all.sh`.
- Suggestions within the threshold, equal to a direct solve of the applied
  set, in matched-group units, never restoring, capped:
  `crates/smallsignal-core/tests/suggestions.rs`; applied sets against the
  rebuild: `oracle/compare.py` (sidecar `suggest`).
- Named forms: the triode inverter's −R_on1(g_m2 + g_m1) and R_on1 with
  "r_o2 → ∞" and their error, the 5T OTA's g_m(r_o1,2 ∥ r_o3,4) and the
  cascode's (g_m2 + g_mb2) r_o1 r_o2 by the hand limit at their true
  error, the two-stage OTA's first-stage limit no longer than smallest
  terms, the request's assumptions kept, no form within the tolerance,
  smallest terms unchanged, R_on never a candidate:
  `crates/smallsignal-core/tests/named_approx.rs`, `edge_cases.rs`
  (`named_forms_drop_no_nameless_part`); the inverter's and the cascode's
  values against ngspice: `oracle/compare.py` (`inverter_triode`,
  `cascode_isrc`); the triode
  stack's R_on in hand KCL: `oracle/textbook.py` (`stack_shared_gate`); the
  label, the option and the bias table's R_on in the panel:
  `apps/editor/e2e/small-signal.spec.ts`.
- Every emitted field is declared:
  `packages/small-signal/src/end-to-end.test.ts`.
