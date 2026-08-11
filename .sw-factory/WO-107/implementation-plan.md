<!--lint disable no-undefined-references strong-marker-->

# Implementation Plan: WO-107

**Work Order:** WO-107 — [backend] Expand cross-surface policy tests
**Created At (UTC):** 2026-08-11T08:32:45Z

## Summary

Add one cross-surface test file that names every activity-description consumer and asserts REQ-VIC-001 through REQ-VIC-004 against the code WO-99 through WO-106 landed. No production changes.

## Code Reuse And Package Structure

Reuses the evaluators and helpers from `activityDescription.ts`, `labelVoice.ts`, `summaryVoice.ts`, `timeChunkAnswer.ts`, and `systemPrompt.ts`. Creates `tests/crossSurfacePolicy.test.ts` only.

## Steps

1. Enumerate every policy consumer path and assert each is wired.
2. Assert one-policy identity (plumbing lists, recapVoiceFindings alias).
3. Assert tone parity across agent / brief / Wrapped.
4. Assert uncertainty, no-judgment, evidence ownership, and user-label precedence including the time-chunk surface.

## Testing

```bash
node scripts/run-tests.mjs tests/crossSurfacePolicy.test.ts
npm run typecheck && npm run lint
```
