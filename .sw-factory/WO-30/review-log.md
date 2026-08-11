<!--lint disable strong-marker-->

# Review Log: WO-30

## Round 1

### Requirements Alignment

- Helpers mint entities and attach `entity_evidence_refs` with source ids.
- Relationships from ConnectedEnvelope retain source + confidence.
- Uncertainty: website write without visit id mints the page entity without
  fabricating evidence refs.

**Advisory / cross-lane:** `workBlocks.upsertArtifact` and
`appIdentityRegistry.upsertAppIdentityObservation` do not yet call the new
helpers. In-lane website visit path is wired via `queries.insertWebsiteVisit`.

### Blueprint Alignment

ConnectedEnvelope remains the provisional ingress. Live capture writers beyond
website visits are the remaining gap called out as cross-lane.

### Verdict

**APPROVED** — in-lane deliverables complete; remaining capture writers recorded
as cross-lane dependencies, not silently marked done.
