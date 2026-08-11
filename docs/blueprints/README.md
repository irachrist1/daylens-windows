# Blueprints

Blueprints describe the system from the inside. Requirements
([`docs/specs/`](../specs/)) say what must be true; blueprints say how the code is
arranged to make it true, and trace down to real code symbols.

They follow the Software Factory blueprint form: `component` blocks are runtime
nodes, relationship paragraphs are the edges between them, `#Name` mentions a
component, `` `Name` `` mentions a schema, type, or model, and each blueprint ends
in its own numbered ADRs. The guide is vendored at
[`.agents/skills/software-factory/guides/blueprint-writing-guide.md`](../../.agents/skills/software-factory/guides/blueprint-writing-guide.md).

## Current blueprints

| Blueprint | Capability | Surfaces it serves |
| --- | --- | --- |
| [Interpretation pipeline](interpretation-pipeline.md) | Turning raw capture into named, kinded, correctable blocks | Timeline, recaps, wraps, agent answers |
| [Application attribution](application-attribution.md) | Per-application and per-page accounting of a day | Apps, Timeline block evidence, agent answers |
| [AI job orchestration](ai-job-orchestration.md) | One governed path for every model call | AI chat, recaps, wraps, block labels, app narratives |

## Relationship to the architecture document

[`docs/codebase/architecture.md`](../codebase/architecture.md) remains the verified
map of the whole codebase and the home of its system-wide invariants. It answers
"where does anything live". Blueprints answer "how is this one capability
arranged, what does it guarantee, and why was it built this way". Where the two
overlap, architecture.md holds the invariant and the blueprint cites it rather
than restating it.

## Scope

These three cover the surfaces in the V2 shipping sequence that had no internal
documentation. They do not cover capture adapters, the database and migration
layer, connectors, billing, the MCP server, or the web companion. Those are
either documented in architecture.md at sufficient depth or are not on the
critical path for the acceptance lines in
[`docs/acceptance/`](../acceptance/ACCEPTANCE.md). A blueprint earns its place when
a work order would otherwise have to rediscover the capability from scratch.
