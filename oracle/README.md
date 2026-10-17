# oracle: ngspice reference results for the smallsignal solver

ngspice (tested with ngspice-47) is the ground truth for operating points and
small-signal numbers. Needs `ngspice` on PATH and `uv`. `install-ngspice.sh`
builds ngspice-47 from source; distributions ship older releases (Ubuntu
24.04's ngspice-42 prints no `.disto` results).

```sh
uv run run_ngspice.py                 # corpus/*.cir -> expected/*.json
uv run compare.py                     # smallsignal CLI vs expected/, pass/fail table
uv run compare.py -v nmos_cs ota_5t   # selected circuits, every failing quantity
uv run random_circuits.py --kind mos --seed 1 --count 50   # random/ + expected_random/
uv run compare.py --corpus random --expected expected_random
uv run textbook.py -v                 # symbolic results vs hand-derived KCL/textbook formulas
uv run fuzz.py --seeds 100-107 --kinds wildmos,wildbjt,wildmixed,mixed,linear   # parallel fuzz in fuzz/
uv run triage.py "$SMALLSIGNAL_BIN"   # sort fuzz failures into root-cause buckets
uv run minimize.py fuzz/<batch>/c/<name>.cir --kind nan|nonconv|acmismatch|bulkfwd|opmismatch --out regressions/<name>
uv run compare.py -v --corpus regressions --expected regressions/expected   # minimized known failures
```

- `textbook.py` / `textbook_cases.py`: each case's value-less netlist is solved
  symbolically. Its exact num/den must equal a hand KCL derivation in SymPy as
  a rational-function identity, and each quoted closed form must equal the KCL
  result as well. Numeric runs must show the ∥ notation and match the hand
  formula evaluated at the solver's operating point.
- `random_circuits.py --wild`: up to 8 nodes and 6 devices in any region
  (triode, cutoff, reverse mode), PMOS/PNP-heavy, plus L, diodes, floating
  sources and E/G/F/H. Circuits within 50 mV of a level-1 region boundary, or
  with device currents above 1 A, are rejected.
- ngspice runs time out after 30 s; some pathological circuits make it loop forever.
- `regressions/`: minimized failures with their diagnoses (see its README).
- Evidence tools (all take the solver binary first):
  - `triage.py`: a verdict for every fuzz failure, each from a check that can
    fail. It calls:
  - `prove.py`: gmin scaling (both simulators at gmin 1e-18), and physical
    degeneracy (> 1 A junction in an ideal-source loop).
  - `opcheck.py`: operating-point gaps, either multistability (ngspice
    `.nodeset` at our solution) or gmin.
  - `evidence.py`: AC gaps against `indep.py`, an independent 60-digit rebuild
    of ngspice's own linearized circuit from the netlist (full, solver-like,
    and solver-like plus dropped physics). It accounts for ngspice's numerics
    (κ-bound), gmin, omitted physics, stamping, and parameter conditioning.
  - `mpverify.py`: 60-digit solve of the solver's own `--certificate`.
  - `physical.py`: junction-current sanity, used by both generators and the
    minimizer.
- Noise (`"noise": true` in a sidecar, frequencies = `freqs` or `noise.freqs`;
  compare.py runs the CLI at both): `expected/<name>.json` gets
  `noise.output` / `noise.input` as [{f, v2}] in
  V²/Hz (A²/Hz input-referred for an I-source input; ngspice prints V/√Hz
  densities, which are squared) and `noise.contributors` [{element, source,
  values}] from `set noisedetail` (sources: thermal for R; id, 1overf, rd, rs
  for MOS; ic, ib, 1overf, rb, rc, re for BJT; id, rs, 1overf for diodes).
  With `inputNeg`, ngspice's input is one new source driving both inputs
  through controlled sources (±1/2, or +1 each in common mode), as the
  solver drives them. `noise.band` adds `noise.integrated`: the independent
  60-digit quadrature, written only if it agrees with a Richardson trapezoid
  of ngspice's spectrum to 1e-6. compare.py checks each source the solver
  lists, and the ngspice sources it does not (beyond its 32 largest) through
  `omitted`: none larger than a listed one, their sum and count. It also
  fails a missing `contributors` list and `inputLowFreq.check.ok: false`.
  `noise_indep.py` recomputes every source with ngspice's formulas on the
  independent 60-digit rebuild. ngspice-47 level-1 MOS formulas: channel
  4kT·(2/3)·gm; flicker KF·gm²/(Cox·W·Leff·f^AF) — not SPICE2's
  KF·Id^AF/(f·Cox·L²); AF is the frequency exponent; Cox = 3.9·ε0/TOX,
  TOX = 1e-7 m by default. compare.py checks noise at rtol 1e-6, as AC.
- `textbook_nd.py`: textbook noise cases (CS, degenerated CS, SF, diff pair,
  5T OTA, BJT CE), hand-derived (KCL with noise injections), checked against
  ngspice and the quoted closed forms.
- `run_ngspice.options_override(...)` changes ngspice options per thread;
  never assign `run_ngspice.OPTIONS` (the evidence tools run threads).

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
