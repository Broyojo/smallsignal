# Simulation evidence storage

Status: accepted
Primary owners: Browser simulation artifact/archive stores, SimulationFiles and Worker AgentArtifacts

Keep complete numeric evidence, admit it safely, reclaim idle caches while the
Editor is open, and prepare Agent downloads only on request. Never changes a
circuit, tolerance, signal list, sample grid or result.

## Browser admission

- Project budget: 1 GiB stored bodies, 4,096 resident files; 256 MiB original
  bytes per file, 512 MiB per archive; shared identities count once. Origin
  quota is a separate constraint.
- Above 75%, admission reclaims unowned bodies, then oldest eligible cache
  runs, down to 62.5% or enough room. Cache keeps ≤ 30 runs; Saves keep their
  own 30-run rolling policy; records without a retention marker are
  protected. Never evicted: the latest successful durable run, a Save, a
  legacy record, evidence in active use. A cache promoted to Save is
  rechecked at deletion.
- Publication encodes files sequentially into Blobs, then commits bodies,
  identities, ownership and the catalog in one IndexedDB transaction that
  rechecks bytes and slots. No durable staging (`reservedBytes` is zero
  outside it); an abort leaves nothing.
- Failed publication keeps output and identities in the session; Export
  retries publication without re-running (session loss can lose it; no remote
  backup). Execution, collection, persistence and transfer failures are
  separate: `execution`/`collection` keep actual outcomes; persistence failure
  is `Run.error.stage = "export"` with its storage code, or, if execution also
  failed, a `RUN_EVIDENCE_STORAGE_UNAVAILABLE` warning beside the original
  Problem. It never turns complete acquisition partial. The GUI offers
  **Retry saving results**; ZIP downloads and archiving use that recovery
  first. No incomplete durable catalog is added.

## Readers and reclamation

Short Project locks guard publication and cleanup; scoped producer, Run and
reader Web Locks with durable owner references protect lifetimes, so viewing
one Run never blocks unrelated removal. Logical deletion writes a durable
marker; physical deletion waits for readers and the last owner (crashed owners
reconciled against locks; without Web Locks cleanup is deferred; failures
retry on admission, startup or release). Browser cleanup never deletes Agent
workspace files.

## Agent transfer replicas

- Worker session budget: 1 GiB, 1,024 bodies, 256 MiB per file; only selected
  files upload (≤ 8 and 32 MiB in flight, single-large-file exception).
- `File.transfer-capabilities` negotiates protocols 1 and 2. Legacy
  `download`/`downloads` keep shape and session-lifetime protection;
  `download-v2`/`downloads-v2` take a consumer UUID and return path, lease
  UUID, expiry and ArtifactRef (10-minute descriptors, renewed by GET/Range).
  Consumers release after length/hash check and atomic local publication via
  `File.release-download` (or the same-session artifact DELETE), naming only
  file identity and lease, never an R2 key; scope `simulation.run`.
- ACK failure keeps the local file (lease expiry recovers); expiry or a
  missing replica re-prepares the artifact, never re-simulates. Idle LRU
  bodies are reclaimable only after leases and transfers end; failed PUT
  reservations keep 10 minutes of retry protection; charged bytes are released
  only after R2 deletion succeeds.
- Evicted identities refuse concurrent reupload; tombstones last for the
  session, bounded at 65,536 identities and 1 MiB metadata in one SQLite
  Durable Object record (2 MB platform limit). Exceeding it returns
  `ARTIFACT_METADATA_QUOTA_EXCEEDED` before adding anything; reads and ACKs
  continue. Session end bulk-deletes with failed-key retry.

## Lossless representation and accounting

- ArtifactRef length and SHA256 describe original UTF-8 bytes. The browser
  stores identity or gzip with actual `storedBytes` (identity below 64 KiB,
  under 10% savings, or on encoder failure); larger jobs run serially in
  short-lived Workers. Decompression stops at the declared length, enforces
  256 MiB and verifies the digest; unknown encoding or corruption fails
  without deleting. RAW, JSON, CSV, inputs, logs, manifests and Specs keep
  format and identity; no downsampling or regeneration.
- `history-usage` keeps its fields; `Simulation.resource-usage` reports
  browser-project, agent-session-transfer and session-memory scopes, with
  missing remote measurements as an explicit problem, never zero.
- IndexedDB v4 reads v2/v3 bodies in place; a blocked upgrade fails
  `ARTIFACT_STORAGE_UPGRADE_BLOCKED` keeping old bytes. Production writes gzip
  (`VITE_SIMULATION_GZIP=1`); roll back only to a dual-reader version with
  gzip writes off.
