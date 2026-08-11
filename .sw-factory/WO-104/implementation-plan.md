<!--lint disable no-undefined-references strong-marker-->

# Implementation Plan: WO-104

**Work Order:** WO-104 — [backend] Wire common interpretation and tone into Wrapped and brief prompts
**Created At (UTC):** 2026-08-11T08:32:45Z

## Summary

Give every narrative surface the person's chosen tone and the shared
interpretation directives, so the tone toggle moves the words on the screens
people actually read and the surfaces stop describing the same activity under
different rules. Wrapped deck validation, the deterministic fallback, agent
prompts, and time-chunk wording stay out.

## Code Reuse And Package Structure

Reused rather than rebuilt:

- `src/shared/summaryVoice.ts` — `voiceDirective`, `normalizeSummaryVoice`. The
  tone instruction already exists and is already correct; three surfaces use it
  and three do not. No new tone text is written.
- `src/shared/activityDescription.ts` (WO-99) — the directives.

Modified:

- `src/shared/activityDescription.ts` — split the directive block in two (see
  Components And Flow). **Owned.**
- `src/main/lib/wrappedNarrative.ts`, `src/main/lib/wrappedPeriodNarrative.ts` —
  interpretation directives into the deck prompts; prompt versions bumped.
  **Owned.**
- `src/main/services/wrappedQuestion.ts` — interpretation directives.
  **Owned.**
- `src/main/jobs/aiService.ts` — tone into the brief, the week review, and the
  Apps narrative; the brief's cache key; D4. **Prompt-building region only.**

No schema change, no migration. Range 85-89 untouched.

## Components And Flow

`#SummaryVoiceDirective` feeds `#NarrativePromptComposer`. Today three of six
composers consume it. After this work order, six do.

**The directive split is the one design decision here.** WO-99 shipped one flat
`ACTIVITY_DESCRIPTION_DIRECTIVES`. Applied wholesale to Wrapped it would
contradict Wrapped's own rules: the deck prompt says "EARNED PRAISE IS ALLOWED
and welcome when the facts back it", and a blanket no-judgment line would fight
that. AC-VIC-003.2 is narrower than the flat line implied: it bans a judgment
drawn *from incomplete evidence*, not grounded praise.

So the constant splits into two, and the combined name keeps its meaning:

- `INTERPRETATION_DIRECTIVES` — what the evidence supports: activity before
  telemetry, no plumbing, name only what is supported, facts are not the model's
  to create, no weak phrases, never copy a title, state a limit once and never
  first. Safe on every surface, and this is what Wrapped gets.
- `DESCRIPTION_VOICE_DIRECTIVES` — vocabulary bans and the judgment rule,
  reworded so grounded praise stays legal and ungrounded grading does not.
- `ACTIVITY_DESCRIPTION_DIRECTIVES` — both, unchanged as a name so WO-99's
  tests hold.

## Steps

1. **Split the directives** in `activityDescription.ts` and reword the judgment
   line to match AC-VIC-003.2's actual scope: never grade productivity, focus,
   distraction, or worth from thin evidence; praise a real named thing when the
   evidence carries it.

2. **The brief gets its tone (D1).** `voiceDirective(getSettings().summaryVoice)`
   into `generateDaySummary`'s system prompt, beside the profile directive that
   is already read from the same settings object. Read settings once rather than
   twice.

3. **The brief's cache learns about tone (D3).** The voice joins
   `daySummaryCacheKey`'s inputs. This is a process-lifetime `Map`, so keying it
   costs nothing and a tone change takes effect on the next open. Deliberately
   NOT done for stored Wrapped narratives: see `context.md`.

4. **Apps and the week review get their tone (D2).** Same one-line addition in
   `generateAppNarrative` and `generateWeekReview`.

5. **Interpretation directives into the three Wrapped prompts** —
   `buildWrappedPrompts`, `buildPeriodPrompts`, and the Wrapped question prompt.
   Bump `DAY_WRAP_PROMPT_VERSION` and `PERIOD_WRAP_PROMPT_VERSION`: the analysis
   ledger records which prompt wrote a wrap, and the prompt changed.

6. **Fix the self-contradicting punctuation rule (D4).** Rewrite the tail of
   `USER_VISIBLE_ACTIVITY_PROSE_RULE` to demonstrate the row shape with a colon
   instead of an em dash, matching what `VOICE_SYSTEM_PROMPT` requires in the
   same prompt.

## Testing

New: `tests/toneAcrossSurfaces.test.ts`. Extended:
`tests/voicePromptCoverage.test.ts` (WO-107 extends it further).

- AC-VIC-002.1: `voiceDirective` returns a distinct instruction for each of
  `straight`, `warm`, `witty`, and falls back to `warm` for a missing or invalid
  stored value.
- AC-VIC-002.2: a static scan asserts every narrative prompt site imports and
  references `voiceDirective` — the same shape as the existing
  `VOICE_SYSTEM_PROMPT` coverage test, so a new narrative job cannot ship
  without the tone.
- AC-VIC-002.1 / D3: two `buildDaySummaryScaffold`-adjacent checks are not
  enough here; the cache key is internal, so the test asserts the exported
  behaviour it can reach and the review log records what stays unverified.
- AC-VIC-002.3: `INTERPRETATION_DIRECTIVES` is present in the day deck prompt,
  the period deck prompt, and the Wrapped question prompt, so the three describe
  the same activity under the same rules.
- D4: `USER_VISIBLE_ACTIVITY_PROSE_RULE` contains no em dash, and the general
  invariant that no prompt constant in the file teaches one.
- The Wrapped conflict this plan avoids: the deck prompt still contains its
  earned-praise rule after the directives are added, and the directives added to
  it do not contain the blanket judgment ban.

Commands:

```bash
node scripts/run-tests.mjs tests/toneAcrossSurfaces.test.ts tests/voicePromptCoverage.test.ts tests/activityDescriptionPolicy.test.ts tests/wrappedNarrative.test.ts
npm run typecheck && npm run lint
```

Exploratory pass: switch tone in Settings and reopen the day recap. Feasibility
in this environment is assessed and recorded honestly in `review-log.md` rather
than claimed.
