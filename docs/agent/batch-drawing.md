# Batch drawing (repository only)

`pnpm draw:batch` draws many circuits without a browser (#1498): one
[local workspace](local-workspace.md) per task, an Agent command per workspace,
then the drawing's netlist, figure and a name-insensitive grade against the
task's reference netlist (#1524). Internal tool, not a published interface;
`scripts/draw-batch.mjs --help` and its source own the full option list.

```sh
pnpm draw:batch tasks.jsonl --out runs/pilot --jobs 4 --timeout 15m \
  --agent 'claude -p --output-format json --mcp-config {mcpConfig} --strict-mcp-config --allowedTools "mcp__analog-canvas,Read"' \
  --second-agent 'claude -p --output-format json --mcp-config {mcpConfig} --strict-mcp-config --allowedTools "mcp__analog-canvas,Read"' \
  --instructions STYLE-INSTRUCTIONS.md
```

The Agent runs in a POSIX shell in its workspace with the prompt on stdin; the
optional second Agent independently redraws a mismatch or missing netlist in
`DIR/<id>/second/`. `--timeout` (default 900 s) stops the process group and
still grades the drawing; `--resume` skips tasks with `verdict.json` (an
existing batch is refused without it). Templates take shell-quoted `{dir}`,
`{id}`, `{image}`, `{reference}`, `{mcpConfig}`, `{prompt}`, `{role}`,
`{bundle}` and `{cwd}`, also exported as `ANALOG_CANVAS_BATCH_*`. The workspace
holds `reference.sp`; instructions decide whether the Agent may use it.

The manifest has one JSON object per line: `id`, `image` (or `figure`),
`reference` (path, or inline netlist), optional `name` and `instructions`.
References are SPICE or AnalogGenie structural Spectre. Each task directory
keeps the Project, netlist, figure, prompt, `agent.log` and `verdict.json`;
the batch writes `summary.json` and `review-queue.jsonl`.

`gradeNetlists(actual, reference)` decides `exact` by device–net graph
isomorphism, ignoring names and hierarchy, with ground and supplies as fixed
classes and interchangeable two-terminal ends and MOS drain/source; bodies
count unless one side omits them (`--body` forces). Outcomes: `match`,
`mismatch`, `blocked`, `ungradable`, `no-reference`, `error`.

| First drawing | Second drawing | Path | Accepted |
| --- | --- | --- | --- |
| match | — | `first` | first |
| no reference | — | `unchecked` | none |
| reference cannot be graded | — | `review` | none |
| mismatch, blocked or error | match | `second` | second |
| mismatch | mismatch isomorphic to the first | `agreed` | first |
| mismatch, blocked or error | not run, or anything else | `review` | none |

`agreed` sets `datasetSuspect`: the reference may be wrong.
`scripts/lib/draw-batch-script-agent.mjs` is a scripted Agent for trying the
pipeline without a model.

Accepted drawings go to the dataset's reference store (#1510), never the
community wall: `pnpm gallery:import-batches RUN_DIR --source KEY` (`KEY` from
`config/gallery-sources.json`) writes `RUN_DIR/gallery-import/KEY-*.json`
(suspect acceptances need `--include-suspect`; `left-out.json` explains
exclusions), which the Owner posts from a signed-in Gallery page to
`POST /api/gallery/sources/KEY/entries`; re-importing an id replaces it.
