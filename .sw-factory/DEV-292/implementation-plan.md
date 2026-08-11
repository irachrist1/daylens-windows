<!--lint disable no-undefined-references strong-marker-->

# Implementation Plan: DEV-292

**Work Order:** DEV-292 — Make the day recap good: an iteration tool over real days, and a budget that lets it finish
**Created At (UTC):** 2026-08-11T06:08:40Z

## Summary

The recap never arrived: a 15s budget expired mid-call on real days and the panel
served the deterministic factual fallback. This delivers a developer tool that
generates several named recap variants for a real day side by side with the day's
evidence, latency, and voice findings; and a job budget set from what that tool
measured. Dead suggestion generation is removed from the prompt, the response
contract, and the result type.

This plan records the implementation that landed. The work was implemented across
six commits before this execution directory existed; the directory was
initialized during the verification and handoff pass, and the plan is written to
match the code in the tree rather than to propose it.

## Code Reuse And Package Structure

Reused rather than rebuilt:

- `tests/ai-behaviour/realDb.ts` — `stageReadOnlyCopyOfRealDb` / `cleanupRealDbCopy`.
  The lab works on a copy, so experimenting cannot corrupt a real day (story 9).
- `src/shared/labelVoice.ts` — `recapVoiceFindings`, the existing prose-quality
  check. Moved from shelf to use; its behavior is unchanged, only its call sites
  grew (story 6).
- The behavioural harness shape: run under Electron with the real loader, render
  to the terminal with the existing ANSI conventions, write a result file for
  diffing between runs.

Created or modified:

- `src/main/ai/recapVariants.ts` (new) — declarative named variants: `id`,
  `description`, `directives`, `userMessage`, plus `SHIPPED_RECAP_VARIANT_ID`.
- `tests/recap-lab/run.ts` (new) — the tool.
- `src/main/lib/daySummaryParse.ts` (new) — `parseDaySummaryResultText`, the
  response contract, tolerant of plain prose and of a truncated JSON reply.
- `src/main/lib/daySummarySuggestions.ts` (deleted, 153 lines) — the suggestion
  generation nothing rendered.
- `src/main/services/aiOrchestration.ts` — the `day_summary` budget.
- `src/main/jobs/aiService.ts` — `generateDaySummary`, `degradedRecapReason`.
- `src/shared/types.ts` — `questionSuggestions` off the result type; degraded
  fields on.
- `src/main/services/settings.ts`, `src/renderer/components/ConnectAI.tsx` —
  connecting a provider moves every surface, chat included.
- `tests/recapContract.test.ts` (new), `tests/settingsDefaults.test.ts`.

## Components And Flow

`JOB_DEFINITIONS.day_summary` in `aiOrchestration.ts` is the single place the
recap's budget is expressed. `jobTimeoutMs('day_summary')` reads it.

`generateDaySummary` in `aiService.ts` builds the system prompt from the shipped
variant's directives plus the memory block and profile directive, builds the user
message from `buildDaySummaryScaffold(payload)`, and calls `executeTextAIJob`
inside `withTimeout(..., jobTimeoutMs('day_summary'))`. On success
`parseDaySummaryResult` yields `{ summary }` and nothing else. On failure or
timeout, `degradedRecapReason(error)` converts a provider error into a punctuated
sentence with the internal error sentinel stripped, and the factual fallback is
returned marked degraded.

The lab stages a read-only copy of the real database, loads the day, prints the
day's blocks and named evidence, then runs every variant against the same day and
the same model, recording elapsed milliseconds and `recapVoiceFindings` per
variant, and writes a JSON result file under `.recap-lab/`.

### Accepted drift

The work order says the call site's timeout wrapper "is removed so the job
definition is the single place a recap's budget is expressed." The wrapper is
retained, because `executeTextAIJob` does not enforce a job's declared
`timeoutMs` — removing the belt would leave the recap able to hang forever while
the definitions table still read as bounded. The intent of the instruction is
met: the duplicated 15s *literal* is gone and the belt reads
`jobTimeoutMs('day_summary')`. `tests/recapContract.test.ts` asserts both that a
belt exists and that it reads the budget from the definition rather than
repeating a literal.

## Steps

1. **Declare the variants** — `src/main/ai/recapVariants.ts`, four named
   candidates: `shipped`, `evidence-first`, `colleague`, `terse`.
2. **Build the lab** — `tests/recap-lab/run.ts`, registered as `npm run lab:recap`.
3. **Cut the dead suggestion path** — delete `daySummarySuggestions.ts`, drop
   `questionSuggestions` from the prompt, the parse path, and the result type.
4. **Set the budget from measurement** — `day_summary.timeoutMs` to an
   env-overridable constant, with the measurement recorded in a comment; collapse
   the call site's duplicate literal onto `jobTimeoutMs`.
5. **Make failure honest** — `degradedRecapReason` strips the `⟦dlerr:…⟧`
   sentinel, punctuates the sentence, and distinguishes a wall the person must
   clear from a transient failure worth retrying.
6. **Carry the one naming rule** — every variant accounts for adult browsing time
   without naming the site, and extends that rule to nothing else.
7. **Ship a variant** — `SHIPPED_RECAP_VARIANT_ID = 'colleague'`.

## Testing

`tests/recapContract.test.ts` (14 tests) covers the contract around the prose:
the budget clears the measured floor; a belt exists and reads the budget from the
definition; the recap gets more room than the wrapped narrative; a result carries
only `summary`; plain prose and truncated JSON still yield a recap; an unusable
reply yields `null` so the caller degrades honestly; a provider failure reaches
the panel as a sentence with no sentinel; a hard wall is not dressed up as
retryable; every variant is shippable, carries the naming rule, and asks for no
output nothing renders.

`tests/recapVoice.test.ts` (4) covers the prose-quality check, unchanged.
`tests/settingsDefaults.test.ts` (7) covers provider connection reaching chat.

Commands:

```bash
node scripts/run-tests.mjs recapContract recapVoice settingsDefaults
npm run lab:recap 2026-08-10
```

The lab is not unit-tested: it is a developer instrument whose output a person
reads, and its one shared piece — read-only database staging — is existing code.

Quality is not asserted here. The durable regression net for quality is the eval
family gold example, which requires the owner to approve a variant first.
