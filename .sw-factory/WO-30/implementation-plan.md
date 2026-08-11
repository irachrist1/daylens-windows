<!--lint disable no-undefined-references strong-marker-->

# Implementation Plan: WO-30

## Summary

Provide live entity-graph write-through helpers for captured app identities,
artifacts, and website visits, and wire the in-lane website visit path. Artifact
and app-identity call sites outside this lane are documented as cross-lane
dependencies.

## Steps

1. Add `adoptAppIdentityWrite`, `adoptArtifactWrite`, `adoptWebsiteVisitWrite`.
2. Hook `insertWebsiteVisit` in `queries.ts` (shared, additive).
3. Confirm ConnectedEnvelope relationships keep source + confidence.
4. Tests for each helper; document workBlocks / appIdentityRegistry wiring.

## Testing

`tests/entityWriteThrough.test.ts`
