# VACASK Qualification

Status: recurring qualification and proposed scope extensions.
Owners: simulation integration and release owners.

VACASK is a Profile-selected engine beside ngspice (Production:
`vacask-sky130-candidate`); hosting is in
[deployment](../deployment.md#where-the-simulator-runs).

## Remaining acceptance

Before the owner authorizes an engine, runtime or model-scope expansion for
Production, it needs: one reproducible candidate on the hosted Linux target
binding app SHA, image digest, Profile and the recorded VACASK build, OpenVAF
revision, OSDI ABI and module/model digests and licenses; discovery and
execution through public MCP and the managed queue; a real GUI and public MCP
journey (import DUT → build TB → author → prepare → run → export → save/reload
→ error → repair → rerun) through product APIs; the declared scope (seven
SKY130 wrappers, five corners, OP/DC/AC/TRAN/Noise), with missing equivalents
an explicit gap; and its own endpoint and bounded resources beside ngspice.
Native compilation consumes circuit IR, not rewritten SPICE.

## Environment and electrical acceptance

Owner decisions:

- **BSIM4 4.8.3.** The MOS equations are upgraded from the source models'
  4.5/4.62 declarations to 4.8.3; the converter emits 4.8.3 and records the
  original versions. A 4.5 parameter string does not select 4.5 equations in
  `sp_bsim4v8`.
- **Native execution, not numerical equivalence.** Agreement with ngspice or any
  cross-simulator threshold does not gate qualification, and coefficients,
  solver settings or sampling are never tuned to reproduce old results.
  Comparison reports are research only. A demonstrated native defect is still a
  defect (keep the chain-rule fix regression).

Qualification rule: for the declared device/corner/analysis scope, require
native model loading, correct terminal/parameter/unit mapping, successful
analyses, complete finite results with correct axes and units, and
readable/exportable raw and numeric evidence. Exit zero is insufficient; never
ignore unsupported parameters, substitute illustrative models, fill missing
results or rewrite raw artifacts. Analytical checks (divider, RC, resistor
noise), device characterization, a real OTA/TRAN/Noise circuit and one
illustrative Verilog-A device catch mapping and parser bugs.
