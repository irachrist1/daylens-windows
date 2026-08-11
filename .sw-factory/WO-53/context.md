<!--lint disable strong-marker-->

# Work Order Entity Index: WO-53

**Initialized At (UTC):** 2026-08-11T14:44:40Z
**Current Status:** in_review

## Work Order

- WO-53: [backend] Enforce evidence coverage for factual answers (`7c1b323d-c8ba-423b-a04c-9defba8ae3ad`)
  Phase 3, type `build`, read through the software-factory MCP `read_work_order`.

## Requirements

- REQ-AIA-002: Ground factual answers in inspectable evidence. Read from the
  work order description returned by MCP `read_work_order`.

## Blueprints

- AI Agent (`0bbc0ff1-fccd-4b18-bf28-50d0b08b67cf`), read via MCP
  `read_blueprint`. Defines exchange-bound citation resolution and
  deterministic facts.

## Referenced Blueprints

Blueprints reached through child links while reading the linked blueprint.

- Agent Runtime & Context Packet (`b3ed6474-1327-4b15-b0fe-6fdb956f9868`), the
  child feature named in the AI Agent summary. Read via MCP. It is an unfilled
  template: no feature summary, no components, no contracts, no ADRs. Nothing
  in it constrains this work order.
- Corrections & Actions in Chat (`952e0de6-63d8-4c1b-a84f-518cc548064a`), the
  other named child. Not read: the AI Agent blueprint states it owns
  confirmation and mutation mechanics, which this work order does not touch.

The AI Agent blueprint carries six unresolved comment threads. They were listed
in the read output but their contents were not fetched, so no claim is made
about them.

## Acceptance Criteria

- **AC-AIA-002.1:** A stated factual duration, count, date, relationship,
  person, project, file, meeting, or activity is associated with an Evidence
  citation, or the answer states that supporting evidence is unavailable.
- **AC-AIA-002.2:** When available evidence does not support a requested fact,
  the specific uncertainty is stated and the fact is not presented as known.
- **AC-AIA-002.3:** Inspecting an answer provides its Evidence citations and
  Tool trace without exposing provider instructions, credentials, or unrelated
  conversation content.
- **AC-AIA-002.4:** When the question asks for a total, count, comparison,
  date, or relationship that eligible Daylens evidence can calculate, the
  deterministic result is used for that fact regardless of the selected model.

## Blueprint Contracts This Work Order Implements

From the AI Agent blueprint's Key Contracts:

- "Deterministic activity totals, counts, dates, relationships, and time
  intervals shall come from eligible structured evidence rather than a model
  choice."
- "An answer claim with a citation marker shall retain only a citation that
  resolves to a recorded evidence item for that exchange."

From ADR-004 ("Bind citations to the exchange evidence record"), the stated
remaining gap this work order closes: "Broader claim coverage and hard
enforcement remain required for every factual assertion, not only
marker-formatted claims."

## Architecture Path

`#ChatAgent` (`src/main/agent/chatAgent.ts`) is the single chat entrypoint body
and already owns the post-stream answer pipeline: deterministic time-chunk
table, grounding verification with one corrective retry, then packet-citation
resolution, then render sanitization. Evidence enforcement is inserted into
that same pipeline rather than becoming a second answer path.

The canonical corrected-facts boundary is
`queryCorrectedActivityFactsForDay` / `queryCorrectedActivityFactsForRange` in
`src/main/core/query/activityFactsQuery.ts`. The Timeline projection and the
Apps view both read it through `src/main/services/activityFacts.ts`. Every
deterministic figure this work order produces is read from that boundary, so a
computed answer figure and the number on screen cannot disagree.

Observed and deliberately not changed: `execGetDaySummary` in
`src/main/services/aiTools.ts` (behind the `get_day_overview` tool) still reads
`getAppSummariesForRange` and `getSessionsForRange` rather than the corrected
boundary. That is the data half of DEV-246, owned by a parallel lane. It is
also why enforcement is load-bearing rather than cosmetic: the model can be
handed an uncorrected total by a tool, and the computed value must still win.

## Existing Infrastructure Reused

- `src/main/agent/contextCitations.ts` — marker-bound citation resolution
  against the same exchange's packet. Left unchanged; this work order adds the
  non-marker claim coverage ADR-004 says is still missing.
- `src/main/ai/citations.ts` — `extractNamedEntities`, `verifyCitedEntities`,
  `verifyTimestamps`. Reused for entity claims rather than growing a second,
  looser idea of what a named thing is.
- `src/main/services/contextPacket.ts` — `resolveContextTimeRange` output on
  the packet (`request.timeRange`) is the only date-scope resolver used, so
  chat does not grow a second idea of which days a question means.
- `src/main/services/activityFacts.ts` — `aggregateAppSummaries`,
  `getCorrectedWebsiteSummariesForRange`.
- `src/main/ai/voiceContract.ts` — the uncertainty sentence is asserted against
  `findBannedVocab` and the em-dash ban.

## Delivery

- Branch: `wave/6-answers`, based on `wave/1-runtime-fixed` (`c179bbec`).
- Worktree: `/Users/tonny/Dev-Personal/dl-2-entities`.
