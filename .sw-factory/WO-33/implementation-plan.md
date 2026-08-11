<!--lint disable no-undefined-references strong-marker-->

# Implementation Plan: WO-33

**Work Order:** WO-33 — Make project and client creation graph-backed
**Created At (UTC):** 2026-08-11T08:40:00Z

## Summary

Extend `createClient` and `createProject` so each transaction also upserts the
matching supplied entity (same id), seeds entity aliases, and — when a project
has a client — records a `belongs_to` relationship with source/confidence.

## Code Reuse And Package Structure

Reuse `upsertEntity`, `addEntityAlias`, `addEntityRelationship` via new helpers
`ensureSuppliedClientEntity` / `ensureSuppliedProjectEntity` in
`entityAdoption.ts` (same shape as `adoptClients` / `adoptProjects`).

Modify: `entityAdoption.ts`, `attributionResolvers.ts`, new test
`tests/graphBackedClientProjectCreate.test.ts`.

## Steps

1. Add ensure-supplied helpers mirroring backfill.
2. Call them inside createClient / createProject / getOrCreateClientByName create path.
3. Also sync on updateClient rename (alias + canonical when entity exists).
4. Tests: create client → entity row; create project with client → belongs_to.

## Testing

```bash
node scripts/run-tests.mjs tests/graphBackedClientProjectCreate.test.ts
npm run typecheck && npm run lint
```
