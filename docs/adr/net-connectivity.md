# Net Identity and Connectivity Evidence

Status: `accepted`
Owners: `packages/model`, `packages/derived`, `packages/edit-engine`, `packages/netlist`

Persist connection facts and their authored owners; derive membership, logical
equivalence, readiness and occurrence-aware lookup. Rules:
[file format](../specs/project-file-format.md#one-connection-source),
[schematic model](../specs/schematic-model.md#electrical-authority),
[connectivity](../specs/connectivity-and-routing.md),
[editor interaction](../specs/editor-interaction.md),
[netlist export](../specs/netlist-export.md#net-rules).

- Owner-addressed claims let ground, supplies and labels share one system;
  removing an owner removes its claim.
- Physical split precedes logical resolution, so export never describes a cut
  connection; readiness is derived, never persisted.
- One connectivity index, locator and diagnostic envelope serve all consumers;
  Net representatives and check results are revision-scoped and never block
  saving.
