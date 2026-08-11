<!--lint disable strong-marker-->

# Review Log: WO-34

**Work Order:** WO-34 — [backend] Move attribution reads to the entity-graph boundary
**Initialized At (UTC):** 2026-08-11T08:25:36Z

This file records review and verification rounds. Append new rounds; do not overwrite prior rounds.

---

## Round 1

Scope: `src/main/core/query/attributionResolvers.ts`,
`tests/attributionEntityBoundary.test.ts`, `.sw-factory/WO-34/*` on
`wave/2-entities`. Review delegate: [WO-34 review](8753f072-3f59-44e3-95e4-8196183975a8).

### Requirements Alignment

- **AC-SM-EA-002.5** — met. `resolveClientByLabel` / `resolveProjectByLabel`
  return candidates with `client`/`project` null when more than one survivor
  matches. `findClientByName` / `findProjectByName` no longer use
  `LIKE … LIMIT 1`.
- **AC-SM-EA-004.1** — met on the read path. Session payloads still carry
  attribution status, confidence, and up to ten evidence rows.
- **AC-SM-EA-004.4** — met. Ambiguous labels do not invent a certain entity.

**Blocking:** none.

### Blueprint Alignment

Entities & Attribution still states that `#AttributionResolvers` “does not use
the entity repository as its query boundary.” That sentence is now stale:
identity and aliases resolve through `#EntityRepository`; activity totals still
come from work sessions. Discrepancy recorded; Factory documents are not edited
in this sprint.

**Blocking:** none.
**Advisory:** update blueprint prose in a later factory pass.

### Architecture And Conventions

Matches surrounding resolver style. `aiTools` still consumes the thin
`find*ByName` wrappers (null on ambiguity) and does not yet surface candidates —
out of this lane; noted as follow-up for the agent tool layer.

### Tests And Build Health

```
npm run typecheck  # pass
npm run lint       # 0 errors
node scripts/run-tests.mjs tests/attributionEntityBoundary.test.ts
  # 5 pass
node scripts/run-tests.mjs tests/entityRepository.test.ts tests/evidenceBackedQuery.test.ts
  # 11 pass
```

### User-Facing Verification

Backend identity boundary only. DEV-246 reproduction is encoded as the
ambiguous-alias fixture (would previously bind the wrong client's minutes).
No UI surface in this WO; exploratory UI pass [SKIP] — no renderer change.

### Security, Privacy, And Data Safety

No new secrets, no PII in fixtures, no migrations.

### Verdict

**APPROVED**
