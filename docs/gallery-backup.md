# Gallery off-site backups

The private `cascode-ai/analog-canvas-backups` repository owns the backup
collector, its tests, schedule (weekly, plus manual dispatch) and recovery
instructions. Snapshots are date-stamped private Release attachments, never
overwritten; automatic retention deletion is off. `cascode-ai` members can read
them (they contain submitter emails and sign-in methods; store snapshots also
every private Cloud Project); only the Owner changes the repository or starts
its workflows.

## Credentials

- `GALLERY_BACKUP_TOKEN` (read-only) lives in this repository's
  `cloudflare-production` environment and the backups repository's Actions
  secrets; deployment syncs it to the Worker. Rotate by updating both and
  deploying; never commit or print it. It allows member Gallery reads,
  `GET /api/gallery/maintenance/automated-backup?table=…` pages and the netlist
  read below; no admin session, writes, restore or private Cloud Projects.
- `STORE_BACKUP_TOKEN`, stored and rotated the same way, reads only
  `automated-backup?scope=store` pages.

## Gallery capture

Each capture holds every Gallery row (all statuses, versions, likes, project
text, previews, moderation, private
[testbenches](specs/community-gallery.md#testbench-privacy) and
[simulation checks](specs/community-gallery.md#simulation-checks)) plus the
SQLite definitions. It retries when the scope revision changes mid-capture and
is rebuilt and read back in SQLite before publishing. Accounts, analytics, the
component catalog and private Cloud Projects are outside it.

## Local snapshots

`node scripts/gallery-private-snapshot.mjs` captures the Gallery, waits for the
verified Release and downloads it under
`~/Library/Application Support/Analog Canvas/gallery/` (`--cached`: latest
existing Release; `--directory PATH`: another 0700 destination). `--store`
does the same for the whole store, Gallery plus every private Cloud Project,
which is backed up only this way. It uses the GitHub CLI login, never a token,
never overwrites a capture, and keeps the two newest verified snapshots (older
ones go to the macOS Trash). Administrators can read store pages in the browser
from `GET /api/gallery/maintenance/schema-backup?table=…`.

## Reading netlists from another machine

```bash
curl -H "Authorization: Bearer $GALLERY_BACKUP_TOKEN" \
  "https://analog-canvas.tokenzhang.com/api/gallery/maintenance/netlists?format=spice"
```

Pages hold up to 100 public entries (`limit` ≤ 200); pass `nextCursor` as
`after` until `null`. `format=spectre` and `id=<entry>` are supported; blocked
exports carry `netlist: null` with diagnostics. Administrators can open the URL
signed in, without the token. Fields:
[Gallery specification](specs/community-gallery.md#administration).

## Recovery

Follow the Release archive's README. Inspect rows offline first, keep original
IDs, history and likes, and take a new live backup before any administrator
write. **Never feed a Gallery-only snapshot to `schema-restore`**: it also
replaces private Cloud Projects. Within 30 days use
[point-in-time recovery](deployment.md#point-in-time-recovery). Investigate any
failed or missing run; keep local copies as a second destination.

## Tools on snapshots

- `pnpm gallery:author-parts -- --author "NAME" --after ENTRY_ID` counts parts
  of an author's public circuits after an entry (`--from N`, `--csv FILE`).
- `pnpm replica:import` copies the newest snapshot into a local replica without
  submitter emails (`~/Library/Application Support/Analog Canvas/local-replica/`);
  `pnpm dev:replica` runs the editor against the real Worker on it, signed in as
  the Owner with a loopback-only account switcher. Nothing reaches Production.
