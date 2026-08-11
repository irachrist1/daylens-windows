<!--lint disable no-undefined-references strong-marker-->

# Implementation Plan: WO-68

**Work Order:** WO-68 — [data] Add Context Packet and disclosure-record storage
**Created At (UTC):** 2026-08-11T09:00:38Z

## Summary

Complete the existing local disclosure ledger rather than introducing a second
source of truth. Migration 80 will admit action packets, while the packet
storage service will record packet and file disclosure rows atomically, link
all rows created for the packet to the resulting message, expose inspectable
disclosure metadata, and provide thread-owned deletion.

## Code Reuse And Package Structure

Reuse:

- `src/main/services/contextPacket.ts` as the sole Context packet and generalized
  Disclosure record store.
- `ContextPacketItem` and `ContextDisclosure` as the durable excerpt and
  destination metadata contract already serialized in `packet_json`.
- `recordFileDisclosure` for the existing file-specific Settings ledger.
- Migration v54's `context_packets` shape and migration v51's
  `file_disclosures` shape; no new table is required.
- `tests/contextPacket.test.ts`, `tests/agentOnContextPacket.test.ts`, and
  `tests/aiThreadDeletion.test.ts` as existing regression coverage.

Intentionally modified:

- `src/main/db/migrations.ts` — migration 80 widens the packet-purpose constraint
  to `answer | interpret | act`. The owner assigned migration versions 80–84;
  `src/main/db/schema.ts` remains untouched as explicitly required.
- `src/main/services/contextPacket.ts` — make recording atomic, expose stored
  disclosure rows, propagate message links, and delete thread-owned context.
- `.sw-factory/WO-68/*` — execution context, plan, checklist, and review record.

The strict ownership list excludes test files and the actual thread deletion
owner in `src/main/services/artifacts.ts`; those files will not be edited.

## Components And Flow

The linked factory blueprint defines no components. The verified local
specification defines the Context assembler and `AgentContextPacket`; their live
counterparts are `buildContextPacket`, `ContextPacket`, and the persistence
functions in `contextPacket.ts`.

Before provider access, `recordContextPacket` writes the complete packet row and
any file-specific disclosure mirrors in one database transaction. The packet
JSON remains the authoritative generalized Disclosure record: it includes the
destination, leave-device state, and every excerpt's inspectable metadata.
After the assistant message is persisted, `linkContextPacketToMessage` binds the
packet and its file mirrors to that message in one transaction.

`getContextDisclosuresForPacket` materializes the durable generalized
disclosure items from the stored packet without duplicating content into
another table. `deleteContextPacketsForThread` removes packet rows and all
thread-owned file disclosures. The out-of-lane thread owner must invoke this
interface during actual thread deletion.

## Steps

1. **Widen durable packet purpose** — add migration 80 that rebuilds
   `context_packets` with `act` admitted while preserving every existing row and
   index.
2. **Strengthen recording and linking** — transact packet/file writes and update
   packet-created file disclosure rows when the packet is linked to a resulting
   message.
3. **Expose inspection and deletion interfaces** — return normalized stored
   disclosure items and implement precise thread-owned cleanup without changing
   the out-of-lane thread service.
4. **Review and verify** — exercise answer and action packet round trips,
   message linking, rollback behavior, and targeted thread cleanup with a
   temporary production-shape database; run focused suites, typecheck, and lint.

## Testing

Automated:

- `node scripts/run-tests.mjs contextPacket agentOnContextPacket aiThreadDeletion deletionOwnership syncAllowlist`
- `npm run typecheck`
- `npm run lint`

Direct production-shape checks will verify:

- migration 80 preserves existing packet rows and admits `purpose = 'act'`;
- answer and action packet Disclosure records retain destination and excerpt
  identity, version, source, sensitivity, reason, and leave-device state;
- resulting-message links reach the packet and its file-disclosure mirror;
- a failed file-disclosure write rolls back the packet row;
- thread cleanup removes only packet/file rows owned by the selected thread.

No test source will be edited because the assigned lane owns only the listed
runtime files. Missing committed WO-68-specific regression cases and actual
thread-deletion wiring will be recorded as cross-lane dependencies.
