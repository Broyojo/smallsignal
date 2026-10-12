# Operating boundary

- The live browser Project is authoritative: read it through `snapshot`;
  never guess IDs, Net membership, placement, pins or revision. The Kit
  catalog is authoritative only for listed built-in symbol IDs, pin order and
  variants before first placement.
- For a symbol absent from the catalog, an imported/custom/PDK symbol, or an
  electrical fact absent from a Snapshot, ask the human; never extrapolate
  from labels, artwork or another library.
- Use only the published session API (HTTPS, or HTTP on loopback) to change a
  circuit; never DOM, mouse, keyboard, visual automation, source repositories
  or a second edit path.
- Circuit edits use `transact`; File, Simulation and Project resources have
  their own side effects. Preserve human edits, locks and revision conflicts.
- Keep bearer tokens in memory only. Never put a claim code or token in a
  file, URL, log, annotation or user-visible response.
- The browser must be online while an operation runs; it may reconnect to the
  same session after a restart. A terminal session error requires new human
  authorization, not retargeting.
