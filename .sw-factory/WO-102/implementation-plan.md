<!--lint disable no-undefined-references strong-marker-->

# Implementation Plan: WO-102

**Work Order:** WO-102 — [backend] Apply shared interpretation with verbatim user-label precedence
**Created At (UTC):** 2026-08-11T08:32:45Z

## Summary

Make the narrative prompts consume the same finalized activity meaning the
screens consume, and carry each label's provenance with it so a model can never
present the person's own wording as something Daylens observed. The verbatim
precedence itself already holds in the code; this work order makes it explicit,
tested, and honest downstream.

## Code Reuse And Package Structure

Reused rather than rebuilt:

- `src/shared/blockLabel.ts` — `userVisibleBlockLabel`. The authority for the
  displayed label, already imported in `aiService.ts`. The fix is to call the
  function that already exists at the six sites that bypass it, not to write a
  second resolver.
- `src/shared/activityDescription.ts` (WO-99) — `DescriptionProvenance`. The
  provenance vocabulary is defined once; this work order reads a block into it.

Modified:

- `src/shared/labelVoice.ts` — gains `labelProvenance` and
  `userAuthoredLabel`, the two helpers that read a block's label provenance.
  **Owned.**
- `src/main/jobs/aiService.ts` — six prompt sites switch to the resolved label;
  the day-recap scaffold and week bundle gain a provenance marker; one directive
  line is added. **Shared file. Edits are confined to the prompt-building
  region (`buildDaySummaryScaffold`, `buildWeekReviewBundle`, and the module's
  prompt-rule constants); no capture, provider, persistence, or agent code is
  touched.**

No schema change and no migration: `BlockLabel.source` already exists and is
already populated by both user paths. The lane's reserved range 85-89 is
untouched.

## Components And Flow

`#BlockLabelFinalizer` supplies the label and its source on `WorkContextBlock`.
This work order makes `#NarrativePromptComposer` consume both, closing the
Integration Contract that says Timeline and the narrative surfaces consume "that
same finalized activity meaning".

Flow, per block, at every prompt site:

1. `userVisibleBlockLabel(block)` resolves the label the screen shows. A user
   override short-circuits it verbatim, which is AC-VIC-004.1 and AC-VIC-004.2 in
   one call.
2. `labelProvenance(block)` returns `'user'` when the label is the person's own
   wording and `'evidence'` otherwise.
3. The scaffold carries both. A `'user'` label is marked in the payload as the
   person's own words.
4. One directive line states the rule the marking exists to enforce: repeat a
   user label as their name for the stretch, never as something Daylens
   observed, and never treat a name inside it as evidence for anything else.

## Steps

1. **Add the two provenance helpers to `labelVoice.ts`.** `userAuthoredLabel`
   returns the verbatim user wording or null; `labelProvenance` maps a block to
   `DescriptionProvenance`. Both read structurally (`label.override`,
   `label.source`), matching how `labelVoiceContextForBlock` already reads
   blocks, so a projection with a slightly different shape does not break them.
   Both must treat *either* user path as user-authored: a `block_label_overrides`
   row sets `override`, and a corrected review sets `source: 'user'`.

2. **Point the six prompt sites at `userVisibleBlockLabel`.** `aiService.ts`
   lines 1876, 2146, 2189, 2217, 2256, 2588. This is D1, and it is the change
   that makes the recap describe the day the person is looking at.

3. **Carry provenance into the day-recap scaffold and the week bundle.** A block
   whose label is the person's own gets an explicit marker in the JSON rather
   than a silent string, because a model cannot infer provenance from wording.

4. **State the rule once, as a directive.** A new constant beside
   `USER_VISIBLE_ACTIVITY_PROSE_RULE`, added to the day-recap and week-review
   system prompts. It says what AC-VIC-004.3 requires in the prompt's own voice:
   the person's wording is theirs, quote it, never re-derive from it.

5. **Do not touch the finalizer.** `workBlocks.ts` owns label finalization and
   another session owns that file. The policy-bypass guarantee (AC-VIC-004.1) is
   locked in by test rather than by a new gate, because a new gate would have to
   live in that file.

## Testing

New: `tests/userLabelPrecedence.test.ts`.

- AC-VIC-004.1: a user override that violates *every* invariant of the
  activity-description policy at once — a raw URL, a judgment word, and
  browser-tab soup — still comes back from `userVisibleBlockLabel` byte-for-byte.
  This is the regression test the guarantee never had.
- AC-VIC-004.1: `labelCandidateViolation` rejects that same string when it
  arrives as a model candidate. The policy is not weakened; it is bypassed for
  one provenance only.
- AC-VIC-004.2: a block with a user override reports `labelProvenance === 'user'`
  and `userAuthoredLabel` equal to the override, through both user paths
  (`override` set, and `source: 'user'` from a corrected review).
- AC-VIC-004.2 / D1: `buildDaySummaryScaffold` on a block whose `label.current`
  is a generic floor label ("Development") but which carries a real artifact
  emits the label the screen shows, not "Development".
- AC-VIC-004.3: the scaffold marks a user-authored block as the person's own
  words, and the day-recap system prompt states the rule.
- A block with no user input reports `'evidence'` and carries no marker, so the
  marker means something.

Fixtures are invented activity: an invented client, invented artifact titles, an
invented repository. No real label or recap enters the repository.

Commands:

```bash
node scripts/run-tests.mjs tests/userLabelPrecedence.test.ts tests/labelVoice.test.ts tests/activityDescriptionPolicy.test.ts tests/aiRecapPrompt.test.ts
npm run typecheck && npm run lint
```

Exploratory pass: rename a Timeline block to wording the policy would reject,
then open the day recap and confirm it uses that wording and does not assert it
as an observation. Recorded in `review-log.md` under Exploratory pass, including
whether it could actually be run in this environment.
