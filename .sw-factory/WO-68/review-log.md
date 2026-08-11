<!--lint disable strong-marker-->

# Review Log: WO-68

**Work Order:** WO-68 — [data] Add Context Packet and disclosure-record storage
**Initialized At (UTC):** 2026-08-11T09:00:38Z

This file records review and verification rounds. Append new rounds; do not overwrite prior rounds.

---

## Round 1

Scope: the uncommitted WO-68 diff in `src/main/db/migrations.ts`,
`src/main/services/contextPacket.ts`, and `.sw-factory/WO-68/*`. Review
delegation was declined earlier for this lane, so every dimension was reviewed
directly.

### Requirements Alignment

**Blocking:**

- None.

**Advisory:**

- `deleteContextPacketsForThread` now removes every packet and file disclosure
  owned by a thread, but the actual thread lifecycle owner is
  `src/main/services/artifacts.ts`, which is outside this lane. Its owner must
  call the interface for thread deletion to apply the storage guarantee.
- The established missing-ledger degradation test deliberately lets chat use an
  in-memory packet without claiming a durable packet ID when the entire
  `context_packets` table is absent. Supported databases receive the table and
  action constraint through migrations; hardening a corrupt or pre-schema
  database would require changing the out-of-lane test contract.

### Blueprint Alignment

**Blocking:**

- None.

**Advisory:**

- The linked Agent Runtime & Context Packet blueprint is an unfilled template
  with no components, contracts, integration path, or ADRs. Implementation was
  aligned to REQ-AIA-RT-004, the detailed local specification, and verified live
  code. The factory blueprint should be regenerated elsewhere.

### Architecture And Conventions

**Blocking:**

- None.

**Advisory:**

- The existing packet JSON remains the authoritative generalized Disclosure
  record instead of introducing a duplicate item table. It already retains the
  destination, leave-device state, omissions, and each item's identity,
  version, source type, sensitivity, and selection reason; the new materializer
  exposes those records without duplicating content.
- `src/main/db/schema.ts` is explicitly forbidden in this lane, so its base
  table still has the pre-action constraint. Migration 80 immediately rebuilds
  that table for both fresh and existing databases; direct production-shape
  checks verified existing-row preservation and `purpose = 'act'` insertion.

### Tests And Build

**Commands run:**

- `npm run typecheck` — pass.
- `npm run lint` — 0 errors, 128 pre-existing warnings; neither changed source
  file appears in the warnings.
- `node scripts/run-tests.mjs contextPacket agentOnContextPacket aiThreadDeletion deletionOwnership syncAllowlist`
  — 7 files, 46 pass, 0 fail, 0 skip.
- Direct hermetic SQLite checks — pass for migration preservation, action
  insertion, complete excerpt metadata, packet/file message linking, atomic
  rollback, transcript-vs-file identity, missing-storage failure, and selective
  thread-owned packet/tool disclosure deletion.
- First full-suite run — 2,188 pass, 7 fail, 11 skip because the ignored
  `build/capture-helper` prerequisite was absent.
- `npm run build:capture-helper` and focused capture rerun — 10 pass, 0 fail.
- Final `node scripts/run-tests.mjs` — 327 files, 2,195 pass, 0 fail, 11 skip.

**Blocking:**

- None.

**Advisory:**

- The strict ownership list excludes test files, so no committed WO-68-specific
  test was added. Existing suites plus direct hermetic checks cover the changed
  behavior; the test owner should commit focused migration, rollback, link, and
  deletion cases.
- The final all-green suite contains 2,195 passing tests, two fewer than the
  owner-provided 2,197-pass baseline. No test file changed in this work order,
  and there are zero failures; the baseline count itself has drifted.

### User-Facing Verification

**Skipped:** yes — WO-68 is a local main-process storage contract with no
renderer or externally visible flow. WO-76 owns the Context Inspector surface.

**Evidence:** Direct inspection returned the exact stored destination,
leave-device state, and excerpt identity/version/source/sensitivity/reason, and
message lookup resolved the packet after binding.

**Blocking:**

- None.

**Advisory:**

- None.

### Security, Privacy, And Data Safety

**Skipped:** no.

**Blocking:**

- None.

**Advisory:**

- Packet and packet-created file disclosure writes now commit atomically; a
  forced file-ledger failure left no packet row.
- Transcript excerpts remain in the generalized packet disclosure but no longer
  masquerade as filesystem paths in the file-specific Settings ledger.
- Thread cleanup is scoped by exact thread identity and preserves rows owned by
  other threads. No provider credentials, real activity, or personal fixture
  content was added.

### Round 1 Verdict

- Total blocking: 0
- Total advisory: 7
- Files reviewed: 6
- **Verdict:** APPROVED

---
