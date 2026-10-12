# Schematic layout lookup

Razavi/textbook-style defaults, chosen from actual pins and Nets. They are
visual defaults, not electrical evidence, API enums or edit gates; apply only
the matching topology (PMOS inputs, degeneration, cascodes, unequal loads and
separate body/supply domains may change them) and never rewire to fit a row.
Choose orientation before routing; leave space for structure and labels.

| Structure | Layout | Wiring |
| --- | --- | --- |
| Differential pair | Left/right symmetry; corresponding pins aligned | Shared tail: T-join |
| Current mirror | Adjacent branches; reference gate faces inward toward output gates | Common-gate line where clear; reference local closure |
| Common-source stage | Gate toward input; drain toward output | Direct signal path |
| Common-gate stage | Stacked along its branch | Branch connection; bias from the side |
| Tail current source | Below an NMOS input pair | Centred drop to the shared tail |
| Compensation network | Beside the stages it spans | Separate return corridor |

| Term | Relation |
| --- | --- |
| Symmetry | Named pair about a named axis; centre shared taps where practical |
| Alignment | Corresponding pin landings; body centres only when intended |
| Above / below | Relative to the named group, with pin/label clearance |
| Left-to-right | Main signal stages in order |
| Adjacency | Compact functional groups; series elements close with label/exit clearance |
| Equal spacing | Named repeated sequences only; keep electrical/tap order |
| Supply layout | Positive rail above, ground/negative below; keep a visible supply name |

| Wiring shape | Use |
| --- | --- |
| Direct | Short port leads; matching inputs get equal leads; no detour through another group |
| T-join | Local shared node, e.g. short tail crossbar with centred drop |
| Trunk + taps | A clear aligned pin row for common control; a separate spine only when needed |
| Local closure | Short reference/diode connection beside its owner |
| Separate return | Feedback/compensation corridor apart from the forward path |
| Body tie | Dashed body wire by `via`: a stub out of the channel, then the shortest path to the target Net or a Junction on it |

Plan branched Nets whole: spine, taps, exits. Branches use Junctions; bends and
unconnected crossings stay dot-free. Prefer orthogonal paths. Bound Net labels
may replace distant wires; free text may not. Common lines never pass through
symbol bodies or unrelated pins; use local taps instead.

Example, a two-stage amplifier: symmetric pair, mirror load above and tail
below on one axis, second stage to the right, top supply trunk, separate
compensation return near the output.

Use pin anchoring, alignment/mirror, direct wires and `route-net` with a trunk
([authoring](shared/authoring.md)). Keep default attached device labels, manual
positions and formatting unless asked; hide parameter displays only on request
for a topology view, never erase values. Add no duplicate supply Ports for
appearance. Check the render for alignment, legible labels and needless bends
without changing connectivity.
