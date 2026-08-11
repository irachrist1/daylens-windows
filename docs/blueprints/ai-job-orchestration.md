# AI job orchestration

Component Blueprint. Satisfies [AI agent](../specs/ai-agent.md) and
[Agent runtime and context](../specs/agent-runtime-and-context.md), and provides
the model path every other AI surface rides — recaps, wraps, block labels, and
application narratives.

## Capability Summary

This capability is the one governed path from a Daylens surface to a language
model: which provider and model a call uses, how long it may take, what it may
spend, what it is allowed to see, and what happens when it fails. Its central
elements are `AIJobDefinition`, `JOB_DEFINITIONS`, `AIJobType`, and the context
packet. Twenty-two job types share it, so a policy expressed here applies to every
AI surface at once rather than being reimplemented per feature.

## Core Components

```component
name: AIJobOrchestration
container: Desktop Main Process
responsibilities:
	- Declaring every job in `JOB_DEFINITIONS`: surface, foreground posture, timeout, cache policy, model strategy, output cap
	- Serving a job's budget through `jobTimeoutMs` so no caller repeats a literal
	- Resolving provider and model through `resolveProviderConfigsForJob` and `modelForProvider`
	- Enforcing the background spend cap through `backgroundAIBudgetExhausted` and `BACKGROUND_AI_DAILY_CALL_CAP`
	- Executing a text job through `executeTextAIJob` and recording usage
```

`src/main/services/aiOrchestration.ts`.

```component
name: ChatAgentTurn
container: Desktop Main Process
responsibilities:
	- Running one chat turn as a real tool loop through `runChatAgentTurn`, bounded to a maximum step count
	- Escalating context in tiers: activity database, then permission-carded file and git reads, then consent-gated screen capture
	- Emitting a tool trace (`AgentToolTraceEntry`) and message artifacts for the "what the AI saw" inspector
	- Carrying pause and resume checkpoints, clarifying questions, previewed corrections, and confirmed-memory proposals
```

`src/main/agent/chatAgent.ts`.

```component
name: EvidencePrivacyBoundary
container: Desktop Main Process
responsibilities:
	- Filtering excluded evidence through `filterTrackingExcludedEvidence` before anything AI- or MCP-bound
	- Matching app-name exclusion tokens case-sensitively, so excluding "Messages" does not redact the word "messages"
```

`src/shared/evidencePrivacy.ts`.

```component
name: RecapGeneration
container: Desktop Main Process
responsibilities:
	- Building the recap prompt from the shipped variant in `recapVariants.ts` plus the memory block and profile directive
	- Imposing the `day_summary` budget at the call site, read from the job definition
	- Degrading to an honest factual line through `degradedRecapReason`, with the internal error sentinel stripped
```

`src/main/jobs/aiService.ts`, `src/main/ai/recapVariants.ts`,
`src/main/lib/daySummaryParse.ts`.

```component
name: RecapVoiceCheck
container: Desktop Main Process, Renderer
responsibilities:
	- Flagging internal vocabulary, stat-dump sentence shapes, and productivity judgements through `recapVoiceFindings`
```

`src/shared/labelVoice.ts`.

```model
name: AIJobDefinition
store: in-code constant
description: The declared policy for one AI job type. The single place a job's budget and posture are expressed.
fields:
	- jobType: AIJobType (required)
	- screen: AISurface (required)
	- foreground: boolean (required)
	- timeoutMs: number (required)
	- cachePolicy: off | stable_prefix | repeated_payload (required)
	- modelStrategy: balanced | quality | economy (required)
	- usesChatOverride: boolean
	- maxOutputTokens: number
constraints:
	- Every surface runs on the single provider and model chosen in Settings; the only sanctioned exception is a visible per-chat override on jobs that set `usesChatOverride` (code calls this invariant 12; see ADR-005)
	- A caller reads a budget through `jobTimeoutMs`, never as a repeated literal
	- `modelStrategy` is declared but currently ignored by model selection
```

### Relationships

#AIJobOrchestration owns policy and #RecapGeneration owns one job's prompt and
failure shape. The recap reads its budget through `jobTimeoutMs('day_summary')`
rather than holding its own number, so the definitions table is the only place a
recap's time limit is expressed. The belt still lives at the call site because
`executeTextAIJob` does not enforce a job's declared `timeoutMs` on its own —
removing it would leave the call able to hang while the table read as bounded.

#EvidencePrivacyBoundary sits in front of every consumer of Daylens facts,
including #ChatAgentTurn, #RecapGeneration, and the MCP server. Excluded evidence
is removed before assembly rather than filtered at render time, because a model
that has seen redacted content can restate it and no downstream filter would catch
the paraphrase.

#ChatAgentTurn depends on #AIJobOrchestration for provider resolution and usage
recording, but runs its own loop rather than a single text job, because a turn is
many model calls with tool results between them. It reports usage per turn instead
of per call for that reason.

#RecapVoiceCheck reads the prose #RecapGeneration produces and reports findings.
It does not gate the live path: whether a good-reading recap that trips the check
should be rejected or repaired is an open question, deliberately left unanswered
until the recap lab shows how often it happens in practice. Today the check runs
over every variant in the lab and over nothing in production.

## System Contracts

### Key Contracts

- **One provider, one model, everywhere.** Every surface runs on what the person
  chose in Settings. The only sanctioned exception is an explicit, visible
  per-chat override on jobs declaring `usesChatOverride`; a silent swap is a
  defect. Stated in code as "invariant 12" at `src/main/lib/providerRouting.ts`
  and `src/main/services/aiOrchestration.ts`; see ADR-005 for why that number
  resolves to nothing.
- **A job's budget lives in one place.** `JOB_DEFINITIONS`, read through
  `jobTimeoutMs`. A budget is set from measurement against a real day, with an
  environment override, and the measurement is recorded beside it.
- **Background spend is capped**, per day, with a kill switch, so a runaway loop
  cannot silently spend.
- **AI produces groundable prose only.** Every number a generated line may contain
  is enumerated before generation; a line that fails validation is repaired once
  and then falls back. Chart plumbing never reaches the model. Invariant 5.
- **Failure is honest and never silent.** A failed call degrades to a factual line
  that states what happened, with internal error sentinels stripped, and
  distinguishes a wall the person must clear from a transient failure worth
  retrying.
- **Recorded activity is product data, not model output.** A tool exposes a
  product-level fact or an explicit command, never raw tables or a second
  definition of time and attribution.

### Integration Contracts

- Agent tools read through existing services and queries. `packages/mcp-server`
  reuses the same tool executors against a read-only database, so an MCP answer
  cannot diverge from an in-app answer.
- Tier 2 file and git access is deny-by-default with explicit grants and a
  disclosure ledger. Tier 3 screen capture is consent-gated, sends pixels as an
  image part, stores nothing, and requires a stated reason that appears in the
  activity trail.

### Integration Boundaries

Provider choice, retries, streaming, cancellation, and rate limits belong to this
capability. Interpretation of a day belongs to the
[interpretation pipeline](interpretation-pipeline.md); the model receives a day
already named and kinded. Numbers belong to the projections; the model writes
sentences about them.

## Architecture Decision Records

### ADR-001: Budgets are measured against a real day, not guessed

**Context.** The `wrapped_narrative` job carried a 40-second budget against a
54-second reality and silently served the fallback deck on exactly the days most
worth telling. `day_summary` carried 15 seconds and failed the same way, reporting
"Day summary timed out" on consecutive real days.

**Decision.** A job's budget is set from a measurement against a real day, with an
environment override and the measurement recorded in a comment beside the number.
A test asserts the budget stays at or above the measured floor.

**Consequences.** A future edit cannot quietly return a budget to a value that
fails, and the reasoning is visible where the number is. The recorded measurement
can itself go stale: the `day_summary` comment cites 24-52s on the API and 33-77s
through the CLI, while a 2026-08-11 re-measurement on a 13-block day finished
every variant in 7.0-13.4s. The 150s budget still clears both.

### ADR-002: Prompt variants are declarative and one is shipped by name

**Context.** Recap quality could not be judged, because its output was almost never
seen. Iterating meant editing a prompt in place and losing the comparison.

**Decision.** Named variants live in `recapVariants.ts`, each with an id, a
description, and its directives. `SHIPPED_RECAP_VARIANT_ID` names the one the
application uses. A developer tool runs every variant against a real day from a
read-only copy of the database, printing the day's evidence, each variant's
latency, and its voice findings.

**Consequences.** Picking a winner means picking something shippable, and the
latency column is what sets the budget. Sampling the same prompt repeatedly and
varying the model are both excluded: the first produces nothing shippable, the
second is a separate question once a prompt is settled. The variant named `shipped`
is the original baseline and is not the shipped variant, which is `colleague` — a
naming collision worth removing.

### ADR-003: `modelStrategy` is declared and ignored

**Context.** Every job declares a `modelStrategy`, and model selection threads it
through and then returns the single user-chosen model regardless.

**Decision.** Recorded rather than fixed. Invariant 12 — one provider and model
everywhere — is the behavior that is actually wanted, and the per-tier tables are
the residue of a superseded design.

**Consequences.** Every comment reasoning about which job rides which tier
describes behavior that does not happen, so latency and cost reasoning that starts
from "this job uses the cheap model" starts from a false premise. The declaration
should be removed rather than honored; until it is, it misleads. Not tracked by an
issue yet.

### ADR-004: The voice check does not gate the live path

**Context.** A deterministic prose-quality check exists and was called from
nowhere in production.

**Decision.** It runs over every variant in the recap lab as a secondary signal,
and over nothing in the live generation path.

**Consequences.** Voice slips are caught while iterating without risking a
rejection loop on a recap that reads well but trips a heuristic. Whether it should
gate generation stays open until the lab shows how often good recaps trip it.

### ADR-005: The numbered invariants the code cites are not written down

**Context.** Source comments across `src/main` and `src/shared` reason about
numbered invariants — invariant 10 ("No page recorded" is never smeared into a
domain), invariant 11 (system noise never counts as time), invariant 12 (one
provider and model everywhere), and a reference to "apps.md invariant 13".
`docs/codebase/architecture.md` carries its own separate list numbered 1 through
7. The 10-through-13 list is defined in no document; `docs/specs/apps.md` has no
numbered invariant 13, and `docs/specs/ai-agent.md` does not use invariant
numbering at all.

**Decision.** Cite these rules by what they say and by the code that states them,
never by their number, until the list has a home. Blueprints do not propagate a
number that resolves to nothing.

**Consequences.** A reader who follows an "invariant 12" comment looking for the
canonical statement finds nothing, and two numbering schemes are live at once —
architecture.md's 1-7 and the code's 10-13, which collide. Either the code's list
gets written down or its comments get rewritten to state the rule. Not tracked by
an issue yet.
