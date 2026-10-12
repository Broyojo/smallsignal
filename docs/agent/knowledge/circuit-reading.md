# Reading an unfamiliar circuit

Read the complete selected-Document Snapshot to interpret unfamiliar topology
or plan broad changes. Keep electrical facts apart from functional hypotheses
and drawing choices.

Read `Document.netlist.terminals`, Project references and source binding for
boundaries, then device models/parameters and the full pin-to-Net mapping.
Supply and body semantics come from `powerDomain`, `mosBulk` and model facts;
names and artwork are only hints.

Trace shared controls, source/emitter nodes, stacks and feedback. Before
calling something a matched pair or mirror, check loads, parameters, body
connections and control domains. Stop semantic inference on an unresolved
device until its pin/model facts exist; understood regions can still be
reviewed. Keep cross-region Nets while focusing on one path or branch group;
do not turn a reading partition into a new Cell or flatten a shared definition
unless the task calls for it.
