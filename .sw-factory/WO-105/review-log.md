<!--lint disable strong-marker-->

# Review Log: WO-105

**Work Order:** WO-105 — [backend] Apply the selected tone and description policy to agent responses
**Initialized At (UTC):** 2026-08-11T08:32:45Z

This file records review and verification rounds. Append new rounds; do not overwrite prior rounds.

---

## Round 1 — 2026-08-11, in-session review of the landed implementation

**Verdict: APPROVED, with one process defect recorded against this execution
itself.**

**Method.** No review subagent, for the reason recorded in WO-99 Round 1.
Reviewed in-session: code reading of the agent prompt composer and both call
sites, plus the test evidence below.

### Process defect in this execution

**The code was written before `implementation-plan.md`.** The execution process
requires the plan first, and WO-99, WO-102, and WO-104 each followed it. This one
did not: `systemPrompt.ts`, `chatAgent.ts`, `aiService.ts`, and the test file
were changed, then the context and plan were written. The plan as it stands
describes what landed, which is the correct end state but not the correct order.

Recording it rather than backdating it. The concrete risk it created is the one
worth naming: the conflict below was found while composing, not while planning,
and a plan written first is where that should have been caught.

### Shared-file discipline

`src/main/jobs/aiService.ts`: two lines, both `summaryVoice: settings.summaryVoice`
passed to a prompt builder, at call sites where `settings` was already in scope.
Nothing else in that file was touched by this work order.

`src/main/agent/chatAgent.ts` is not on this lane's owned list and is not on the
do-not-touch list. Three lines: one optional dep field, one pass-through, one
type import. No behaviour changes for a caller that omits it.

### Acceptance criteria

| Criterion | Verdict | Evidence |
| --- | --- | --- |
| AC-VIC-002.1 | Met | Each of the three tones appears in the prompt as its exact directive; `undefined` and `null` both normalize to warm, so a caller without settings gets the default voice rather than a prompt missing the tone line. |
| AC-VIC-002.2 | Met for the agent | The agent now takes the same `voiceDirective` the brief, Wrapped, Apps, and the week review take. With WO-104, all five surfaces AC-VIC-002.2 names are covered. |
| AC-VIC-001.1 | Met for the agent | Every directive in `ACTIVITY_DESCRIPTION_DIRECTIVES` appears in the built prompt, asserted directive by directive rather than by a spot check. |
| AC-VIC-001.4 | Met for the agent | Every term of `DESCRIPTION_PLUMBING_VOCAB` appears in the prompt, so the agent's ban is the shared one and not a second list. |
| AC-VIC-003.2 | Met for the agent | The no-grading rule is present; nothing in the agent prompt banned grading before. |
| AC-VIC-003.3 | Met for the agent | The evidence-ownership rule is present. |
| AC-VIC-003.1 | Advanced, not closed | The agent is told to state a limit once and never first. It is not handed a `SupportedInterpretation` with `captureLimits`, so `uncertaintyStatement` is not what produces the sentence; the model does, under instruction. Marked advanced rather than met so this is not read as stronger than it is. |

### The conflict, and why it was worth stopping for

`ACTIVITY_DESCRIPTION_DIRECTIVES` as WO-99 shipped it ended: "If a duration is
not in the evidence, do not state a duration." The agent prompt requires:

> When a duration or total IS the answer, compute it precisely from the tool
> result's start and end and state the figure plainly to the minute.

Composed together, the agent would have been told both to compute the span and
not to state it. The directive is now worded to permit derivation from recorded
evidence and forbid only invention, which is what AC-VIC-003.3 actually says: a
model "cannot originate" a fact, not "cannot compute one from facts it was
given".

This is the second time in this lane that composing a shared block into an
existing prompt surfaced a contradiction (WO-104's was the Wrapped earned-praise
rule). The pattern is worth stating for whoever extends this policy next: read
the target prompt before composing into it. A shared directive block is not
free.

### F1 — recorded limit. Instructed, not enforced

Everything this work order added to the agent is prompt text. Nothing evaluates
an agent answer against `evaluateActivityDescription` before it reaches the
person, and nothing could: the answer streams token by token, and the existing
`findBannedVocab` and `findPlumbingVocab` are documented as soft, post-hoc voice
monitoring for exactly that reason. So the agent is now *told* the policy under
the same words as every other surface; it is not *held* to it at runtime. That is
the same standing as every other rule in that prompt, and it is not a regression,
but "met for the agent" above means the prompt carries the rule, not that an
answer is checked. Stated so the criterion table is not overread.

### Cross-lane dependencies

- **`src/main/services/interpretationAgent.ts`** (do-not-touch, another session)
  composes `VOICE_SYSTEM_PROMPT` at line 206 and would take the shared directives
  the same way. Not edited. Flagged.
- **`src/main/services/analyzeDay.ts`** (do-not-touch) likewise.

### Blueprint alignment

**Aligned, and this is the one place the blueprint had it right.** Voice &
Interpretation Contract states that `#AgentSystemPromptBuilder` "must add the
person's selected `SummaryVoice` directive for cross-surface tone parity" and
"must pass the `SummaryVoice` directive and the generic voice contract to the
agent". Both were accurate descriptions of a real gap, and both are now closed.
No discrepancy to record for this work order.

### Finding 1 from the lane briefing

The briefing assigned the missing `voiceDirective` in `generateDaySummary` to
this work order. It was closed in **WO-104**, because `day_summary` is the
morning brief (`src/shared/aiFeatures.ts:14`) and this work order's own Out of
Scope excludes "Wrapped and Proactive Brief prompt composition". Verified landed:
`generateDaySummary` composes `voiceDirective(voice)` and its cache key carries
the voice, asserted in `tests/toneAcrossSurfaces.test.ts`. The fix exists; only
its work-order home differs from the briefing.

### Tests

```
tests/agentVoiceContract.test.ts        9 pass   (new)
tests/contextPacketInspection.test.ts   9 pass   (untouched — builds the prompt with no tone)
tests/chatAgentStreaming.test.ts        5 pass   (untouched)
tests/toneAcrossSurfaces.test.ts        9 pass
tests/activityDescriptionPolicy.test.ts 18 pass
```

`npm run typecheck` clean.

### Exploratory pass

**Not run.** The check is: ask the agent the same question under two tones and
compare the answers. It needs a configured provider, the owner's real activity
database, and two live turns, and the repository is public so the answers could
not be recorded here. The hermetic tests prove the tone and the policy reach the
prompt; what stays unverified by this lane is the model's response to them.
Flagged for the final reviewer.
