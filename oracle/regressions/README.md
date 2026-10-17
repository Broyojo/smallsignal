# Fuzz regressions

Minimized circuits from the fuzz runs (`fuzz.py`, `triage.py`, `minimize.py`).
Each has a `.cir`, a `.json` sidecar and ngspice references in `expected/`. Run
them with:

```sh
SMALLSIGNAL_BIN=... uv run compare.py -v --corpus regressions --expected regressions/expected
```

## Round 1 (found at 51631b7a, all fixed in 2d7f3f01; they pass now)

| File | Root cause |
|---|---|
| `bulk_junction_forward` | MOS bulk-junction conductances were missing from the small-signal model. |
| `overflow_nan`, `overflow_nan_2` | Products of 1e15–1e20 Ω resistances overflowed f64 to NaN, and the cross-check skipped NaN. |
| `dc_nonconv_mos`, `dc_nonconv_mos2`, `dc_nonconv_mixed` | DC non-convergence on leakage-held nodes, F/H loops and reverse-mode devices. |
| `bjt_reverse_active_label` | A reverse-active BJT was labelled `cutoff`. |

## Oracle sidecar handling

| File | What it guards |
|---|---|
| `dist_true_shorthand` | `"distortion": true` means the default settings in generation and in compare.py (`run_ngspice.settings`), and a bias written `900m` parses in the dialect (`spice.value`). Its distortion block equals `dist_cs`'s. |

## Round 2: gate fuzz `fuzz-gate/` (seeds 500–509), solver binary `gate-bin` (= 2d7f3f01)

All seven repros below fail against `gate-bin`. They were minimized by
`minimize.py --kind verdict` (or `nonconv`), so the shrunk circuit keeps the
same evidence verdict, and checked to be physical (no junction above 1 A,
`physical.py`).

| File | Fuzz cases with this cause | Root cause (exact) | Suggested fix |
|---|---|---|---|
| `dc_reverse_limit_ulp`, `dc_reverse_limit_ulp_2` | 4 of the 5 "dc-nonconv" cases (wildmos_503_012, _505_026, _508_031, _509_021) | `dc.rs` `limit_mos`, reverse branch (od < 0). The original vgs is kept only if `vds == vgs - vgd`. In IEEE doubles vgs − (vgs − vds) ≠ vds (here −2.85 vs −2.8499999999999996). So at the exact fixed point it returns `lgd + vds`, 1 ulp off, `limited` is true on every iteration, and the `!limited` convergence test never passes. The trace shows x and the device state identical from iteration 3 on. It only happens for some voltages (vdd = 2.85, 3.6 fail; 1, 2, 3, 4.5 converge), and normal mode and the NMOS mirror image always converge. | Track whether fetlim/limvds changed anything with booleans instead of a float identity (return vgs unchanged when neither did), and/or flag `limited` only for a change above 1e-12·(1+\|v\|). The normal-mode branch got this fix in round 1. |
| `bulk_junction_stiff_floating_v`, `bulk_junction_stiff_inductor`, `bulk_junction_stiff_input` | 73 OMITTED_PHYSICS cases (69 where only this rule matters, 4 together with the threshold) | `ss.rs` `add_junctions` drops a junction when both of its nodes have g = ∞ (`!(weakest.is_infinite() && g[x] == g[y])`, "between two stiff nodes it carries no signal"). But g[n] = ∞ is set for **every** node on a VSrc/Vcvs/Ccvs/Ind stamp. That includes floating DC sources (sense sources, level shifters), inductors, E/H outputs and the input source's node, and none of those is AC ground. A junction there carries signal, and on the input node it changes Rin even if both ends are AC-fixed. Example: a forward-biased drain–bulk junction of 0.138 S (0.688 V) is dropped, giving gain 1 vs ngspice 0.0237. | Treat a node as stiff only if its MNA class is ground after zeroed sources are merged (`node_col == None`), and never drop a junction on the input source's nodes. Simplest: always include junctions in the exact model and let the simplifier prune them. |
| `bulk_junction_threshold` | 15 OMITTED_PHYSICS (10 threshold-only, 4 with the stiff rule, 1 needing several small junctions together) | `JUNCTION_REL = 1e-6`: a junction under 1e-6 of its node's other DC conductance is dropped. Zero- and weak-bias junctions (IS/Vt ≈ 3.9e-13 S, up to about 8e-10 S) on high-impedance or Miller-amplified nodes still move outputs by ≥ 1e-6 (here Rin by 1.1e-6; elsewhere up to 1e-4 of Rin on 1e10–1e12 Ω nodes). A relative node-local threshold can't bound the effect on the output. | Keep every junction conductance in the exact model (they are model terms, not numerics); prune only in the simplified view, where the error is already measured. |
| `bjt_gmu_threshold` | 4 OMITTED_PHYSICS (wildmixed_504_011, _503_003, _505_040; wildmos_500_030 partly) | `ss.rs`: rμ is kept only if `q.gmu > 1e-6 * q.gpi`. gμ couples base and collector and is Miller-multiplied. In the repro the collector is on the signal path, so the gain is exactly 0 without it (ngspice 2.27e-9). In wildmixed_504_011 the collector is the input node and Rin is off by 9.5e-4. | Always include rμ (gμ = gbc/BR + gmin) in the exact model. |

## Large circuits

| File | Root cause |
|---|---|
| `dc_opamp_bjt_15v` | A 25-BJT op-amp (741 topology) at ±15 V: DC failed with "Q6's model overflows" at about 5% of input offsets. `pnjlim` lacked ngspice's reverse step limit (−vold − 1 from forward bias, else 2·vold − 1), so Newton threw junctions hundreds of volts negative and the swing back overflowed; gmin and source stepping failed too. Every exact form is over the term budget (`tooLarge`). |

## Fuzz differences proven NOT to be solver bugs (`triage.py` verdicts)

Each verdict comes from a check that can fail. The tools are `prove.py`,
`opcheck.py`, `evidence.py`, `indep.py` (an independent 60-digit rebuild of
ngspice's own linearized circuit from the netlist) and `mpverify.py` (a
60-digit solve of the solver's certificate).

- **NGSPICE_NUMERICS (94).** The exact solution of ngspice's own circuit
  (its printed gm, gπ, go, gμ, gds…, rebuilt independently) equals ours. It
  differs from ngspice's printed value by no more than the double-precision
  forward-error bound κ₁(A)·eps·‖x‖/|xₖ| of that system, often by orders of
  magnitude (bounds of 1e0–1e7 against gaps of 1e-6–1e-5): 1e13–1e16 Ω
  impedances next to kΩ resistors.
- **NGSPICE_GMIN (38).** Ours equals the exact solution of the solver-modelled
  circuit plus the *physical* part of every dropped term, and ngspice equals
  it only once ngspice's gmin on those terms is added.
- **GMIN_OP (24).** The operating-point gap vanishes at gmin = 1e-18 in both
  simulators. One source of it, proven to ratio 1.000000 at gmin 1e-15, 1e-18
  and 1e-21: ngspice puts gmin from a 3-terminal PNP's base to its grounded
  substrate (ic + ib + ie = −gmin·V(base)), which the solver doesn't model.
  Any remaining AC gap in these cases goes through the AC evidence and is
  proven an artifact too (e.g. wildbjt_504_012: NUMERICS).
- **DEGENERATE (77).** A junction carrying 1e12–1e281 A closes a loop made
  only of ideal voltage-type branches (V, E, H, L) and junctions, or sits
  between source-forced nodes following the junction law. Only the exponential
  limits the current, so no simulator's numbers mean anything. The solver
  reports "singular matrix" / "did not converge" here, which is fine, though a
  message naming the junction would be clearer. Both generators now reject
  these (`physical.py`, including MOS bulk-junction currents, which ngspice's
  `@m[id]` leaves out).
- **MULTISTABLE (1, wildmos_501_043).** ngspice seeded with `.nodeset` at the
  solver's operating point converges to it, and op and AC then match: the
  circuit has two DC solutions.
- **PARAM_ILLCONDITIONED.** The quantity is too sensitive to its inputs: S =
  max|∂lnQ/∂ln p| up to 1e11 (e.g. a reverse-active BJT whose emitter current
  is gm·vbe + go·vce with gm ≈ −go to 11 digits), so no double-precision
  computation fixes it to better than S·eps·(N+10). No fuzz case ends here
  after the other checks, but the minimized `stamps_b` circuit did, which is
  why the check exists.
