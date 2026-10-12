# Project Documentation

The current product, its contracts and unfinished work; Git holds history.
When and how docs change: [AGENTS.md](../AGENTS.md#documentation).

| Area                                                                     | Purpose                                                                 |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| [User guides](user/getting-started.md)                                   | Editing, hierarchy, simulation, saving, compatibility, and known limits |
| [Product architecture](overall-product-plan.md)                          | System boundaries and sources of truth                                  |
| [Specifications](specs/README.md)                                        | Current data, interaction, API, execution, and export contracts         |
| [Architecture decisions](adr/README.md)                                  | Why consequential architectural choices were made                       |
| [Agent guide](agent/README.md)                                           | Authorized workflows and on-demand knowledge                            |
| [Roadmap](roadmap/README.md)                                             | Remaining work and acceptance questions                                 |
| [Deployment](deployment.md)                                              | Production delivery, verification, rollback, and retained storage       |
| [Testing](testing/README.md)                                             | Validation policy and contract ownership                                |
| [Development workflow](development-workflow.md)                          | Original-skill stages, handoff and completion boundaries                |
| [EDA tools](eda-import.md)                                               | Offline conversion and Aether/Virtuoso import                           |
| [Skill references](../references/README.md#development-skill-references) | Fixed originals, setup, installation and updates                        |

## Contributor reading order

1. [Development workflow](development-workflow.md), [AGENTS.md](../AGENTS.md),
   [product architecture](overall-product-plan.md).
2. The domain's specs: electrical ([schematic model](specs/schematic-model.md),
   [Edit Engine](specs/edit-engine.md),
   [connectivity](specs/connectivity-and-routing.md)), rendering
   ([visual contract](specs/razavi-visual-contract.md),
   [visual language](specs/visual-language.md)), entry points
   ([editor](specs/editor-interaction.md), [Agent API](specs/agent-api.md),
   [web sessions](specs/web-agent-session.md)), analysis
   ([simulation](specs/simulation.md), [netlist](specs/netlist-export.md)).
3. [Test system](testing/README.md) and the domain's tests; Agent-assisted
   schematic work also follows the [Agent workflow](agent/workflow.md).

## Authority

Specs are the only authority for accepted contracts, linking executable
schemas for exact shapes. ADRs say why, guides explain actions, roadmaps hold
unresolved outcomes; none repeats a spec's rules.

When behavior and a document disagree, inspect behavior first: update the
contract for deliberate, coherent evolution; repair an accidental violation;
raise an unresolved disagreement for a product decision.

## Assets and retirement

- An image lives beside the topic that references it; fixtures and goldens stay
  in the fixture system; incident screenshots and run reports go in the Issue
  or PR. A test fixture or pinned reference stays even when no Markdown links it.
- Before deleting a doc, move its unique valid constraints to their owner and
  update incoming links.
- Moving published Agent-resource sources updates the manifest and generated
  projections in the same target.
