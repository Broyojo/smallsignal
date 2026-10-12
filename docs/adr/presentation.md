# Presentation and Coordinate Domains

Status: `accepted`
Owners: `packages/model`, `packages/derived`, `packages/render-svg`, `apps/editor`

Grid-valid authored coordinates are separate from precise derived and screen
geometry ([schematic model](../specs/schematic-model.md#coordinate-domains),
[editor interaction](../specs/editor-interaction.md),
[visual language](../specs/visual-language.md)).

- Measured bounds never corrupt persisted state, and loading never rounds
  authored points; a render-only lead reconciles artwork contact with the grid.
- Objects store bounded style intent, not resolved tokens; overlays never enter
  formal output.
