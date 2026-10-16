# Fuzz regressions

Minimized circuits from the wild-mode fuzz (`fuzz.py`, `triage.py`,
`minimize.py`). Each has a `.cir`, a `.json` sidecar and ngspice references in
`expected/`. Run them with:

```sh
SMALLSIGNAL_BIN=... uv run compare.py -v --corpus regressions --expected regressions/expected
```

All of them failed against the solver at commit 51631b7a.

| File | Root cause | Kind |
|---|---|---|
| `bulk_junction_forward` | The MOS bulk junction conductances gbs/gbd are left out of the small-signal model. Here a drain–bulk junction is forward biased (drain at 0, bulk = source = n2 ≈ 0.7 V): ngspice gives Rout = 33.6 Ω, the solver 2724 Ω (R1 alone). | solver bug |
| `overflow_nan`, `overflow_nan_2` | Cutoff BJTs have rπ ≈ 1/gmin ≈ 1e15 Ω and ro ≈ 1e20 Ω. Terms evaluated in display (resistance) space overflow f64, so values come back null (NaN). The symbolic-vs-numeric cross-check skips NaN and still reports `ok: true`. | solver bug |
| `dc_nonconv_mos`, `dc_nonconv_mos2`, `dc_nonconv_mixed` | ngspice converges (all currents < 1 A) but the solver reports "DC operating point did not converge". These involve nodes held only by junction leakage, F/H feedback loops and reverse-mode devices. | solver robustness |
| `bjt_reverse_active_label` | A BJT in reverse-active (vbc > 0.4, vbe < 0.4) is labelled `cutoff`. The solver has no reverse-active label. Values are correct. | label |

Fuzz differences that are not solver bugs (see `triage.py`):

- **gmin-level impedances.** ngspice keeps gmin (1e-15 S) across every pn
  junction, so a gate-only node reads about 1e14–1e15 Ω instead of ∞, and a
  capacitive node gets Re(Z) ≈ gmin/|Y|².
- **Absurd currents.** A junction forward-biased by an ideal source at more
  than 1 V gives currents of 1 A to 1e60 A. Both simulators then subtract huge
  exponentials, so the ic values disagree, and sometimes neither converges.
  Wild mode now rejects these.
- **Multiple DC solutions.** `fuzz/wildbjt_103/c/wildbjt_103_038` is
  multistable: ngspice converges to the solver's operating point when given a
  `.nodeset`.
