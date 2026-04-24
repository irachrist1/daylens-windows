# Daylens Remote Contract

Status: code-audited refresh on 2026-04-23

This file documents the shared remote contract as it exists in code today and calls out the places where the code is narrower than the type surface.

## Shared Package

The contract lives in `packages/remote-contract` and is re-exported to the desktop snapshot layer from `src/shared/snapshot.ts`.

Code references:

- `packages/remote-contract/index.ts:1-318`
- `src/shared/snapshot.ts:1`

Current contract version:

- `2026-04-20-r2` (`packages/remote-contract/index.ts:1`)

## Code-Proven Contract Shapes

### Snapshot V2

Desktop snapshot v2 includes:

- focus score V2
- work blocks
- recap
- coverage
- top workstreams
- standout artifacts
- entities
- `privacyFiltered`

Code references:

- `packages/remote-contract/index.ts:179-193`
- `src/main/services/snapshotExporter.ts:343-552`

### Sync Health And Presence

Current contract types:

- `SyncHealth`: `linked | pending_first_sync | healthy | stale | failed`
- `WorkspacePresenceState`: `active | idle | meeting | sleeping | offline | stale`

Desktop runtime derivation also has a local-only pre-link state:

- `local_only | linked | pending_first_sync | healthy | stale | failed`

Code references:

- `packages/remote-contract/index.ts:199-212`
- `src/main/services/syncState.ts:5-24`
- `src/main/services/workspaceLinker.ts:183-198`

### Remote Payload Boundary

The launch payload already contains:

- one day summary
- work blocks
- entities
- artifacts
- contract version, device id, local date, generated-at

Desktop privacy shaping removes raw block artifact refs and generalized page labels before upload.

Code references:

- `packages/remote-contract/index.ts:235-263`
- `src/main/services/remoteSync.ts:43-69`
- `src/main/services/remoteSync.ts:192-227`

### Workspace AI Types

The shared contract already defines:

- `WorkspaceAIThread`
- `WorkspaceAIMessage`
- `WorkspaceAIArtifact`

Code references:

- `packages/remote-contract/index.ts:287-318`

## Important Narrowings In The Current Implementation

### Entity Rollups

The contract allows:

- `client`
- `project`
- `repo`
- `topic`

Desktop exporter currently loads only:

- `client`
- `project`

Code references:

- `packages/remote-contract/index.ts:153-159`
- `src/main/services/snapshotExporter.ts:279-321`

### Work Block Label Source

The remote contract exposes:

- `user`
- `ai`
- `rule`

Local timeline finalization internally distinguishes:

- `user`
- `ai`
- `artifact`
- `workflow`
- `rule`

That means remote consumers see a normalized label-source surface instead of the fuller local provenance.

Code references:

- `packages/remote-contract/index.ts:74-94`
- `src/main/services/workBlocks.ts:1301-1349`
- `src/main/services/snapshotExporter.ts:192-216`

### Shared AI Continuity

The contract has shared workspace AI thread/message/artifact types, but desktop does not yet write those rows to the remote backend. Web-side AI persistence is therefore real but still web-originated today.

Code references:

- `packages/remote-contract/index.ts:287-318`
- `src/main/services/artifacts.ts:339-342`

## Web Compatibility Layer Still Present

`daylens-web` still normalizes legacy `hiddenByPreferences` input into the stronger `privacyFiltered` field when reading older snapshot payloads.

Code reference:

- `/Users/tonny/Dev-Personal/daylens-web/convex/snapshots.ts:228-230`

## Contract Truthfulness Rules

- Do not claim remote AI continuity across desktop and web until the desktop writes shared remote AI rows.
- Do not claim broader first-class entity support than the exporter actually emits.
- Do not widen the remote payload boundary beyond privacy-filtered work blocks, entities, artifacts, and day summary without an explicit decision.
