# Product Core

Status: `accepted`
Owners: `packages/model`, `packages/edit-engine`, `apps/editor`

Human and Agent edits share one in-process TypeScript model and transaction
engine ([schematic model](../specs/schematic-model.md),
[Edit Engine](../specs/edit-engine.md)); a second service or editable scene
would duplicate validation and revision ownership. Documents are reusable
Cells, with no Page layer. Offline tools and executors may use other runtimes
behind owned contracts, never as a second schematic authority.
