<!--lint disable no-undefined-references strong-marker-->

# Implementation Plan: WO-106

**Work Order:** WO-106 — [backend] Replace telemetry-based time-chunk wording with policy-compliant descriptions
**Created At (UTC):** 2026-08-11T08:32:45Z

## Summary

Rewrite deterministic time-chunk row wording so each cell describes understood activity first, trails apps as attribution, rejects raw telemetry titles, preserves capture gaps without judging the person, and keeps a user-authored covering label verbatim.

## Code Reuse And Package Structure

- Reuse `naturalizeLabel`, `rawLabelForm`, and the covering `userVisibleBlockLabel` already supplied by `daylensTools`.
- Modify only `src/main/agent/timeChunkAnswer.ts` and `tests/timeChunkAnswer.test.ts`.
- No schema, no migration, range 85-89 untouched.

## Components And Flow

1. Gap row → `gapDescription` from `gap.kind` / label (asleep, locked, untracked, quiet). Never "idle" or "away".
2. Activity row → covering block label if present; else describable window/page titles; apps trail in parentheses.
3. No describable subject → one uncertainty sentence naming the open apps and the limit.

## Steps

1. Rewrite `rowDescription` under the shared policy.
2. Reject raw forms on the original title before naturalize.
3. Trust finalized block labels (AC-VIC-004).
4. Update `tests/timeChunkAnswer.test.ts` for the new shapes.

## Testing

```bash
node scripts/run-tests.mjs tests/timeChunkAnswer.test.ts
npm run typecheck && npm run lint
```
