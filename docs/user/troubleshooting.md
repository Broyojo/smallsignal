# Troubleshooting

## Import says the entry is ambiguous

Choose exactly one `.cir`, `.sp`, `.spi` or `.scs` entry (`circuit.spi` or
`circuit.scs` is preferred) and include every local `.inc` or `.lib` it uses.

## A crossing is not connected

Intentional: crossing wires never connect. End a wire on the other wire to
add a Junction.

## A SPICE statement is reported as opaque

Opaque text is kept exactly but is not editable yet. Check the
[compatibility matrix](spice-compatibility.md) and include the diagnostic when
reporting a missing construct.

## Recovery copies

**File → Recover Unsaved Work…** lists this browser's safety copies. A damaged
latest copy offers the previous one; a copy from a newer schema can be
downloaded but not restored. If a warning says recovery cannot be saved, use
its download button. A reload within a fraction of a second of an edit may
miss that edit.

## PNG or PDF export fails

Allow downloads in the browser (PNG also needs Canvas 2D). SVG contains the
same drawing.

## The portable host does not start

Use Node 24 or newer and free port 4173. The portable host accepts only
loopback addresses; use `pnpm dev` for another port. It starts no optional
services and discovers no simulator.

## Agent requests fail

Use the editor's **Agent** connection panel and the
[MCP connection guide](../agent/mcp-install.md). Check session expiry, scopes
and the authorized Project; replacing the Project or revoking the session needs
a new authorization. A missing simulation environment is a configuration
error, not an invalid session.

## Accessibility limits

Precise placement, wire and endpoint selection and Junction insertion still
need a pointer. The schematic has no object-by-object accessibility tree,
focus follows page order, and shortcuts cannot be customized.
