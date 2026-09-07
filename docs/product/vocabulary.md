# Shared vocabulary

This glossary keeps product and engineering language consistent. It describes stable concepts, not implementation plans. When a term changes meaning, the code and this document should change together.

## Product concepts

**Evidence** is an observed fact or a fact retrieved from a consented source. Examples include a foreground-window interval, browser page, calendar event, or repository change. Evidence retains its source and time range.

**Observation** is one raw capture record produced by a desktop adapter. Observations are inputs to downstream interpretation.

**Session** is a continuous interval associated with one application or context.

**Block** is one contiguous, understandable stretch of activity shown on Timeline. Applications and pages are evidence inside a block; they do not automatically define its intent or boundaries. “Episode” is retired product language.

**Live block** is the in-progress block for the current day. Its identity should remain stable while its contents are re-derived.

**Thread** is a goal or line of work that can connect several blocks across interruptions, days, or applications. A block is contiguous; a thread does not need to be.

**Entity** is something activity can be related to, such as an application, person, project, or client.

**Attribution** is the evidence-backed relationship between activity and an entity. Attribution retains its source and confidence and may be corrected.

**Correction** is a person’s explicit change to a Daylens interpretation. Corrections include renames, merges, splits, exclusions, and attribution changes. They are durable product data and outrank automated interpretation.

**Memory** is retrievable information derived from evidence, relationships, and corrections. Memory is not a model’s unsupported recollection.

**Interpretation** is a useful, evidence-backed account of what happened. It names the activity and its subject, people, project, client, or outcome when those details can be supported. Raw application telemetry remains evidence underneath the interpretation rather than becoming the product’s voice.

**Connector** is an explicit integration with an external source such as a calendar or repository host. A connector has its own consent, retrieval, retention, and failure boundaries.

**Surface** is a product interface that consumes Daylens facts. The primary surfaces are Timeline, Apps, and the AI agent. Search, MCP, sync, and the web companion are additional consumers.

**Focus score** is the honest deep-work percentage: time in continuous focused sessions of 25 minutes or more, divided by total active time. It is a measured fact, not a verdict about personal worth.

**Distraction alert** is a notification when leisure interrupts an inferred work state, or when a person leaves the planned apps of an explicit focus session. **Distraction profile** is the day’s leisure-versus-other time split plus the leisure surfaces that appeared.

## Architecture concepts

**Domain** is a cohesive area of product knowledge with one owner.

**Interface** is everything a caller must understand to use a module correctly: operations, types, invariants, ordering, and failure behavior.

**Adapter** implements an interface for a platform, provider, database, or external service. Platform and provider differences should end at adapter boundaries.

**Projection** is a deterministic transformation from stored inputs into derived state. The same inputs and rules should produce the same result.

**Query** reads product facts without changing them.

**Command** requests a state change and validates permissions and invariants at its boundary.

**Agent tool** is a narrow query or command exposed to the conversational agent. Read tools and action tools have different trust requirements.

**Context packet** is the smallest permitted set of product facts, evidence excerpts, entities, gaps, permissions, and tools assembled for one agent request. It is inspectable and provider-independent.

**Context disclosure** is the record of what Daylens made available to a model, why it was selected, where it was processed, and what was omitted or redacted.

**Agent runtime** is a provider adapter that executes an agent loop using a Daylens context packet and Daylens tools. It does not own product facts, permissions, corrections, or conversation identity.

**Provider** is a model backend behind the agent infrastructure. Provider choice must not change the meaning of product facts.

## Invariants

- Evidence-backed claims retain a path to their source.
- Timeline, Apps, the AI agent, search, MCP, and sync do not calculate competing versions of the same fact.
- Corrections survive rebuilds and outrank automated interpretation.
- Projections do not depend on network access, randomness, or hidden wall-clock state.
- Privacy exclusions are enforced before evidence reaches downstream consumers.
- The renderer accesses main-process behavior only through the typed preload and IPC boundary.
- Models do not become the source of recorded durations, identities, URLs, files, or events.
- Product language describes the understood activity before the telemetry used to infer it.
- Useful observations never become unsupported judgments about focus or productivity.
- Billed model commands require explicit approval before they run.
