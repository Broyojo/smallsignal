# Install the Analog Canvas MCP adapter

Use `/api/agent/mcp-manifest.json` from the **exact editor origin**. It owns
the version, runtime requirement, immutable archive, SHA-256 and host setup
commands; no source checkout is needed.

When `installation.available` is true, follow its verified installation: check
the archive digest before executing; the installer tests stdio readiness
before updating the named host configuration and keeps unrelated settings. The
launch names the Node that ran the installer (a Homebrew Node through its
formula's `opt` link; re-run to replace a versioned Cellar path). Updating is
explicit. Without installer support, use the manifest's configuration mode and
launch configuration; never infer flags from another version or assume an old
package has the installer.

Configuration success does not mean tools are loaded in this conversation:
verify callable tools and `connection_status({refresh:false})` (version, API
origin). If loading needs a host restart or new conversation, tell the user
once and never restart it yourself. Report the failed stage: download,
integrity, stdio readiness, host loading, pairing or editor readiness. A local
probe is not acceptance: complete the requested operation.

Connect with the human's claim, then follow the [quickstart](mcp-quickstart.md).
Later processes resume the saved revocable connector without a claim; keep it
private. `ANALOG_CANVAS_MCP_CONNECTOR` overrides its file path, never a token.
The default file (one per origin) belongs to the first running MCP process that
uses it and a restart resumes it; a concurrent process keeps its own connector
in memory and needs its own claim, so parallel clients never drive one page by
accident. Give each parallel worker its own connector file, or share one file
to share a page on purpose. Disconnect or expiry revokes the session; Project
switches do not.

Automation that opens the editor itself (a headless browser driving batch
workers) opens `/editor?agent=pair`: the page connects on load as **Connect
Agent** does, without the panel, and `await window.analogCanvasAgent.claimCode()`
returns its claim. It rejects when the page is already paired, connecting
failed or the claim expired; a page that resumed its pairing keeps it. Never
put the claim in a URL, storage or log.

HTTP only when the user chooses it: the same-origin `/api/agent/kit` gives its
workflow, and HTTP success does not prove MCP loading.
