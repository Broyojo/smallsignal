# Project File Compatibility

The editor opens Project files from schema 24 through the current schema and
always saves the current one. Older files are upgraded on import; save or
export to keep the upgrade. Unsupported, corrupt, ambiguous or newer files are
rejected before they replace your circuit. Keep the original file when
reporting an import failure. The [file-format contract](../specs/project-file-format.md)
is authoritative.

**Import Project File…** opens a portable file, **File → Save** saves to your
private Cloud Project, **Export Project File…** downloads a portable copy.
Neither import nor export changes the Cloud save state.

## What travels with a Project

A Project carries topology, instances and parameters, component definitions,
Cell interfaces, labels and drawing styles, simulation source folders,
Project-owned external model sources and drafts, User Component origins and
inductor couplings. It does not carry run results (use the simulation result
export), Undo history, unfinished text edits or Agent credentials. Same-name
Nets and Ports keep their logical connection without merging separately drawn
wires. A drawn Reference such as `M1` may export as `XM1`; the drawing is not
renamed.

Netlist imports keep their original text as a reference for **Check and
Save**; older Projects without it report the reference as unavailable. Gallery
publications omit that archived text.

## Recovery

Browser tab restoration and crash-recovery copies are safety nets, not saves:
clearing site data removes both. See
[persistence and recovery](../specs/persistence-and-recovery.md).
