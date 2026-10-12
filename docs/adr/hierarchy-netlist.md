# Hierarchy and Electrical Authoring

Status: `accepted`
Owners: `packages/model`, `packages/edit-engine`, `packages/netlist`

Typed electrical intent stays distinct from display text and imported syntax.
[Schematic model](../specs/schematic-model.md) owns identity, interfaces and
presentation; [netlist export](../specs/netlist-export.md) owns extraction,
reference policy and dialect output.

- A child Document is a definition, each caller an occurrence; the formal
  interface derives from Cell-Pin declarations, so equal names never merge.
- An authored external circuit binds to a Project-owned native model source
  ([#1401](https://github.com/cascode-ai/analog-canvas/issues/1401)), keeping
  expressions and behavioral models; model knowledge is never inferred from
  artwork.
- A renamed custom pin creates an immutable captured artwork variant and remaps
  callers in one transaction, so contacts stay put.
- One transient export IR feeds every dialect printer; import IR never owns the
  design.
