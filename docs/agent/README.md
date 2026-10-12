# Agent documentation: consumers and distribution

All hand-authored Agent guidance lives here. The [registry](distribution.json)
declares each document's consumers, task, reading load, required dependencies
and destinations; the generated [report](distribution.generated.json) records
source and output hashes as evidence, not a second registry. Edit and release
rules: [maintenance](maintenance.md).

| Consumer | Task | Entry | Task-selected guidance | Delivery |
| --- | --- | --- | --- | --- |
| Setup Agent | Install and verify callable MCP | [Connection message](entrypoints/connect.md) | [Installation](mcp-install.md), host manifest | Browser copied message |
| MCP circuit Agent | Inspect, author, render | [Quickstart](mcp-quickstart.md) | [Authoring](shared/authoring.md); [MCP tools](mcp/tools.md); workflow, recovery, knowledge | MCP resources and tool descriptions |
| MCP simulation Agent | Save, run, measure, hand off | [Quickstart](mcp-quickstart.md) | [Simulation calls](mcp/simulation.md); [details](mcp/simulation-reference.md), [Specs](simulation-specs.md), [handoff](simulation-result-handoff.md) | MCP resources |
| Raw HTTP Agent / integrator | Claim, resume, request, retry | [Kit README](http-kit/README.md) | [Boundary](http-kit/AGENTS.md), [API usage](api-usage.md), OpenAPI, [examples](examples.md) | `GET /api/agent/kit` |
| Shared-client CLI Agent / script | Call tools without an MCP host | [CLI](http-cli.md) | Authoring, `--http list-tools`, `--http resource` | Same package and registry as MCP |
| Internal batch Agent / script | Draw without a browser | [Local workspace](local-workspace.md), [batch drawing](batch-drawing.md) | MCP or CLI guidance, no pairing or simulation | Repository only (`--local`) |
| Product maintainer | Change, verify, release guidance | [Maintenance](maintenance.md) | Root rules, code contracts, release docs | Repository only |

An entry is a starting point; `load` (`entry`, `required`, `on-demand`) is a
distribution role, never a permission gate.

MCP is the default. Configuration success is not proof of callable tools; if a
host cannot load the adapter, explain the failed stage and possible restart
once, without restarting it or switching protocols. Raw HTTP and CLI are
explicit user choices; CLI shares MCP's client, raw HTTP implements its own
lifecycle.

## Authority

- `distribution.json` is the only registry; no channel is generated from
  another channel's bundle.
- Shared authoring, session, Specs and handoff are topic authorities; channel
  guides map them to calls without redefining policy.
- Tool schemas, edit validation and symbol facts are code-owned; prose cannot
  redefine pins.
- Knowledge cards are evidence aids, not classifiers. Drawing review cannot
  establish electrical correctness without simulation evidence.
- [Layout lookup](circuit-style-knowledge.md) is served at
  `reference/razavi-style` and at the older patterns/routing URIs and Kit
  paths; its canonical entry precedes the aliases so links resolve to it.
- [RouteGraph](routegraph.md), [local workspaces](local-workspace.md) and
  [batch drawing](batch-drawing.md) are repository-only. Runtime guides cannot
  link to undistributed documents: generation fails instead.
