<!--lint disable no-undefined-references strong-marker-->

# Implementation Plan: WO-18

**Work Order:** WO-18 — [backend] Restrict work-memory context to confirmed facts
**Created At (UTC):** 2026-08-11T09:19:50Z

## Summary

Drafted (evidence-derived, unconfirmed) work-memory facts currently leak into
the AI context — the prompt block, the chat memory block, and the context
packet — sitting alongside confirmed facts under the label "awaiting
confirmation". This work order stops that leak by giving the profile readers a
confirmed-only mode and wiring every AI-context consumer to it. It also closes
two gaps that let a rejected or forgotten fact return through the evidence-draft
path: `rebuildWorkMemory` does not consult `memory_proposal_rejections`, and
`draftFactsFromEvidence` can throw when capture tables have not been created
yet. No schema change, no migration — all changes are in the work-memory service
layer and its AI-context consumers.

## Code Reuse And Package Structure

Reused:

- `findMemoryProposalRejection` in `suppliedMemory.ts` — already normalizes
  the statement key and checks the `memory_proposal_rejections` table with a
  table-existence guard. Imported by `workMemoryProfile.ts` for the
  AC-SM-012.3 guard.
- The `tableExists` helper in `workMemoryProfile.ts` — already used by
  `ready(db)` and the supplied-memory path. Reused for the AC-SM-012.4 evidence
  source guard.
- `readFactsForScope`'s existing structure — drafted and supplied arrays are
  already separated; the confirmed-only filter is a one-line conditional.
- `proposeUnstoredMemoryFact` — already proposes unstored drafts; unchanged,
  since stored drafts are the proposal surface for the manage-memory view.

Modified:

- `src/main/services/workMemoryProfile.ts` — `confirmedOnly` parameter on
  `readFactsForScope`, `getWorkMemoryProfile`, `getClientMemory`,
  `getScopedMemoryProfile`; confirmed-only reads in `workMemoryPromptBlock` and
  `clientMemoryPromptBlock`; rejection guard and evidence-source guard in
  `draftFactsFromEvidence`.
- `src/main/services/contextPacket.ts` — `correctedFactItems` reads the
  scoped profile in confirmed-only mode.
- `tests/workMemoryProfile.test.ts` — new tests for the confirmed-only
  boundary.

Created:

- `tests/workMemoryConfirmedContext.test.ts` — focused tests for AC-SM-012.1,
  .3, and .4.

## Components And Flow

### Confirmed-only reads

`WorkMemoryFact.origin` is `'drafted'` (evidence-derived, pending
confirmation) or `'user'` (explicitly entered or promoted to supplied). A
second `supplied` boolean marks facts that live in the supplied-memory store.
Confirmed-only means: origin is `'user'` — which covers both hand-entered rows
in `work_memory_facts` and supplied-memory facts.

Call flow for AI context (the paths that change):

1. `workMemoryPromptBlock(db)` → `getWorkMemoryProfile(db, confirmedOnly=true)`
   → `readFactsForScope(db, 'general', confirmedOnly=true)` → filtered `facts`
   array. Used by `aiService.ts` `buildDaylensMemoryPromptBlock` and
   `chatMemoryPromptBlock`.
2. `clientMemoryPromptBlock(db, clientId, clientName)` →
   `getClientMemory(db, clientId, confirmedOnly=true)` → same filter.
   Used by `scopedMemoryPromptBlock` → `chatMemoryPromptBlock`.
3. `contextPacket.ts` `correctedFactItems(db, question)` →
   `getScopedMemoryProfile(db, confirmedOnly=true)` → only confirmed facts
   pushed as `corrected_fact` items.

Call flow for the manage-memory view (unchanged):

1. IPC `GET_WORK_MEMORY_PROFILE` → `getWorkMemoryProfile(db)` (default
   `confirmedOnly=false`) — shows both drafts and confirmed.
2. IPC `GET_SCOPED_MEMORY_PROFILE` → `getScopedMemoryProfile(db)` (default
   `confirmedOnly=false`) — drafts appear as proposals awaiting confirmation.
3. `rebuildWorkMemory(db)` → returns `getWorkMemoryProfile(db).facts` (default
   `confirmedOnly=false`) — the rebuild result shows what the profile now
   contains, including new proposals.

### Rejection guard (AC-SM-012.3)

`draftFactsFromEvidence` now calls `findMemoryProposalRejection(db,
draft.text)` for each draft. A match means the person previously declined that
statement (in chat) — skip it, the same way `tombstonedTopics` skips a
forgotten topic. The `rebuildWorkMemory` loop gains the same check, so a
rejected draft is not re-inserted into `work_memory_facts` on rebuild.

### Evidence-source guard (AC-SM-012.4)

`draftFactsFromEvidence` checks `tableExists(db, 'app_sessions')` before the
app query (returns empty, so no top-apps fact) and
`tableExists(db, 'website_visits')` before calling
`getReconciledDomainIntervals` (returns empty, so no background fact). The
function never throws on a pre-capture database.

## Steps

1. **Thread `confirmedOnly` through the profile readers** — `workMemoryProfile.ts`.
   `readFactsForScope(db, scope, confirmedOnly=false)` skips the drafted
   array when the flag is set. `getWorkMemoryProfile`, `getClientMemory`, and
   `getScopedMemoryProfile` pass it through with default `false`.

2. **Switch AI-context callers to confirmed-only** — `workMemoryProfile.ts`
   + `contextPacket.ts`. `workMemoryPromptBlock` calls
   `getWorkMemoryProfile(db, true)`; `clientMemoryPromptBlock` calls
   `getClientMemory(db, clientId, true)`; `correctedFactItems` calls
   `getScopedMemoryProfile(db, true)`.

3. **Add the rejection guard to the evidence draft** — `workMemoryProfile.ts`.
   Import `findMemoryProposalRejection`; skip drafts whose text matches a
   stored rejection, both in `draftFactsFromEvidence` and in the
   `rebuildWorkMemory` loop.

4. **Add the evidence-source availability guard** — `workMemoryProfile.ts`.
   Guard the `app_sessions` and `website_visits` arms in
   `draftFactsFromEvidence` with `tableExists` checks.

5. **Write tests** — `tests/workMemoryProfile.test.ts` (extend) and
   `tests/workMemoryConfirmedContext.test.ts` (new).

## Testing

New file `tests/workMemoryConfirmedContext.test.ts` covers:

- A draft fact (from evidence) does NOT appear in `workMemoryPromptBlock` or
  `chatMemoryPromptBlock`, but a hand-added / supplied fact does.
- A draft fact does NOT appear in `contextPacket` `corrected_fact` items.
- A draft fact DOES still appear in `getWorkMemoryProfile` (manage-memory view
  keeps drafts as proposals).
- A rejected proposal (recorded via `recordMemoryProposalRejection`) is not
  re-drafted by `rebuildWorkMemory` on a subsequent run.
- `draftFactsFromEvidence`/`rebuildWorkMemory` does not throw when
  `app_sessions` and/or `website_visits` tables do not exist.

Extended `tests/workMemoryProfile.test.ts`:

- Existing test `'the prompt block carries the profile…'` is updated to assert
   a drafted fact is absent from `workMemoryPromptBlock` while a supplied fact
   is present.

Commands:

```bash
npm run typecheck && npm run lint
node scripts/run-tests.mjs workMemoryProfile workMemoryConfirmedContext contextPacket
```
