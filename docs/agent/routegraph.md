# Repository-only RouteGraph helper

Read only when repository work uses `@icm/agent-routing`. It is not an MCP tool
or HTTP form, and operating Agents never need it. RouteGraph is transient
Agent-side geometry scaffolding, never persisted, accepting a narrower graph
than the product's free-angle wire planner. The Agent supplies the complete
local graph; the helper never decides topology, inserts nodes, chooses shapes,
adds elbows, moves parts or reroutes around a conflict.

| Node role | Persisted result | Meaning |
| --- | --- | --- |
| `endpoint` | none | Instance terminal or Junction at its resolved coordinate |
| `bend` | Route bend leg target | Degree-two, dot-free change of direction |
| `tap`, `junction` | branch Junction | Real electrical branch point |
| `label-anchor` | label-anchor Junction | Anchor for an attached local Net label |

Other nodes use `at` or `alignWith + axis + offset`, snapped to the 10-unit
grid (`axis: "x"` keeps x and offsets y; `"y"` the reverse). Edges: `escape`
joins exactly one endpoint to a positioned node along its terminal's outward
direction; `trunk` and `link` make Route segments (`trunk` marked) and must be
octilinear; `label` makes an attached `net-label` annotation. Corners need an
explicit `bend`; consecutive bends fold into one Route's legs.

Any conflict returns no edits and no geometry: duplicate IDs, missing
endpoint/position, unresolved or misaligned edge, zero-length segment, bad
escape, wire through symbol, bend degree other than two, self-loop, unanchored
bend cycle. Change the graph or placement; never commit a subset.
