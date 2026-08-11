<!--lint disable strong-marker-->

# Work Order Entity Index: WO-68

**Initialized At (UTC):** 2026-08-11T09:00:38Z
**Current Status:** in_review

## Work Order

- WO-68: [data] Add Context Packet and disclosure-record storage (`5948e647-970b-4f69-8cae-923ec1dc7f47`)

## Requirements

- Agent Runtime & Context Packet (`/Users/tonny/Downloads/Daylens_Combined_Requirements.md#agent-runtime-context-packet`)

## Blueprints

- Agent Runtime & Context Packet (`b3ed6474-1327-4b15-b0fe-6fdb956f9868`)

## Referenced Blueprints

Blueprints reached through `@…` mentions and links while reading linked blueprints.

- None. The linked blueprint section is an unfilled template with no component
  composition, contracts, ADRs, `@…` mentions, or blueprint links.

## Acceptance Criteria

- Before provider access, persist the final Context packet and its destination.
- Associate a persisted packet and Disclosure record with the resulting message.
- For every disclosed excerpt, retain identity, version, source, sensitivity,
  selection reason, and whether it left the device.
- Provide an interface for later deletion of context owned by an AI thread.

## Verified Architecture

- `src/main/services/contextPacket.ts` already stores one local-only
  `context_packets` row before provider access. Its `packet_json` contains the
  final packet, disclosure summary, omissions, permissions, and every disclosed
  item's identity, version, source type, sensitivity, and selection reason.
- The same service binds the packet to an assistant message after the message is
  persisted and mirrors disclosed file excerpts to `file_disclosures`.
- The database constraint still permits only `answer` and `interpret`, while the
  WO-95 packet contract also permits `act`; migration 80 must widen that
  constraint.
- Packet recording and file-disclosure mirroring are not atomic. File rows do
  not receive the resulting message link, and no context-owned thread deletion
  interface exists.
- `src/main/services/artifacts.ts` owns actual AI-thread deletion and is outside
  this lane. WO-68 can provide the context deletion interface, but its caller
  must be wired by that file's owner.
- The detailed live architecture is recorded in
  `docs/specs/agent-runtime-and-context.md`; the linked factory blueprint is an
  unfilled template.

## Delivery

- Branch: wave/1-runtime
- Pull Request URL:
