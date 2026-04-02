# Inference-First Refactor Plan

This plan is the implementation draft for bringing the Windows app into alignment with the Daylens principle:

- passive by default
- deterministic where possible
- AI as an enhancement, not a dependency
- task inference over app-time reporting

The goal is not to remove AI. The goal is to make the core product feel complete without it, then let AI sharpen the ambiguous and narrative-heavy parts.

## Product Standard

The Windows app should be useful with no Anthropic key, no CLI subscription, and no hosted AI entitlement.

The core experience that must work fully offline/local:

- passive tracking
- work-state inference
- distraction detection
- work-block grouping
- focus scoring
- daily and weekly summaries
- resume-next suggestions
- most Insights questions that can be answered from retrieval and structured reasoning

AI should be reserved for:

- naming ambiguous work blocks
- rewriting evidence into cleaner natural language
- answering fuzzy open-ended questions
- long-horizon synthesis across many days or weeks

## Current Gaps To Close

### 1. Passive distraction detection needs to become the default model

Relevant files:

- `src/main/services/distractionAlerter.ts`
- `src/main/services/tracking.ts`
- `src/main/db/schema.ts`
- `src/main/db/queries.ts`
- `src/shared/types.ts`

What is already good:

- `src/main/services/distractionAlerter.ts` already contains the right philosophical shape: inferred work state first, leisure second, explicit focus sessions as an enhancement.

What still needs work:

- Move from a single accumulator to a reusable inferred-work-state engine with confidence and transition reasons.
- Track pattern breaks using richer evidence than app category alone:
  - preceding work streak duration
  - context switches before the break
  - whether the shift occurred inside learned peak hours
  - whether the break returned to the prior work thread
- Make browser/domain evidence part of passive distraction detection when available.
- Persist inferred work-state transitions and passive distraction events directly, without requiring a manual focus session.
- Store more than alerts:
  - inferred state entered
  - inferred state exited
  - candidate drift
  - confirmed drift
  - recovered-to-thread

Implementation target:

- Introduce `src/main/services/inferredWorkState.ts`.
- Feed it live session updates from `tracking.ts`.
- Let `distractionAlerter.ts` consume inferred state instead of recomputing its own lightweight model.

### 2. Replace category-ratio focus scoring with rhythm-based scoring

Relevant files:

- `src/main/lib/focusScore.ts`
- `src/main/db/dailySummaries.ts`
- `src/main/services/workBlocks.ts`
- `src/main/services/tracking.ts`

Current problem:

- `focusScore.ts` is still dominated by focused-seconds / total-seconds, which contradicts the philosophy.

New score inputs:

- session depth
  - longest coherent block
  - median meaningful block length
- continuity
  - context switches per hour
  - fragmentation count
- recovery
  - how often short breaks return to the same thread
- rhythm alignment
  - whether strong blocks occur during learned best hours
- penalty signals
  - prolonged pattern breaks during established work state

Implementation target:

- Keep the score deterministic and explainable.
- Produce both:
  - a 0-100 score
  - a feature breakdown object for UI and insights

Suggested shape:

- `depthScore`
- `continuityScore`
- `rhythmScore`
- `breakPenalty`
- `recoveryBonus`
- `confidence`

### 3. Demote manual focus sessions from primary feature to optional power tool

Relevant files:

- `src/renderer/views/Focus.tsx`
- `src/main/ipc/focus.handlers.ts`
- `src/main/db/schema.ts`
- `src/main/db/queries.ts`

Current problem:

- The Focus view is still a Pomodoro-first screen with manual label and duration setup.

New direction:

- Reposition the Focus tab around passive focus understanding first.
- The default screen should answer:
  - what kind of work state are you in right now?
  - how strong has today been so far?
  - where has momentum held or broken?
  - what thread should you resume?
- Manual sessions stay, but as a secondary tool:
  - "Start guided session"
  - "Add a plan for the next hour"
  - "Do not disturb for 50 minutes"

Implementation target:

- Split the current page into:
  - passive overview
  - current momentum card
  - recent pattern breaks
  - optional guided focus controls

### 4. Remove template-driven pseudo-insights where deterministic evidence is better

Relevant files:

- `src/renderer/components/InsightCard.tsx`
- `src/renderer/views/Today.tsx`
- `src/renderer/views/Insights.tsx`
- `src/main/lib/insightsQueryRouter.ts`

Rule:

- Do not ship cards that say the equivalent of "you spent X in Development, consider blocking distractions."

Replace with either:

- a deterministic evidence-backed statement
- a real AI-generated synthesis
- nothing

## Architecture Changes

### A. Introduce a structured evidence layer

Before AI sees anything, the app should compute a structured local representation for each work block.

For each block/window, derive:

- top apps
- top domains
- representative titles
- block duration
- switch count
- dominant mode
- predecessor and successor block relationship
- resumed-thread likelihood
- ambiguity/confidence score

Suggested modules:

- `src/main/services/workEvidence.ts`
- `src/main/services/threadInference.ts`

This becomes the shared substrate for:

- deterministic labels
- passive summaries
- insights retrieval
- optional AI prompting

### B. Make deterministic labeling the first pass

Relevant files:

- `src/main/services/workBlocks.ts`
- `src/main/services/ai.ts`

Plan:

1. Build a deterministic label candidate from evidence.
2. Score its confidence.
3. Use it directly when confidence is high.
4. Only call AI when confidence is low or the user explicitly re-analyzes.

Examples of deterministic labels:

- `GitHub PR review`
- `Auth migration research`
- `Docs writing`
- `Terminal debugging`
- `YouTube break`

AI should mostly improve:

- specificity
- wording
- multi-signal disambiguation

### C. Replace "AI observation -> AI synthesis" with "evidence -> optional narration"

If the Windows app inherits the same pattern as macOS over time, avoid a pipeline that:

1. turns raw evidence into prose
2. turns prose back into structured cards

That is expensive and lossy.

Preferred order:

1. derive structured evidence locally
2. segment and label locally
3. optionally ask AI to rewrite labels/narratives for ambiguous blocks

## AI Usage Policy

AI is allowed when it adds meaning that deterministic logic cannot provide cheaply.

AI is not required for:

- top work blocks
- biggest pattern breaks
- focus score
- weekly shape
- exact-time answers
- "what did I spend the most time on?"

AI is useful for:

- "what was I probably trying to do from 11:10 to 12:25?"
- "summarize the real story of this week"
- "name this mixed block more cleanly"
- "find recurring themes across noisy evidence"

## Insights Split

Relevant files:

- `src/main/lib/insightsQueryRouter.ts`
- `src/main/services/ai.ts`
- `src/renderer/views/Insights.tsx`

Target model:

- Retrieval-first
- Deterministic reasoning second
- AI last

Expand the local router to cover:

- exact time ranges
- top threads by day/week
- strongest focus window
- largest pattern break
- resume-next
- day-over-day comparisons
- peak-hour summaries

Only escalate to AI when the question is:

- open-ended
- ambiguous
- cross-period and narrative-heavy

## Data Model Additions

Consider adding tables or persisted artifacts for:

- inferred work states
- passive distraction events
- work-block evidence packets
- thread continuity links
- focus score feature breakdowns
- learned rhythm model snapshots

This keeps derived intelligence reusable across Today, History, Focus, Reports, and Insights.

## Rollout Order

### Phase 1

- Land `inferredWorkState.ts`
- Refactor passive distraction detection to depend on it
- Persist passive distraction events without focus-session dependency

### Phase 2

- Rewrite `focusScore.ts`
- Save feature breakdowns alongside daily summaries
- Update Today and Focus surfaces to explain the new score

### Phase 3

- Refactor Focus view into passive-first experience
- Keep manual guided sessions as optional controls

### Phase 4

- Add structured evidence derivation and deterministic block labeling
- Use AI only for low-confidence relabeling and richer narratives

### Phase 5

- Expand `insightsQueryRouter.ts` for more local answers
- Tighten AI escalation rules

### Phase 6

- Remove any remaining template insight cards that collapse back to category-time reporting

## Windows-Specific Notes

- Browsers on Windows are especially important because GitHub, docs, AI tools, cloud consoles, and admin work all live there.
- Window title quality varies by app, so evidence scoring should explicitly rank:
  - page title
  - domain
  - executable/app identity
  - recency and adjacency
- Process names alone are weak evidence and should not dominate labels.
- The passive model should tolerate noisy focus changes from Electron apps, launchers, and shell transitions.
- Current browser evidence is history-based and delayed, so real-time inference should treat browser/site evidence as approximate unless a stronger foreground-tab layer is added later.
- Before adding more AI or inference complexity, tracking parity should tighten around:
  - idle semantics
  - deactivation smoothing
  - canonical app identity
  - minimum-duration thresholds
- `wmic` and Windows Timeline history should not become core dependencies for inference. Treat them as opportunistic sources, not foundation layers.

## Definition Of Done

The Windows app is aligned when all of this is true:

- a user can install it with no AI configured and still get meaningful passive insights
- distraction detection works without manual focus sessions
- focus score is no longer mostly a category-time ratio
- the Focus tab no longer requires the user to declare intent to be useful
- insight cards and summaries tell the story of the work, not the story of the container
- AI improves unclear cases instead of carrying the whole product
