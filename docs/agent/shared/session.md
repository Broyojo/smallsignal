# Session contract quick reference

Circuit operations are exactly `capabilities`, `snapshot`, `transact` and
`render`. A transact carries exactly one of edits, structureEdits, wireIntent,
semanticIntent, a browser-planned command, or high-level actions; commands and
actions reuse the GUI planners and Edit Engine. Simulation
(capabilities/run/prepare/start/read/cancel/export) and File are sibling
resources. The static authoring catalog is not Project state.

Reuse a request ID only for an exact-payload retry. The current OpenAPI and
`capabilities` define this session's scopes, edit kinds and limits.

Dry-run is optional. Actions are planned on the current Document and
committed in one browser step; raw transactions and undo/redo keep their
revision guards, and not every concurrent human edit produces STATE_CHANGED.
Prefer receipts and targeted reads; refresh on stale revisions or uncertain
outcomes.
