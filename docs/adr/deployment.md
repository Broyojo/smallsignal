# Production-Only Hosted Delivery

Status: `accepted`
Owners: `.github/workflows`, `worker`

Production is the only hosted channel; every merged non-documentation change
deploys its exact `main` commit with mandatory verification and rollback
([procedure](../deployment.md)). Preview had drifted and added a workflow,
promotion and credentials without evidence beyond PR checks plus Production
verification. Its Worker stays as route-free storage because deleting it could
make Durable Object data unrecoverable.
