# Simulation evidence resources and recovery

Browser Project evidence and Agent transfer replicas (Worker: 1 GiB/1,024
files, idle LRU; failed deletions stay charged) have independent budgets.
`simulation` / `resource-usage` reports each scope's used, reserved,
protected, reclaimable and pending bytes, logical bytes, counts and limits;
missing remote measurements appear in `resourceProblems`, never as zero.
`history-usage` bytes are charged stored bodies; ArtifactRef length/hash
describe original files. Private gzip is lossless and keeps every file's
contents and identity; an unknown encoding, excessive decompression or failed
digest is an explicit read failure and the evidence remains.

New evidence may reclaim eligible older automatic caches; Saves, legacy
records, the latest durable result and evidence in use are protected, and
another tab reading one Run does not block unrelated cleanup. Deleting an
archive records pending cleanup durably; admission, startup and reader release
reclaim unreferenced bodies (shared files stay until the last reference goes).
Pending deletion stays charged until reclaimed; Agent deletion reports logical
versus physical removal. Legacy whole-Project locks and browsers without Web
Locks defer cleanup; failures retry later without blocking access. An older
Editor window can block a database upgrade: update or close it and retry.

## Transfers

`simulation_files` / `transfer-capabilities` lists protocols. Legacy
`download`/`downloads` keep their shape. v2 `download-v2`/`downloads-v2` take a
consumer UUID and return the original ArtifactRef, a same-session path, a
lease UUID and expiry; only requested files are uploaded and local cache hits
transfer nothing. MCP sync/download handles negotiation, Range, byte/hash
checks, atomic publication and ACK. A custom consumer sends
`release-download` (fileId, leaseId) or the same-session artifact DELETE only
after verifying its file, releasing only its own lease. Active streams renew
protection; a failed ACK keeps the file and expires. An expired replica needs
bounded re-preparation of the same artifact; never rerun to fetch evidence.

Transfer identities last until session end within a 1 MiB Worker metadata
budget (at most 65,536); `ARTIFACT_METADATA_QUOTA_EXCEEDED` refuses new
identities while existing downloads and ACKs work: prepare later transfers in
a new session.

## Failed persistence

A completed run whose evidence failed to persist keeps its session result for
an evidence-only export retry (closing the session can lose it). Persistence
failure is `Run.error.stage:"export"`; if execution also failed, its Problem
carries a `RUN_EVIDENCE_STORAGE_UNAVAILABLE` warning instead. Either needs
evidence-only recovery before packaging the Run; the retry never invokes the
solver. Storage, transfer quota, authentication and solver failures are
distinct.
