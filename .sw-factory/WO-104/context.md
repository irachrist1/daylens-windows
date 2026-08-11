<!--lint disable strong-marker-->

# Work Order Entity Index: WO-104

**Initialized At (UTC):** 2026-08-11T08:32:45Z
**Current Status:** in_progress — Phase 3 complete, verdict recorded in `review-log.md`.

## Work Order

- WO-104: [backend] Wire common interpretation and tone into Wrapped and brief prompts (`8b78011b-d6c2-49b4-b6a6-00b6121d8b16`)
  <https://factory.8090.ai/project/45f2f431-ae93-407c-913b-8bce76ba3085/work-orders/104>
  Phase 3. Type: Build. Board status Backlog, which carries no information here.

## Requirements

**REQ-VIC-002: Apply the chosen tone across activity descriptions.**

- **AC-VIC-002.1** — the selected tone applies to every generated activity
  description. *Unmet at start.* See D1 and D3.
- **AC-VIC-002.2** — the same chosen tone across Timeline, Apps, the agent,
  Wrapped, and briefs. *Unmet at start.* Two of five surfaces had it. Apps and
  the brief had none; the agent is WO-105.
- **AC-VIC-002.3** — the same understood activity keeps the same supported
  interpretation across surfaces. *Partially met.* Wrapped and the brief validate
  facts independently and share no description policy.

## Blueprints

**Governing — Voice & Interpretation Contract** (`54e028ec-b55e-4036-9799-ddc78d568584`).

> #SummaryVoiceDirective supplies the selected `SummaryVoice` directive to
> #NarrativePromptComposer. The default is `warm`; valid choices are `straight`,
> `warm`, and `witty`.

and:

> #NarrativePromptComposer passes grounded facts and the `SummaryVoice`
> directive to model-backed narrative jobs. Fact validation remains independent
> of tone selection.

That last sentence is the constraint this work order must not break: adding
policy directives and a tone line must not touch what the validators check.

ADR-002 ("Separate interpretation from expression") is the shape: the
interpretation directives and the tone directive are added as two separate
things, because they are two separate things.

## Referenced Blueprints

- **Wrapped** — owns the deck validation and deterministic fallback this work
  order must not disturb (both are the work order's stated Out of Scope).
- **Day Recap & Analysis** — owns the brief. See the naming discrepancy below.
- **Apps** — `app_narrative` is the Apps surface named in AC-VIC-002.2.
- **Voice & Label Policy** — `#GeneratedVoiceContract`, already in every one of
  these prompts as `VOICE_SYSTEM_PROMPT`.

## What "the brief" actually is

The work order says "Wrapped and Proactive Brief narrative prompts". There is no
component called Proactive Brief in the codebase. Grepped: `weekly_brief` exists
as a registered job type (`aiOrchestration.ts:297`) with **no composer and no
caller anywhere in `src/`** — a job configuration for a surface that was never
built.

The brief that does exist is the day recap: `src/shared/aiFeatures.ts:14` maps
`day_summary: 'Morning brief'`, and `dailySummaryNotifier.ts:251` delivers
yesterday's recap as the morning-brief notification. So `generateDaySummary` is
the brief prompt this work order names, and D1 below is its defect.

This also reconciles the two work orders: the lane briefing assigned the day
recap's missing tone to WO-105, while WO-105's own Out of Scope explicitly
excludes "Wrapped and Proactive Brief prompt composition". The recap is the
brief, so it is fixed here. WO-105 records that it was closed one work order
earlier.

## Architecture path

- `src/main/jobs/aiService.ts`, prompt-building region — `generateDaySummary`
  (the brief), `generateWeekReview`, `generateAppNarrative`. **Shared file;
  edits confined to the prompt-building region.**
- `src/main/lib/wrappedNarrative.ts`, `src/main/lib/wrappedPeriodNarrative.ts` —
  `buildWrappedPrompts`, `buildPeriodPrompts`. The prompt composers. **Owned.**
- `src/main/services/wrappedNarrative.ts`, `wrappedPeriodNarrative.ts`,
  `wrappedQuestion.ts` — where the tone is applied. **Owned.**
- `src/shared/summaryVoice.ts` — `voiceDirective`. **Owned**, unchanged.
- `src/shared/activityDescription.ts` — WO-99's directives, split here.

## Verified defects

**D1 — the brief has no tone at all (AC-VIC-002.1, AC-VIC-002.2).**
`generateDaySummary` builds its system prompt at `aiService.ts:2018` from
`VOICE_SYSTEM_PROMPT`, the memory block, `userProfileDirective`, and the variant
directives. `voiceDirective` is absent. It is applied in
`wrappedNarrative.ts:203`, `wrappedPeriodNarrative.ts:287`, and
`wrappedQuestion.ts:120` and nowhere else. Picking a tone moved Wrapped and left
the day recap, which is the surface most people read every morning, in whatever
voice the shared contract happens to produce.

**D2 — Apps and the week review have no tone (AC-VIC-002.2).** AC-VIC-002.2
names Apps explicitly. `generateAppNarrative` and `generateWeekReview` both build
prompts with no `voiceDirective`.

**D3 — the recap cache is not keyed on the tone (AC-VIC-002.1).**
`daySummaryCacheKey` hashes the payload, the memory block, and the variant id. A
person who changes tone gets the cached recap in the old voice for the life of
the process. This is what makes the toggle feel dead even once D1 is fixed.

**D4 — a prompt tells the model to use the punctuation the contract bans.**
`USER_VISIBLE_ACTIVITY_PROSE_RULE` (`aiService.ts:247`), which is in the
week-review and app-narrative prompts, ends: "Do not put the app name before the
em-dash. The em-dash separates activity (left) from attribution + duration
(right)." `VOICE_SYSTEM_PROMPT` in the same prompt says never to write an em
dash, and its own comment records that the model imitates the punctuation of its
prompt. The prompt contradicts itself, twice, in the same string.

**Checked and NOT changed:** stored Wrapped narratives are keyed on
`computeFactsHash`, which carries no tone component, so changing tone does not
regenerate a wrap that already exists. That is deliberate product behaviour
("A wrap is never silently regenerated", `wrappedNarrative.ts:111`), and forcing
regeneration would spend a provider call per stored day and write
`reason: 'facts-changed'` into the analysis ledger, which would be false. Left
alone and recorded as a known limit in `review-log.md`.

## Delivery

- Branch: `wave/4-voice`
- Pull Request URL: opened against `factory/v2-ship` at the end of the lane.
