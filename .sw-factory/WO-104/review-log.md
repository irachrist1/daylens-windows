<!--lint disable strong-marker-->

# Review Log: WO-104

**Work Order:** WO-104 — [backend] Wire common interpretation and tone into Wrapped and brief prompts
**Initialized At (UTC):** 2026-08-11T08:32:45Z

This file records review and verification rounds. Append new rounds; do not overwrite prior rounds.

---

## Round 1 — 2026-08-11, in-session review of the landed implementation

**Verdict: APPROVED.**

**Method.** No review subagent, for the reason recorded in WO-99 Round 1 (the
harness forbids spawning agents unless the person asks). Reviewed in-session:
code reading of the six prompt composers plus the test evidence below.

### Shared-file discipline

`src/main/jobs/aiService.ts` edits are confined to the prompt-building region:
`USER_VISIBLE_ACTIVITY_PROSE_RULE`, `generateDaySummary`'s prompt and cache key,
the `week_review` system prompt, the `app_narrative` system prompt, and two
import lines. No capture, provider, persistence, orchestration, or agent code.

### Acceptance criteria

| Criterion | Verdict | Evidence |
| --- | --- | --- |
| AC-VIC-002.1 | Met | `voiceDirective` now applied in six composers, up from three. Each of `straight`/`warm`/`witty` produces a distinct instruction, and a missing or invalid stored value normalizes to `warm` (asserted over `undefined`, `null`, `''`, an unknown string, a number, an object). The brief's cache is keyed on the resolved voice, so the toggle takes effect on the next open rather than at the next process restart. |
| AC-VIC-002.2 | Met for the five surfaces in scope | Wrapped day, Wrapped period, Wrapped question, the brief, the week review, and Apps all carry it. A static scan asserts every listed narrative prompt site imports from `summaryVoice` and calls `voiceDirective`, so a new job cannot ship without it. The agent is WO-105 and is deliberately not counted here. |
| AC-VIC-002.3 | Met for these surfaces | `INTERPRETATION_DIRECTIVES` is in all six composers, asserted per site with a fallback to the site's `lib/` composer where the service delegates. |

### The finding this work order closes

The lane briefing recorded that `voiceDirective(settings.summaryVoice)` was
applied in `wrappedNarrative.ts:203`, `wrappedPeriodNarrative.ts:287`, and
`wrappedQuestion.ts:120` but not in `generateDaySummary`, so selecting a tone
moved Wrapped and not the day recap. Confirmed exactly as described, and closed
here rather than in WO-105.

**Why here, against the briefing's placement.** `src/shared/aiFeatures.ts:14`
maps `day_summary` to `'Morning brief'`, and `dailySummaryNotifier.ts:251`
delivers it as the morning-brief notification. The day recap *is* the brief, so
it belongs to this work order, whose title names brief prompts. WO-105's own Out
of Scope list explicitly excludes "Wrapped and Proactive Brief prompt
composition", so fixing it there would have contradicted the work order text.
WO-105's review log records that it was closed one work order earlier, with this
evidence, so the trail is not lost.

Two things were needed, not one. Adding the directive alone would have left the
toggle looking dead: `daySummaryCacheKey` carried no tone component, so a person
switching voice would keep reading the cached recap in the old one for the life
of the process. Both landed.

### Three further defects found and fixed

- **D2 — Apps and the week review had no tone.** AC-VIC-002.2 names Apps
  explicitly. Neither `generateAppNarrative` nor `generateWeekReview` applied
  `voiceDirective`. Both do now.
- **D4 — a prompt taught the punctuation the same prompt bans.**
  `USER_VISIBLE_ACTIVITY_PROSE_RULE` ended "Do not put the app name before the
  em-dash. The em-dash separates activity (left) from attribution + duration
  (right)", and it is composed into the same system prompt as
  `VOICE_SYSTEM_PROMPT`, which says never to write an em dash and whose own
  comment records that the model imitates the punctuation of its prompt. The row
  shape is now demonstrated with a colon, and a test asserts no em dash survives
  in that constant.
- **The directive block had to be split.** WO-99 shipped one flat
  `ACTIVITY_DESCRIPTION_DIRECTIVES` containing a blanket "NO JUDGMENT ... never
  imply a day was well or badly spent". Composed into the Wrapped decks, that
  would have contradicted their own rule three lines below: "EARNED PRAISE IS
  ALLOWED and welcome when the facts back it". AC-VIC-003.2 is narrower than the
  flat line implied. It bans a judgment drawn *from incomplete evidence*, not a
  grounded observation. So the constant split into `INTERPRETATION_DIRECTIVES`
  (portable) and `DESCRIPTION_VOICE_DIRECTIVES` (vocabulary and grading,
  reworded to that actual scope), with the combined name preserved. A test
  asserts the decks take the interpretation half only and keep their
  earned-praise rule.

  This is worth naming plainly: shipping the flat block into Wrapped would have
  made the prompt argue with itself, which is the exact class of defect D4
  records. It was caught by reading the target prompt before composing into it.

### F1 — known limit. A stored wrap does not re-voice

Changing tone does not regenerate a Wrapped narrative that already exists.
`computeFactsHash` carries no tone component, and it was deliberately left that
way. Putting the voice in that hash would make every stored past day regenerate
on next open, spending one provider call each, and would write
`reason: 'facts-changed'` into the analysis ledger, which would be false: the
facts did not change. It would also fight an explicit product stance recorded at
`wrappedNarrative.ts:111` ("A wrap is never silently regenerated").

The person's Regenerate button applies the new tone. A future re-voice-on-change
needs a stored voice column alongside `factsHash`, which is a schema change in
`src/main/db/schema.ts` and belongs to whoever owns that file. Recorded as a
cross-lane dependency rather than forced through.

### F2 — deliberate exclusion. Block labels get no tone

`generateWorkBlockInsight` produces a Timeline block label and narrative and was
left without `voiceDirective`. A label is not tone-bearing prose: the label
policy bans hype outright, and pushing a witty voice into a label generator
would produce candidates `labelCandidateViolation` then rejects, spending a
retry to arrive back where it started. AC-VIC-002.2 names Timeline, and Timeline's
tone-bearing surface is the recap that describes it, which is covered. Recorded
as a decision, not an oversight.

### Cross-lane dependencies

- **`src/main/db/schema.ts`** — a stored-voice column is what F1 needs. Not
  edited; another session owns it.
- **`src/main/services/analyzeDay.ts`** — carries its own
  `ANALYZE_DAY_PROMPT_VERSION` and its own prompt; another session owns it. If
  it composes activity descriptions, it should take `INTERPRETATION_DIRECTIVES`
  too. Not edited, flagged here.

### Blueprint alignment

**Aligned** with the Integration Contract "Fact validation remains independent of
tone selection": no validator, fact table, or deck schema was touched, and the
89 wrap-validation tests pass unchanged.

**Discrepancy — the Proactive Brief does not exist.** The blueprint's
`#NarrativePromptComposer` is described as building "Wrapped day, period, and
brief prompts". There is no brief composer. `weekly_brief` is a registered job
type (`aiOrchestration.ts:297`) with no composer and no caller anywhere in
`src/`: a job configuration for a surface that was never built. The brief that
exists is the day recap. Built against that. No Factory document was edited.

`DAY_WRAP_PROMPT_VERSION` 2 to 3 and `PERIOD_WRAP_PROMPT_VERSION` 1 to 2, because
the analysis ledger records which prompt wrote a wrap and the prompts changed.

### Tests

```
tests/toneAcrossSurfaces.test.ts     9 pass   (new)
tests/wrappedNarrative.test.ts      41 pass   (untouched)
tests/wrappedQuestion.test.ts        5 pass   (untouched)
tests/wrapDeck.test.ts              19 pass   (untouched)
tests/wrapHonesty.test.ts           18 pass   (untouched)
tests/wrapNarrativeGrounding.test.ts 10 pass  (untouched)
tests/wrapAdversarial.test.ts        9 pass   (untouched)
tests/wrapFactTable.test.ts         12 pass   (untouched)
tests/wrapPreflight.test.ts         11 pass   (untouched)
tests/wrapAnchors.test.ts            4 pass   (untouched)
tests/wrappedNarrativeInvalidation.test.ts  4 pass
tests/wrappedNarrativeCompletedDay.test.ts  2 pass
```

The 89 untouched wrap-validation passes are the evidence for "fact validation
remains independent of tone selection". `npm run typecheck` clean.

### Exploratory pass

**Not run.** The check is: switch tone in Settings, reopen the day recap, confirm
the words changed. It needs the Electron app running against the owner's real
activity database and a live provider call per tone, and the repository is public
so the output could not be recorded here. What the hermetic tests do prove is
that the directive and the tone-keyed cache reach the prompt; what stays
unverified by this lane is the model's response to them. Flagged for the final
reviewer, who has the app and the database.
