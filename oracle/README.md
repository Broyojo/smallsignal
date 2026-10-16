# oracle: ngspice reference results for the smallsignal solver

ngspice (tested with ngspice-47) is the ground truth for operating points and
small-signal numbers. Needs `ngspice` on PATH and `uv`.

```sh
uv run run_ngspice.py                 # corpus/*.cir -> expected/*.json
uv run compare.py                     # smallsignal CLI vs expected/, pass/fail table
uv run compare.py -v nmos_cs ota_5t   # selected circuits, every failing quantity
uv run random_circuits.py --kind mos --seed 1 --count 50   # random/ + expected_random/
uv run compare.py --corpus random --expected expected_random
```

`compare.py` runs `$SMALLSIGNAL_BIN` if set, else builds `smallsignal-cli` with
cargo. The default tolerance is `--rtol 1e-6` on complex magnitude, with small
absolute floors per quantity.

## Files

- `corpus/<name>.cir`: netlist in the contract dialect (`plan/contract.md`).
- `corpus/<name>.json`: `input`, `output`, `ref`, `freqs`, `rin`, `rout`, plus
  `description` and textbook `hand` formulas.
- `expected/<name>.json`: ngspice results in the CLI's contract shape (`op`,
  `gain`, `rin`, `rout`). It also carries `vsource_currents` and per-device
  `region`/`vov`/`reverse`. An infinite impedance is `{"re": null, "im": null, "inf": true}`.
- `random/`, `expected_random/`: generated, git-ignored.

## Conventions

- `gain` = V(out) − V(ref) per unit AC on the input source (V/V, or V/A for an I source).
- `rin` = impedance the input source sees looking into the circuit. For a V
  source that is V(n+, n−)/(−i(V)), since ngspice's i(V) flows into the +
  terminal. For an I source it is V(n−) − V(n+), since an I source drives current
  out of its n− node.
- `rout` = V(out) − V(ref) per 1 A AC injected into `out` from `ref`. All other
  sources keep their DC value but have AC 0, so the bias point is unchanged.
- Operating-point values are physical: vgs = V(g) − V(s), id = current into the
  drain. ngspice's own PMOS `@m[vgs]`, `@m[vds]` and `@m[id]` are
  type-normalized (positive for a conducting PMOS). Its BJT `ic`/`ib` are
  physical.

## ngspice model details the solver must match

- Run options: `reltol=1e-9 abstol=1e-15 vntol=1e-12 gmin=1e-15`. ngspice's
  default gmin=1e-12 moves the gain of high-gain stages by ~1e-6 relative; at
  1e-15 the shift is ~1e-9. gmin sits across every pn junction (BJT be/bc, diode,
  MOS bulk junctions).
- Vt = k·T/q with k = 1.38064852e-23, q = 1.6021766208e-19, T = 300.15 K
  → 0.025864917007157 V. The diode check confirms it to 1e-14.
- MOS level 1: β = KP·W/L. Vth = VTO + GAMMA(√(PHI−Vbs) − √PHI), PHI default 0.6.
  Saturation: Id = β/2·Vov²·(1+λVds). Triode: Id = β(Vov − Vds/2)Vds(1+λVds).
  gm, gds and gmbs are the exact derivatives, so in saturation gds = λβVov²/2
  (not λId), and gmbs = gm·GAMMA/(2√(PHI−Vbs)). PMOS VTO is written negative.
  Level 1 also has bulk junction diodes with default IS = 1e-14, which leak
  ~1e-14 A when reverse-biased. That is negligible, but the reason `id` has an
  absolute floor.
- BJT (Gummel-Poon subset IS, BF, BR=1, VAF): qb = 1/(1 − Vbc/VAF),
  Ic = (Ibe − Ibc)/qb − Ibc/BR, Ib = Ibe/BF + Ibc/BR, with Ibe = IS(e^{Vbe/Vt} − 1).
  ngspice's small-signal `gm` is ∂Ic/∂Vbe at constant Vce, which is
  gbe(1 − Vbc/VAF) − go, *not* Ic/Vt. `go` = (Ibe − Ibc)/VAF = ∂Ic/∂Vce, and
  `gpi` = gbe/BF + gmin.
- Diode: gd = (Id + IS)/(N·Vt) + gmin.
