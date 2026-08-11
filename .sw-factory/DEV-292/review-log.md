<!--lint disable strong-marker-->

# Review Log: DEV-292

**Work Order:** DEV-292 — Make the day recap good: an iteration tool over real days, and a budget that lets it finish
**Initialized At (UTC):** 2026-08-11T06:08:40Z

This file records review and verification rounds. Append new rounds; do not overwrite prior rounds.

Review delegation was not used. This session prohibits spawning subagents, so the
dimensions below were run directly rather than by a review delegate.

---

## Round 1

Scope: the DEV-292 commits on `factory/v2-ship` — `48d61aba`, `8d280fd5`,
`a8770ad4`, `3eaf6328`, `07f24b14`, `28262c39`. Twelve files across
`src/main/ai`, `src/main/jobs`, `src/main/lib`, `src/main/services`,
`src/renderer`, `src/shared`, and `tests`.

### Requirements Alignment

Graded against `## Acceptance` in `docs/specs/day-recap-and-analysis.md`.

**Blocking:**

- None in code.

**Advisory:**

- Acceptance line "the voice and grounding evals fail the old shapes and pass the
  new ones" is half met. The voice eval exists and passes
  (`tests/recapVoice.test.ts`, and `recapVoiceFindings` now runs over every
  variant in the lab). There is no grounding eval for the recap:
  `tests/journal-eval` scores block labels, block narratives, and the wrapped
  narrative read from `wrapped_narratives`, and the recap is not among its
  subjects — it has no stored artifact to read, because recap persistence is
  explicitly out of this work order's scope. Closing this line is work order
  story 8, and it needs the owner to approve a variant first. Surfaced to the
  owner rather than decided here, per `review-phase.md`.
- Acceptance line "its total matches the timeline" has no check, automated or in
  the lab. The lab prints the day's evidence and each variant's prose, so a
  person can compare claims line by line, but no total is asserted anywhere. A
  recap that misstates the day's total would pass every gate currently in place.

### Blueprint Alignment

**Skipped:** yes — no blueprint documents exist for this surface. Architecture was
checked against `docs/codebase/architecture.md` and the code. See `context.md`.

### Architecture And Conventions

**Blocking:**

- None.

**Advisory:**

- The comment justifying `day_summary.timeoutMs` records "24-52s through the API,
  33-77s through the Claude CLI". Re-measured 2026-08-11 against a 13-block day,
  every variant finished in 7.0-13.4s. The 150s budget clears that with wide
  room, so the number needs no change, but the comment's measurements are not
  reproducible on the current provider path and future latency reasoning would
  start from them. The work order's own Further Notes warn about exactly this
  failure — reasoning from a stale premise recorded in a comment.
- `JOB_DEFINITIONS.day_summary` declares `modelStrategy: 'balanced'`, which model
  selection ignores; it returns the single user-chosen model for every job. The
  work order records this as out of scope and it stays out, but the declaration
  reads as behavior that does not happen. Worth its own issue.
- Two variant names are easy to confuse: the variant with `id: 'shipped'` is the
  original baseline prompt, while the variant actually shipped is
  `id: 'colleague'` (`SHIPPED_RECAP_VARIANT_ID`). The lab prints
  "[3/4] colleague (currently shipped)" directly under "[1/4] shipped".
  Renaming the baseline to `baseline` would remove the ambiguity.

### Tests And Build

**Commands run:**

```bash
npm run typecheck                                                   # pass
npm run lint                                                        # pass
node scripts/run-tests.mjs recapContract recapVoice settingsDefaults # 25 pass, 0 fail
npm run lab:recap 2026-08-10                                        # 4/4 variants completed
```

**Blocking:**

- None.

**Advisory:**

- None. `tests/recapContract.test.ts` covers each contract case the work order's
  Testing Decisions section names, including the two that no other test would
  notice: that a timeout belt exists at all, and that it reads the budget from the
  job definition rather than repeating a literal.

### User-Facing Verification

**Skipped:** no

**Evidence:** `npm run lab:recap 2026-08-10` against a read-only copy of the real
database. 2026-08-10 carries 13 timeline blocks — a heavy, fully-enriched day, the
case work order story 11 names.

- All four variants completed. None fell back.
- Latency: 13.4s (`shipped` baseline), 11.0s (`evidence-first`), 7.87s
  (`colleague`, currently shipped), 7.03s (`terse`).
- `recapVoiceFindings` reported clean for all four — no internal vocabulary, no
  stat-dump shapes, no productivity judgements.
- Each variant named the day's real work and accounted for its leisure stretches
  without naming an adult site.
- Result written to `.recap-lab/2026-08-10-2026-08-11T06-11-13-736Z.json`
  (gitignored; it contains real personal activity and must not enter the
  repository).

This closes story 10 ("Generate recap actually produces a recap") and story 11
("the recap finishes on a heavy, fully-enriched day") against a real day. The
15s budget that produced "Day summary timed out" is below the 13.4s baseline
measurement, which is consistent with the reported failure.

Not verified: the recap rendered in the running application's Timeline panel.
The lab renders a panel mock to the terminal, not the real renderer. Grading the
`docs/acceptance/` line for this surface to `passing` requires clicking Generate
recap in the app.

**Blocking:**

- None.

**Advisory:**

- See the missing total check under Requirements Alignment.

### Security, Privacy, And Data Safety

**Skipped:** no

**Blocking:**

- None.

**Advisory:**

- The lab reads a read-only copy of the real database and never writes to it
  (`stageReadOnlyCopyOfRealDb`, `query_only = ON`), satisfying story 9. Its
  output under `.recap-lab/` contains real personal activity and is gitignored at
  `.gitignore:24`. Confirmed no real day content is quoted in this log or in any
  committed file from this work order.
- `degradedRecapReason` strips the `⟦dlerr:{…}⟧` sentinel before the reason
  reaches the panel, so internal error codes do not surface to the person, and
  the test asserts both the sentinel and its brackets are absent.

### Round 1 Verdict

- Total blocking: 0
- Total advisory: 6
- Files reviewed: 12
- **Verdict:** APPROVED

Approved for handoff to In Review. One acceptance line
("grounding evals") remains open and is blocked on the owner approving a recap
variant; it is not a defect in what landed. Recorded in `checklist.md` as the
single open item.
