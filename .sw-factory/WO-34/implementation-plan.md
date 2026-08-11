<!--lint disable no-undefined-references strong-marker-->

# Implementation Plan: WO-34

**Work Order:** WO-34 — [backend] Move attribution reads to the entity-graph boundary
**Created At (UTC):** 2026-08-11T08:30:00Z

## Summary

Stop silent label conflation in client/project attribution reads by resolving
identity through `resolveEntityByLabel`, and load target names/aliases from the
entity graph when present. Activity totals still come from work sessions keyed
by the surviving entity id, so Timeline/Apps-compatible numbers stay on the same
facts once the right entity is chosen — or stay unanswered as uncertainty when
the label is ambiguous (AC-SM-EA-002.5 / AC-SM-EA-004.4).

## Code Reuse And Package Structure

Reuse:

- `resolveEntityByLabel`, `mergeGroupIds`, `normalizeEntityLabel` from
  `src/main/services/entities/entityRepository.ts`
- Existing `ClientQueryPayload` / `ProjectQueryPayload` shapes and session
  assembly in `attributionResolvers.ts`
- Test harness `createProductionTestDatabase` from `tests/support/testDatabase.ts`

Modify:

- `src/main/core/query/attributionResolvers.ts` — label lookup + target alias
  reads
- `tests/attributionEntityBoundary.test.ts` (new) — ambiguity, unique alias,
  query payload aliases from the entity graph

No migrations for this WO. No edits to `schema.ts`, `types.ts`, `aiTools.ts`,
or capture writers.

## Components And Flow

Blueprint component: `#AttributionResolvers` becomes a consumer of
`#EntityRepository` for identity.

```
label
  → resolveEntityByLabel(db, 'client'|'project', label)
      unique survivor → clients/projects row by id
      candidates > 1  → null / ResolveByLabelResult (no silent pick)
      no graph hit    → legacy exact name + exact alias only (no LIKE LIMIT 1)
  → resolveClientQuery / resolveProjectQuery
      target.name + aliases from entity merge group when entity exists
      sessions/evidence from work_sessions as today
```

New exports:

- `resolveClientByLabel(name, db) → { client, matchedBy, candidates }`
- `resolveProjectByLabel(name, db) → { project, matchedBy, candidates }`
- `findClientByName` / `findProjectByName` become thin wrappers that return the
  unique row or null (preserving today's call-site contract for `aiTools`).

## Steps

1. Replace `findViaEntityAliases` + fuzzy `LIMIT 1` with entity-label resolution
   and a legacy exact-only fallback.
2. Teach `resolveClientQuery` / `resolveProjectQuery` to prefer entity canonical
   name and merge-group aliases for `target`.
3. Keep ambiguity candidate assembly for sessions on entity names where
   available.
4. Add tests covering the DEV-246-shaped silent-pick failure and graph alias
   surfacing.
5. Run typecheck, lint, and the new + related entity tests.

## Testing

Automated:

- `tests/attributionEntityBoundary.test.ts`
  - two clients sharing an alias → `findClientByName` returns null; label
    resolver returns candidates
  - unique entity alias after rename/merge → resolves to survivor
  - `resolveClientQuery` includes entity aliases (including prior canonical name
    kept as alias)
  - fuzzy substring that matches two active clients does not pick one
- Existing `tests/entityRepository.test.ts` still passes

Commands:

```bash
npm run typecheck && npm run lint
node scripts/run-tests.mjs tests/attributionEntityBoundary.test.ts tests/entityRepository.test.ts
```

Manual / exploratory: not runnable against the owner's real DB in this public
repo session; the silent-pick regression is encoded as a fixture that mirrors
the acceptance dossier failure mode (wrong entity → wrong minutes).
