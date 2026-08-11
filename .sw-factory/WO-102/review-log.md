<!--lint disable strong-marker-->

# Review Log: WO-102

**Work Order:** WO-102 — [backend] Apply shared interpretation with verbatim user-label precedence
**Initialized At (UTC):** 2026-08-11T08:32:45Z

This file records review and verification rounds. Append new rounds; do not overwrite prior rounds.

---

## Round 1 — 2026-08-11, in-session review of the landed implementation

**Verdict: APPROVED.**

**Method.** No review subagent: this session's harness forbids spawning agents
unless the person asks, and they did not. Reviewed in-session by reading the
changed code against `blockLabel.ts` and `workBlocks.ts` as the parity
references, plus the test evidence below.

### Shared-file discipline

`src/main/jobs/aiService.ts` is shared with two other sessions. Every edit this
work order made to it is inside the prompt-building region:

- `buildDaySummaryScaffold` and `daySummaryCacheKey` (the recap prompt and its
  key)
- `buildWeekReviewBundle`'s block rows and day rows (the week-review prompt)
- one new prompt constant, `USER_AUTHORED_LABEL_RULE`, declared beside
  `USER_VISIBLE_ACTIVITY_PROSE_RULE`
- one import line

No capture, provider, persistence, orchestration, or agent code was touched. No
function signature changed.

### Acceptance criteria

| Criterion | Verdict | Evidence |
| --- | --- | --- |
| AC-VIC-004.1 | Met, now tested | `userVisibleBlockLabel` returns a user override byte-for-byte even when it carries a raw URL, a judgment word, and tab soup at once. The companion test asserts `labelCandidateViolation` still rejects that same string as a model candidate, so the policy is bypassed for one provenance rather than weakened. Both user paths covered: `override` row and `source: 'user'` review. |
| AC-VIC-004.2 | Met | The recap scaffold now emits the label the Timeline shows. Proved twice: a user override reaches the prompt, and a generic floor label ("Development") resolves past to the AI label rather than reaching the prompt as "Development". |
| AC-VIC-004.3 | Met | A user-authored block carries `labelIsTheirOwnWords` in the scaffold; an evidence-derived block carries no such key, so the marker carries information. `USER_AUTHORED_LABEL_RULE` states the consequence in the prompt: quote their wording, never re-derive a fact from it, never carry a name out of it into another sentence. |
| AC-VIC-001.1 | Advanced, not closed | The prompt path and the screen path now resolve the label the same way at six sites. Other surfaces still resolve independently; that is WO-104 through WO-106. |

### D1 was the real find, and it is bigger than the work order framed it

The work order is written about user labels. The defect the code actually had is
that **six narrative prompt sites described blocks by a label no screen shows** —
`block.label.current` raw, while every screen renders
`userVisibleBlockLabel(block)`. The two diverge whenever `current` fails
`isUsefulLabel`, and the finalizer's own floor
(`prettyCategory(block.dominantCategory)`, `workBlocks.ts:4916`) produces exactly
the strings `isUsefulLabel` rejects: "Development", "Browsing", "Communication".

So the common case was: the person sees "Reworking the sync engine" on the
Timeline, and the recap is told "Development" and writes the day around that
word. That affected every block on an un-analyzed day, not only renamed ones.
Fixed at all six sites. The user-label case is a subset of it.

`userVisibleBlockLabel` was already imported in that file and called at exactly
one place. The fix was to use it at the other six.

### Checked and NOT a defect

`daySummaryCacheKey` keyed on `block.label.current`, which looks like a
cache-invalidation bug: rename a block, get a stale recap. It is not, because the
finalizer writes the override into `current`, so the key does change. The key was
still moved onto the resolved label for consistency with the prompt it guards;
that is a tidy-up, not a fix, and is not claimed as one.

### F1 — recorded limit, no action. The finalizer is not gated

AC-VIC-004.1 is held by a test on the read path, not by a gate in the finalizer.
A gate belongs in `src/main/services/workBlocks.ts`, which another session owns
and this lane must not edit. Recorded as a cross-lane dependency below rather
than reached for.

### F2 — recorded limit. Provenance reaches two prompts, not five

`labelIsTheirOwnWords` is carried into the day recap and the week review. Wrapped
(WO-104), the agent (WO-105), and the time-chunk renderer (WO-106) build their
own payloads and are out of this work order's scope by its own Out of Scope
list. Until those land, AC-VIC-004.3 holds on two of five surfaces. Stated
plainly so it is not read as done everywhere.

### Cross-lane dependencies

- **`src/main/services/workBlocks.ts`** (owned by another session) — the place a
  finalizer-level user-label gate would live, per F1. Not edited. If that session
  ever adds policy evaluation to the label chooser, it must exclude
  `override`-sourced labels, or AC-VIC-004.1 breaks. `userAuthoredLabel` in
  `labelVoice.ts` is the helper to use.
- **`src/shared/types.ts`** (owned by another session) — `BlockLabel.source` and
  `LabelSource` were read, not changed. No new field was needed.

### Blueprint alignment

**Discrepancy 1 — the governing blueprint says the precedence question is
open, and it is not.** Voice & Interpretation Contract states, twice:

> The required precedence and any invariant treatment for an override remain an
> explicit product decision.

> The user-authored-label precedence rule is pending product confirmation.

REQ-VIC-004, embedded in this work order's own description, *is* that decision:
a user label is used verbatim and is never altered, rejected, or replaced by the
policy. The blueprint has not caught up with its own requirement. Built against
REQ-VIC-004. No Factory document was edited.

**Discrepancy 2 — the blueprint frames the override as a policy-ordering
problem.** It says `#BlockLabelFinalizer` "currently lets a user override win
before policy evaluation", implying the ordering is the risk. The real risk was
the opposite one, and the blueprint does not mention it: the override wins on
screen and never reached the prompts, so the surfaces disagreed about what the
block was called. Recorded.

### Tests

```
tests/userLabelPrecedence.test.ts    8 pass   (new)
tests/daySummaryScaffold.test.ts     5 pass   (untouched — scaffold shape unchanged)
tests/recapContract.test.ts         14 pass   (untouched)
tests/eveningRecapFreshness.test.ts 10 pass   (untouched)
tests/labelVoice.test.ts            18 pass   (untouched)
tests/activityDescriptionPolicy.test.ts  18 pass
```

`npm run typecheck` clean.

### Exploratory pass

**Not run, and the reason is not "no time".** The check the plan specified —
rename a Timeline block to policy-violating wording, open the day recap, confirm
it quotes the wording without asserting it — requires launching the Electron app
against the owner's real activity database and spending a live provider call on
a real day. This lane works in a git worktree with no configured provider, and
the repository is public, so the output could not be recorded here even if it
ran. The nearest hermetic substitute did run: the scaffold assertions above prove
the wording and the marker reach the prompt, which is everything up to the model.
What remains unverified by this lane is how the model behaves given that prompt.
Flagged for the final reviewer.
