<!--lint disable strong-marker-->

# Work Order Entity Index: WO-105

**Initialized At (UTC):** 2026-08-11T08:32:45Z
**Current Status:** in_progress — Phase 3 complete, verdict recorded in `review-log.md`.

## Work Order

- WO-105: [backend] Apply the selected tone and description policy to agent responses (`5a4f356f-ec42-4cb5-be14-499cd94e91ca`)
  <https://factory.8090.ai/project/45f2f431-ae93-407c-913b-8bce76ba3085/work-orders/105>
  Phase 3. Type: Build. Board status Backlog, which carries no information here.

## Requirements

REQ-VIC-001, REQ-VIC-002, and REQ-VIC-003, all three embedded in the work order
description. Graded for the agent surface specifically:

- **AC-VIC-001.1** — one executable policy. *Unmet for the agent at start.* The
  agent prompt stated its own rules in its own words; none came from the shared
  policy.
- **AC-VIC-001.2 / .3 / .4** — *partially met.* `VOICE_SYSTEM_PROMPT` and
  `CITATION_CONTRACT` covered grounding and the narrow plumbing ban. The wider
  description-scope ban, the weak-phrase ban, and the copied-title ban were
  absent.
- **AC-VIC-002.1 / .2** — the chosen tone. *Unmet.* `buildAgentSystemPrompt` had
  no tone input at all.
- **AC-VIC-003.1** — one uncertainty statement. *Partially met.* The agent had
  "Never lead with what you could not see" but no rule to state the limit once.
- **AC-VIC-003.2** — no judgment. *Unmet.* Nothing in the agent prompt banned
  grading productivity or focus.
- **AC-VIC-003.3** — evidence owns the facts. *Unmet as a stated rule.*

## Blueprints

**Governing — Voice & Interpretation Contract** (`54e028ec-b55e-4036-9799-ddc78d568584`).

> #AgentSystemPromptBuilder ... Must add the person's selected `SummaryVoice`
> directive for cross-surface tone parity.

and:

> #AgentSystemPromptBuilder must pass the `SummaryVoice` directive and the
> generic voice contract to the agent. Agent answers, including time-chunk
> answers, must use the resulting supported interpretation.

Both accurate. This is the one place the blueprint described the gap correctly.

## Referenced Blueprints

- **Voice & Label Policy** — `#GeneratedVoiceContract`, already composed into the
  agent prompt as `VOICE_SYSTEM_PROMPT`.
- **Desktop Application (Electron)** — the agent turn's boundary; read to find
  where settings are already in scope so the tone could be threaded without
  widening any surface.
- **Day Recap & Analysis** — the sibling surface whose tone landed in WO-104;
  read to keep the two consistent.

## Architecture path

- `src/main/agent/systemPrompt.ts` — `buildAgentSystemPrompt`, the component the
  blueprint names. A prompt composer. **Owned.**
- `src/main/agent/chatAgent.ts` — threads the tone from its deps into the
  builder. Two lines and one type import.
- `src/main/jobs/aiService.ts`, prompt-building region — the two production call
  sites that read `settings` and now pass `settings.summaryVoice`.
- `src/shared/summaryVoice.ts`, `src/shared/activityDescription.ts` — the inputs.
  **Owned.**

## Verified defects

**D1 — the agent had no tone input (AC-VIC-002.1, AC-VIC-002.2).**
`AgentPromptContext` carried `now`, `timezone`, `trackingStart`, `providerLabel`,
`model`, `homeDir`, `extraSystem`. No voice. The person's chosen tone reached
Wrapped and (after WO-104) the brief, Apps, and the week review, and stopped at
the surface they talk to most.

**D2 — the agent stated its own policy, not the shared one (AC-VIC-001.1).** The
agent prompt is long and good, and every rule in it was written for the agent
alone. Nothing tied it to the policy the other surfaces follow, so the two could
drift with nobody noticing.

**D3 — no rule against grading, and none about who owns a fact
(AC-VIC-003.2, AC-VIC-003.3).** Neither appeared anywhere in the agent prompt.

**Conflict found while sizing D2, and it mattered.** The shared directive as
WO-99 shipped it said "If a duration is not in the evidence, do not state a
duration." The agent prompt requires the opposite exactness: "When a duration or
total IS the answer, compute it precisely from the tool result's start and end
and state the figure plainly to the minute." Composing the flat directive would
have told the agent both to compute the span and not to state it. Resolved by
rewording the directive to permit derivation from recorded evidence and forbid
only invention. Recorded in `review-log.md`.

## Finding 1 from the lane briefing

The briefing recorded that `voiceDirective` was missing from `generateDaySummary`
and assigned it to this work order. It was closed in **WO-104** instead, because
`day_summary` is the morning brief (`aiFeatures.ts:14`) and WO-105's own Out of
Scope excludes "Wrapped and Proactive Brief prompt composition". The fix is
landed and tested; only its work-order home differs from the briefing. Evidence
in `.sw-factory/WO-104/review-log.md`.

## Delivery

- Branch: `wave/4-voice`
- Pull Request URL: opened against `factory/v2-ship` at the end of the lane.
