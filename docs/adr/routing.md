# Routing Geometry and Operations

Status: `accepted`
Owners: `packages/derived`, `packages/edit-engine`, `packages/render-svg`, `apps/editor`

Route identities resolve into shared read-only geometry, and one typed edit plan
drives preview and commit; coordinate-only previews may skip per-frame
transactions, but electrical changes and every commit pass the transaction gate
([connectivity and routing](../specs/connectivity-and-routing.md),
[Edit Engine](../specs/edit-engine.md),
[visual language](../specs/visual-language.md)).

- Stable leg identity survives inserted bends; shared geometry keeps rendering,
  hit testing and dragging in agreement.
- The evaluated transaction's Document is the authoritative preview; plans stay
  transient.
- Moving preserves connection; only explicit cut disconnects. There is no
  Contact object or autorouter, and any heading is valid.
