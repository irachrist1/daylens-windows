<!--lint disable strong-marker-->

# Review Log: WO-18

**Work Order:** WO-18 — [backend] Restrict work-memory context to confirmed facts
**Initialized At (UTC):** 2026-08-11T09:19:50Z

This file records review and verification rounds. Append new rounds; do not overwrite prior rounds.

---

## Round 1

### Requirements Alignment

Four acceptance criteria from REQ-SM-012 were implemented:

- **AC-SM-012.1 (confirmed-only AI context):** ✅ Satisfied. `readFactsForScope`, `getWorkMemoryProfile`, `getClientMemory`, and `getScopedMemoryProfile` gained a `confirmedOnly` parameter (default `false`). All AI-context consumers — `workMemoryPromptBlock`, `clientMemoryPromptBlock`, `chatMemoryPromptBlock`, and `correctedFactItems` in `contextPacket.ts` — now call with `confirmedOnly=true`. The filter excludes `origin='drafted'` rows from `work_memory_facts` while preserving `origin='user'` rows (pre-DEV-185 hand-added facts) and all supplied-memory facts. The manage-memory view paths (`getWorkMemoryProfile()`, `getScopedMemoryProfile()` defaults) remain draft-inclusive.

- **AC-SM-012.3 (reject re-drafting of rejected proposals):** ✅ Satisfied. `draftFactsFromEvidence` filters each draft through `findMemoryProposalRejection` before returning. `rebuildWorkMemory` additionally tombstones stored `origin='drafted'` rows whose text matches a rejection, so the draft is deleted from `work_memory_facts` and its `topic_key` enters the tombstoned set — preventing re-drafting on subsequent rebuilds.

- **AC-SM-012.4 (guard against missing evidence tables):** ✅ Satisfied. `draftFactsFromEvidence` checks `tableExists(db, 'app_sessions')` before querying (returns empty if absent) and `tableExists(db, 'website_visits')` before calling `getReconciledDomainIntervals` (skips background-draft generation if absent).

- **AC-SM-012.2 (context packet records corrected facts with evidence, sensitivity, conflicts, gaps, permissions, per-item identity/version/source-type/reason):** Pre-existing — covered by DEV-181 work, not in scope for WO-18.

**Blocking:** None.

**Advisory:** None.

### Blueprint Alignment

The Search & Memory blueprint (`memory-and-entities.md`) defines confirmed-only context as required: drafts are proposals shown in the Manage-memory view, not AI context. All four code changes align with §Conversational memory (confirmed facts ride prompt blocks) and §Memory record (drafted facts are inferred, never disclosed as context). No blueprint drift.

**Blocking:** None.

**Advisory:** None.

### Architecture And Conventions

All changes are confined to `src/main/services/workMemoryProfile.ts` and `src/main/services/contextPacket.ts` — the work-memory service layer and its AI-context consumer. No schema changes, no migrations. The `confirmedOnly` parameter defaults to `false`, preserving all existing manage-memory behaviour without call-site changes. The `tableExists` and `findMemoryProposalRejection` helpers were already present in the codebase (DEV-185 migration) and are reused rather than reimplemented.

**Blocking:** None.

**Advisory:** None.

### Tests And Build

**Commands run:**

```bash
npx tsc --noEmit                          # clean
npx eslint src/main/services/workMemoryProfile.ts \
            src/main/services/contextPacket.ts \
            tests/workMemoryProfile.test.ts \
            tests/workMemoryConfirmedContext.test.ts                      # clean
npx prettier --check <modified files>     # clean
node scripts/run-tests.mjs workMemoryProfile.test \
                        workMemoryConfirmedContext.test \
                        agentOnContextPacket.test \
                        memoryProposalTool.test \
                        canonicalExactBoundary.test
```

**Results:** 43 pass · 0 fail across 5 test files.

**Blocking:** None.

**Advisory:** None.

### User-Facing Verification

Manual review of the code paths: `workMemoryPromptBlock` (used by `aiService.ts` `buildDaylensMemoryPromptBlock`), `clientMemoryPromptBlock` (used by `scopedMemoryPromptBlock`), and `correctedFactItems` (used by `buildContextPacket`) all now pass `confirmedOnly=true`. No drafted fact text can reach an AI surface.

**Skipped:** _no — code-path walkthrough completed_

**Evidence:** `workMemoryConfirmedContext.test.ts` pins each surface: prompt block, chat memory block, scoped memory profile, and context-packet corrected_fact items.

**Blocking:** None.

**Advisory:** None.

### Security, Privacy, And Data Safety

No security or privacy concerns. Drafted facts are evidence-derived summaries, not sensitive data — excluding them from AI context is a privacy improvement (less data leaves the device in prompt blocks). The `tableExists` guards prevent crashes that could leave a database in an inconsistent state. No new data flows, no new IPC surfaces.

**Blocking:** None.

**Advisory:** None.

### Known Pre-Existing Issue (out of scope)

The `contextPacket.test.ts` fixture `two-client-day` has one failing test: "packet retrieval for 'beacon' must not return 'acme'". This failure originates in the WO-12 changes to `memoryIndex.ts` (`pageRecords` groups both acme and beacon visits under the shared `github.com` domain into one record whose text contains both client names). It is **not** caused by WO-18 changes — reverting all WO-18 files to HEAD while keeping only the WO-12 changes reproduces the same failure. The WO-18 `correctedFactItems` change (confirmed-only read) does not affect `search_exact` or `search_semantic` items.

**Blocking:** None (WO-18 scope).

### Round 1 Verdict

- Total blocking: 0
- Total advisory: 0
- Files reviewed: `src/main/services/workMemoryProfile.ts`, `src/main/services/contextPacket.ts`, `tests/workMemoryProfile.test.ts`, `tests/workMemoryConfirmedContext.test.ts`
- **Verdict:** APPROVED

---

<!-- Subsequent rounds: copy the structure above and increment the round number. -->
