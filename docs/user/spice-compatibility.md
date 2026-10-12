# SPICE Compatibility

Importing reads circuit structure; it does not simulate. Every source line,
include and unrecognised statement is kept. Spectre `.scs` entries are
converted to SPICE in the browser first.

Exports are deterministic structural SPICE (`.spi`) or Spectre (`.scs`)
netlists without model cards, library includes, analyses or testbenches.
Unknown imported `X` calls stay external subcircuit calls.

## SKY130 targets

Ordinary symbols can carry exact reviewed SKY130 targets through their
**Target netlist** (`netlistTarget`) property:

- NMOS/PMOS: `sky130_fd_pr__nfet_01v8`, `sky130_fd_pr__pfet_01v8`, their
  `01v8_lvt` variants and other reviewed MOS, with `w`, `l`, `nf`, `m`. The
  same undoable edit renames `M1` to `XM1`; clearing the target restores it.
- Resistor and capacitor: `sky130_fd_pr__res_high_po` and
  `sky130_fd_pr__cap_mim_m3_1`, sized by `w`/`l` with `mult` or `mf`, never
  derived from an ideal value. The resistor's substrate is a `Substrate Net`
  property, not a canvas pin.
- PNP `sky130_fd_pr__pnp_05v5_W0p68L0p68`: three nodes; its wrapper ties the
  substrate to the collector, so the collector belongs on ground (elsewhere
  the export warns `PDK_SUBSTRATE_TERMINAL`).
- NPN `sky130_fd_pr__npn_05v5_W1p00L1p00`: its fourth terminal S is a
  `Substrate Net` property (structural only on the hosted Profile).

A substrate sits on the lowest supply: the Cell's drawn negative supply
(named like `VEE`, `VSS`, `VNEG`) while the Cell's NMOS body default is unset
or ground, else that default, else ground. Changing the default moves the
substrates that followed it. One bound to ground before the rail was drawn
exports with `PDK_SUBSTRATE_ABOVE_NEGATIVE_SUPPLY`, which says how to fix it.

These mappings are structural: they do not install SKY130, resolve includes or
supply models and corners. Unreviewed masters and incompatible terminal orders
stay generic blocks. The generic diode keeps its `DIODE` model.

## Parameters and sources

Imported `.subckt` defaults become editable Cell parameters and are exported
again; parameters without defaults cannot be exported. Independent `V`/`I`
sources export DC, AC, PULSE, SIN and PWL, but import maps only their DC form
back to editable parameters.

| Profile | Status | Detection | Limit |
| --- | --- | --- | --- |
| ngspice 46 core | baseline | ngspice directives | simulator commands kept, not executed |
| SPICE3f5 core | baseline | fallback | no simulator execution |
| LTspice 24 structural | vendor profile | `.backanno` family or override | schematic directives and proprietary devices may stay opaque |
| Xyce 7 structural | vendor profile | analysis-qualified `.print`/`.measure` or override | expressions not evaluated |
| HSPICE | preservation only | none | no conformance corpus |
| PSpice | preservation only | none | no conformance corpus |

"Opaque" means kept exactly, with its source location, but not yet turned
into editable circuit semantics.
