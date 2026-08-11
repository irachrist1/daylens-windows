<!--lint disable no-undefined-references strong-marker-->

# Implementation Plan: WO-105

**Work Order:** WO-105 — [backend] Apply the selected tone and description policy to agent responses
**Created At (UTC):** 2026-08-11T08:32:45Z

## Summary

Give the agent the person's chosen tone and the shared activity-description
policy, so the surface people talk to most describes their work the same way the
recap and Wrapped do. Time-chunk row rendering (WO-106), Wrapped and brief
composition (WO-104), and the definition of the primitives (WO-99) stay out.

## Code Reuse And Package Structure

Reused rather than rebuilt:

- `src/shared/summaryVoice.ts` — `voiceDirective`, `normalizeSummaryVoice`.
- `src/shared/activityDescription.ts` — `ACTIVITY_DESCRIPTION_DIRECTIVES`. The
  agent gets the full block, both halves, unlike the Wrapped decks: it has no
  earned-praise rule to protect, and AC-VIC-003.2's grading ban is one of the
  three criteria this work order exists to satisfy.
- `src/main/ai/voiceContract.ts` — `VOICE_SYSTEM_PROMPT`, already composed in.

Modified:

- `src/main/agent/systemPrompt.ts` — `AgentPromptContext` gains an optional
  `summaryVoice`; the prompt gains a described-activity section. **Owned.**
- `src/main/agent/chatAgent.ts` — one optional dep, one pass-through, one type
  import.
- `src/main/jobs/aiService.ts` — the two production call sites pass
  `settings.summaryVoice`. Prompt-building region.
- `src/shared/activityDescription.ts` — the derivation rewording. **Owned.**

No schema change, no migration. Range 85-89 untouched.

## Components And Flow

`#AgentSystemPromptBuilder` consumes `#SummaryVoiceDirective` and the shared
policy, which is exactly what the blueprint's Integration Contract asks for.

The tone is optional at every hop and normalizes at the last one. That matters:
`buildAgentSystemPrompt` is called by the bench, by `contextPacketInspection`,
and by two production paths, and only the production paths have settings. An
optional field that normalizes to `warm` means a caller without settings gets the
default voice rather than a prompt with the tone line silently missing.

## Steps

1. **Reword the evidence-ownership directive** so deriving a figure from
   recorded evidence is explicitly allowed and only invention is banned. Without
   this the composed prompt contradicts the agent's own exactness rule. This is a
   WO-99 file, but the change is required by this work order and is recorded
   here rather than done quietly.

2. **`AgentPromptContext` gains `summaryVoice?: SummaryVoice | null`**, and the
   prompt gains a "How you describe their activity" section holding the full
   directive block and the tone line. Placed after `VOICE_SYSTEM_PROMPT` and
   before "How you work", so the policy reads as part of the voice rather than as
   one more operating rule.

3. **Thread it.** `ChatAgentDeps.summaryVoice`, passed into the builder;
   `settings.summaryVoice` at both production call sites in `aiService.ts`, where
   `settings` is already in scope.

## Testing

New: `tests/agentVoiceContract.test.ts`.

- AC-VIC-002.2: the prompt contains the exact directive for each of the three
  tones.
- AC-VIC-002.1: `undefined` and `null` both produce the warm directive, so a
  caller without settings never gets a prompt with no tone.
- AC-VIC-002.2: two different tones produce different prompts.
- AC-VIC-001.1: every directive in the shared block appears in the prompt.
- AC-VIC-001.4: every term of the shared plumbing ban appears.
- AC-VIC-003.2 and .3: the grading and evidence-ownership rules appear.
- The conflict from step 1: the prompt contains both the agent's "compute it
  precisely from the tool result's start and end" rule and the directive's
  explicit permission to derive, so it does not argue with itself.

Regression files that must stay green: `tests/contextPacketInspection.test.ts`
(builds the prompt with no `summaryVoice`) and `tests/chatAgentStreaming.test.ts`.

Commands:

```bash
node scripts/run-tests.mjs tests/agentVoiceContract.test.ts tests/contextPacketInspection.test.ts tests/chatAgentStreaming.test.ts
npm run typecheck && npm run lint
```

Exploratory pass: ask the agent the same question under two tones and compare.
Feasibility assessed and recorded honestly in `review-log.md`.
