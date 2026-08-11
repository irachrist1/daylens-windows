<!--lint disable strong-marker-->

# Review Log: WO-99

**Work Order:** WO-99 — [backend] Define the common interpretation and activity-description contract
**Initialized At (UTC):** 2026-08-11T08:32:45Z

This file records review and verification rounds. Append new rounds; do not overwrite prior rounds.

---

## Round 1 — 2026-08-11, in-session review of the landed implementation

**Verdict: APPROVED.**

**Method.** No review subagent was spawned: this session runs under a harness
policy that forbids spawning agents unless the person asks, and they did not.
The round was run in-session instead — code reading of the three changed files
against the two blueprints, plus the test evidence below. Stating the method
because `execution/review-phase.md` assumes a subagent and this round did not use
one.

### What landed

- `src/shared/activityDescription.ts` (new, 470 lines) — the one policy:
  vocabulary, the `SupportedInterpretation` contract, nine named rules, the
  evaluator, the uncertainty producer, the evidence-ownership assertion, and the
  prompt directives.
- `src/shared/labelVoice.ts` — `PLUMBING_TERMS`, `HYPE_TERMS`, and `JUDGMENT_RE`
  become imports; the prose check moves out.
- `src/main/ai/voiceContract.ts` — `BANNED_VOCAB`, `PLUMBING_VOCAB`,
  `findBannedVocab`, `findPlumbingVocab`, `containsEmDash` become re-exports of
  the shared policy. 122 lines to 94.
- `tests/activityDescriptionPolicy.test.ts` (new, 18 tests).

### Acceptance criteria

| Criterion | Verdict | Evidence |
| --- | --- | --- |
| AC-VIC-001.1 | Met | One definition site. `PLUMBING_VOCAB === PROSE_PLUMBING_VOCAB` and `recapVoiceFindings === activityDescriptionFindings` are asserted by identity, so a second copy cannot reappear without failing a test. |
| AC-VIC-001.2 | Met as a primitive | `no-unsupported-detail` fails a named client the interpretation does not carry and passes it once supported. Not yet *applied* at any surface; that is WO-102 and WO-104 through WO-106. |
| AC-VIC-001.3 | Met as a primitive | `activity-before-telemetry` fails a description opening on an app name, passes tail attribution. |
| AC-VIC-001.4 | Met as a primitive | All seven banned forms fail their own rule with the fragment named. |
| AC-VIC-003.1 | Met as a primitive | `uncertaintyStatement` returns exactly one sentence or null; the one-sentence property is asserted by counting periods, including the two-limit case. |
| AC-VIC-003.2 | Met | The uncertainty sentence is checked against `JUDGMENT_RE` itself, not a copy. |
| AC-VIC-003.3 | Met as a primitive | `assertEvidenceOwned` rejects an unrecorded duration, URL, and file, and accepts each when recorded. |

"Met as a primitive" is the honest grading: this work order's Out of Scope
excludes every consumer, so the criteria are executable here and not yet enforced
anywhere a person can see. Nothing above should be read as "the product now does
this".

### Two defects found and fixed during implementation

Both were mine, found by the new tests before anything shipped, and both are the
kind of thing that would have produced false accusations against honest prose:

- **Compound durations were scanned as two facts.** `DURATION_SHAPE_RE` matched
  "1h" and "24m" separately, so a description quoting the recorded "1h 24m" was
  rejected for stating a duration the evidence did not record. The pattern now
  takes a compound run in one bite.
- **A domain was reported as a file.** "docs.example.dev" fits both the URL and
  the filename shape, so a supported URL failed the file check. The URL scan now
  consumes its matches before the file scan reads the text.

### Behaviour changes, deliberate

**The recap prose scan widened.** `recapVoiceFindings` previously scanned the
label-scoped plumbing list (8 terms). It now scans the union of the label and
prose lists (14 terms), so a recap saying "page-level detail" or "the data shows"
is now flagged where it was not before. This is the correct direction — those
phrases are the pipeline talking, and a recap is exactly where they must not
appear — but it is a widening, not a refactor, and downstream evals that score
recap voice (`tests/recap-lab/run.ts`, `tests/journal-eval/score.ts`) may report
findings on text they previously passed. Both are offline harnesses, neither
gates the suite.

Everything else is behaviour-preserving by construction, and
`tests/voiceContract.test.ts` is the proof: it asserts the exact 21-entry banned
list through the `voiceContract.ts` import and was not touched.

### F1 — recorded limit, no action. `no-unsupported-detail` needs candidates

The rule can only judge names it is handed in `candidateDetails`. It does not
extract proper nouns from prose, and it should not: a heuristic noun extractor
would accuse ordinary sentences, and a false rejection of an honest description
is worse than a miss. The consequence is that AC-VIC-001.2 is enforced only
where a caller knows which names are at risk. Recorded rather than chased.

### F2 — recorded limit, no action. `evidence-owned-facts` is opt-in

The rule reports passed when the interpretation carries no `facts` block, on the
reasoning that an interpretation making no claim about what was recorded has
nothing to contradict. A caller that wants AC-VIC-003.3 enforced must populate
`facts`. This is a deliberate default: the alternative is that every
interpretation built without facts rejects every duration in every description.

### Blueprint alignment

**Aligned.** The governing blueprint's ADR-002 ("Separate interpretation from
expression") is the shape of the module: nothing in `activityDescription.ts`
reads, imports, or mentions `SummaryVoice`, and `summaryVoice.ts` is untouched by
this work order.

**Discrepancy 1 — the code violated ADR-002 of Voice & Label Policy, and now
does not.** That ADR says label evaluation lives in `labelVoice.ts` and
generated-answer directives in `voiceContract.ts`. `recapVoiceFindings` is prose
evaluation and lived in `labelVoice.ts`, re-scanning the label lists rather than
the ones `voiceContract.ts` already exported. This work order moves the
implementation out and leaves a named re-export. The ADR's text is still accurate
as an intent; the codebase now matches it. No Factory document was edited.

**Discrepancy 2 — the governing blueprint's Key Contracts understate the
starting state.** It says the current implementation "enforces the label policy
during Timeline block finalization and applies the selected summary voice to
Wrapped prompts", which reads as though only the shared-interpretation path was
missing. In fact the executable policy existed in three places with two
divergent plumbing lists, and no uncertainty producer or provenance type existed
at all. The blueprint's own Key Contract that "recorded durations, identities,
URLs, files, and events remain evidence-owned facts" had no representation in
the codebase whatsoever. Recorded here; the blueprint was not edited.

### Tests

```
tests/activityDescriptionPolicy.test.ts   18 pass
tests/labelVoice.test.ts                  18 pass   (untouched — no label drift)
tests/voiceContract.test.ts                7 pass   (untouched — no vocabulary drift)
tests/recapVoice.test.ts                   4 pass   (untouched — prose check behaves the same)
tests/voicePromptCoverage.test.ts          2 pass
tests/labelVoiceEnforcement.test.ts        4 pass
```

`npm run typecheck` clean. `npm run lint` 0 errors, 128 warnings, unchanged from
the pre-change baseline.

**Suite baseline note.** The stated full-suite baseline is 2197 pass / 0 fail.
This worktree's first full run reported 2186 pass / 7 fail. Six of the seven were
`tests/captureHelperNeverGuess.test.ts` failing on `missing helper binary at
build/capture-helper` — a fresh worktree has no built native helper. After
`npm run build:capture-helper` that file is 6 pass. The seventh,
`tests/ipcContract.test.ts`, passed on isolated re-run and is a parallel-load
artifact. Neither touches voice.

### Exploratory pass

`[SKIP]` for this work order, with a reason rather than a checkbox: WO-99 changes
no user-visible surface. Every consumer is explicitly out of its scope, so there
is nothing to open and look at. The exploratory obligation transfers to WO-104
through WO-106, where the policy reaches a screen.
