# Desktop distribution credential boundary

The desktop application and its source are public; no production credential
may be in either. Minification, wrappers, hidden buttons or removing source
from a ZIP protect nothing.

## Where production authority lives

- OAuth client secrets, email key, simulation token, `ADMIN_EMAILS(_EXTRA)`,
  Gallery and store backup tokens: Worker runtime secrets only.
- Account sessions: random tokens; the server stores hashes and checks expiry.
- `isAdmin` / moderator UI is display only; privileged endpoints resolve the
  server session themselves.

None of these reach desktop build or acceptance jobs or packages. The
administrator check uses only provider-verified emails. Pattern scans cannot
prove no secret exists; server review and auth tests are the evidence.

## Enforced distribution checks

1. Desktop Vite builds disable `.env` loading and `VITE_*` exposure; a build
   test injects sentinels through both and checks the output.
2. Package assembly rejects tracked private configuration, key, profile and
   database paths and symlinks; the final gate re-inspects runtime paths and
   the source ZIP's entries without extracting it.
3. The Windows workflow scans runtime contents and nested source with pinned
   Gitleaks 8.30.1 before upload, failing closed on missing tools, errors or
   findings; synthetic keys prove detection and a path-bound fixture exception.
4. A passing scan adds `SECURITY.json` (commit, scanner version, inventory);
   archiving checks it and `ACCEPTANCE.json` against the package source.
   Actions artifacts and manual prereleases share this gate. Browser profiles
   are never uploaded; scanner diagnostics keep only rule, path and line.
5. The renderer build checks every chunk's module inventory
   (`desktop-modules.json`): account, Cloud/Gallery clients, cloud component
   library, telemetry, browser simulation sessions and Agent hosts/transports
   must be absent.
6. Desktop CSP is `connect-src 'self' data:` (for the PDF exporter's embedded
   fonts); all external requests and navigation are blocked. About may ask the
   main process to open a fixed product link by identifier, never an arbitrary
   URL or Project data. Packaged acceptance checks real exports and blocked
   requests.

If a real credential is found, block distribution, revoke/rotate it at the
issuer and audit Git history and build outputs before restoring access. Local
check (not publish approval): set `GITLEAKS_BINARY`, then
`pnpm --filter @icm/desktop security:preview` after packaging and acceptance.
