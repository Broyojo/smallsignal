# Persistence and Compatibility

Status: `accepted`

Owners: `packages/project-protocol`, `apps/editor`, `apps/desktop`, `apps/local-host`, `worker`

## Decision

Separate private Cloud Save, portable files and local recovery under
[persistence and recovery](../specs/persistence-and-recovery.md). Use one
current runtime shape and a contiguous reader upgrade chain under
[Project file format](../specs/project-file-format.md).
[Deployment](../deployment.md) owns the portable host boundary.

## Context

Saving, downloading a backup and recovering unsaved work have different
durability and identity guarantees. Rapid schema evolution must not make an
absent user's saved circuit unreadable.

## Rationale

Updating a stable Cloud Project avoids consuming a new resource on every save.
Acknowledged revisions protect against overwriting another writer; identical
retries need not create another revision. Check findings are independent evidence,
not a reason to withhold saving unfinished work.

Portable Project identity is not account storage identity. Recovery belongs to
the browser origin and cannot promise Cloud durability. A loopback PWA reuses the
same editor without requiring a second desktop runtime, but cannot pretend to
supply the hosted account service.

A fixed-width version window ties file lifetime to development velocity.
Keeping adapters at the file boundary preserves durability while runtime code
still sees one shape. This costs maintained adapters and focused tests, rather
than scattered legacy branches. Ambiguous electrical data must be refused with
a located explanation, not silently converted into guessed connectivity.

## Offline desktop

The offline desktop adds a default user-owned project library, independent
Save As, three previous save versions and checked workspace recovery.
Canonical project files remain authoritative instead of introducing a second
content database; opaque main-process grants isolate file authority from
renderer display paths. Stable user data survives ZIP replacement, and an
opt-in `.icproj` filename association avoids taking over every `.json` file.
Web Save remains Cloud-backed. See the desktop file ownership section in
[persistence and recovery](../specs/persistence-and-recovery.md).
