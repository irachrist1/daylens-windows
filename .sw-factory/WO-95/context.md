<!--lint disable strong-marker-->

# Work Order Entity Index: WO-95

**Initialized At (UTC):** 2026-08-11T08:27:03Z
**Current Status:** in_review

## Work Order

- WO-95: [backend] Build the deterministic context-packet assembler (`4b35000a-cf9d-4139-b142-0efeb6521b94`)

## Requirements

- Agent Runtime & Context Packet (`/Users/tonny/Downloads/Daylens_Combined_Requirements.md#agent-runtime-context-packet`)

## Blueprints

- Agent Runtime & Context Packet (`b3ed6474-1327-4b15-b0fe-6fdb956f9868`)

## Referenced Blueprints

Blueprints reached through `@…` mentions and links while reading linked blueprints.
- None. The linked blueprint section is an unfilled template with no component
  composition, contracts, ADRs, `@…` mentions, or blueprint links.

## Acceptance Criteria

- Preserve the exact original request and classify the run as answer,
  interpretation, or action.
- Resolve explicit dates, relative days, weeks, months, and named weekdays in
  the person's timezone.
- Resolve eligible named entity identities.
- Include only relevant permitted corrected facts, confirmed preferences,
  activity, entities, exact and semantic results, excerpts, conflicts, gaps,
  permissions, and tool descriptors.
- For an action, retain target, current state, proposed change, permission and
  confirmation state, expected effects, and undo operation.
- Keep disclosed content and ordering stable for unchanged request, facts,
  policy, and context budget.
- Omit excluded, deleted, unauthorized, unavailable, and unpermitted
  high-sensitivity material while recording the reason.
- Prevent revoked or deleted supporting material from entering future packets.

## Verified Architecture

- `src/main/services/contextPacket.ts` already owns deterministic packet
  assembly, privacy filtering, local retrieval, rendering, and persistence.
- Corrected Timeline blocks, exact and semantic memory, entity aliases, file
  grants, connected records, conflicts, gaps, and permission snapshots already
  feed the assembler before provider access.
- The existing implementation supports only `answer` and `interpret`, resolves
  ISO dates plus `yesterday`, trims the original request, has no action context
  or tool descriptors, and records only high-sensitivity and tracking-excluded
  omissions.
- `docs/specs/agent-runtime-and-context.md` is the detailed local architecture
  record. Its assembler order and typed packet contract match the live service,
  unlike the linked factory blueprint's empty template.

## Delivery

- Branch: wave/1-runtime
- Pull Request URL:
