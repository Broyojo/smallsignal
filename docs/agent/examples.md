# Raw HTTP request examples

Bodies for the session's `/circuit` endpoint ([API usage](api-usage.md)).
Replace IDs and revisions with returned facts.

Read authorized state (authorization comes from claim/resume):

```json
{"apiVersion":"3.0","requestId":"snapshot-1","operation":"snapshot","documentId":"<authorized-document-id>","includeSourceSpans":false}
```

Preview a reference change on an unlocked instance:

```json
{"apiVersion":"3.0","requestId":"reference-preview-1","operation":"transact","documentId":"<authorized-document-id>","transactionId":"reference-preview-tx-1","expectedRevision":42,"dryRun":true,"edits":[{"kind":"set_instance_reference","instanceId":"<snapshot-instance-id>","reference":"R2"}]}
```

Commit it, only while revision 42 is still the intended state, with new
request and transaction identities:

```json
{"apiVersion":"3.0","requestId":"reference-commit-1","operation":"transact","documentId":"<authorized-document-id>","transactionId":"reference-commit-tx-1","expectedRevision":42,"dryRun":false,"edits":[{"kind":"set_instance_reference","instanceId":"<snapshot-instance-id>","reference":"R2"}]}
```

If the commit response is lost, retry that exact envelope. A stale revision
caused by a human edit needs fresh state and reconsideration. To build and
wire, place from the catalog, read resolved pins, and use `wireIntent`; the
planner owns Net merges, Junctions and Route splits ([tool behavior](tool-behavior.md)).
