# Issue Tracker: GitHub

Specs and tickets are GitHub Issues of this checkout's remote, via `gh`. Read
body, comments, labels and blocking relations.

- `ready-for-agent` marks clear requirement and acceptance; to-spec and
  to-tickets apply it. No triage labels; PRs are not a request surface.
- Sub-issues and blocking use GitHub relations, else `Parent:` / `Blocked by:`.
- Changed shared acceptance: edit the body to the full current requirement.
- Multi-line text goes through a UTF-8 file and `--body-file` (PowerShell-safe).
- Publishing, commenting and closing follow the task's authorization.
