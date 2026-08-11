# Application attribution

Component Blueprint. Satisfies [Apps](../specs/apps.md), and supplies the
per-application evidence [Timeline](../specs/timeline.md) shows underneath a
block.

## Capability Summary

This capability answers "where did the time go, per application, and what was
done there" — the per-application totals, the per-domain and per-page breakdown
beneath them, and the prose account of each application. Its central types are
`app_sessions`, `website_visits`, `AppIdentityRecord`, and `AppActivityDigest`.
It reads the same corrected attention totals Timeline reads; Apps is a different
projection of one day, not a second measurement of it.

## Core Components

```component
name: AppDetailProjection
container: Desktop Main Process
responsibilities:
	- Building the Apps payload through `getAppDetailPayload`: app-range selection, app-only evidence, and reconciliation
	- Folding sub-threshold domains into one "Everything else" row through `foldTinyDomains`, keeping Σ rows + everythingElse = attributedSeconds
	- Owning app-range selection while leaving timeline formation to #WorkBlockSegmenter
```

`src/main/services/appDetail.ts`.

```component
name: AppIdentityRegistry
container: Desktop Main Process
responsibilities:
	- Resolving many observed bundle identifiers and display names to one canonical application
	- Recording observations through `upsertAppIdentityObservation` and serving links through `getStoredCanonicalAppLinks`
	- Repairing stored observations through `repairStoredAppIdentityObservations`
```

`src/main/core/inference/appIdentityRegistry.ts`.

```component
name: AppActivityDigest
container: Desktop Main Process
responsibilities:
	- Computing, per canonical application, what was done there — from the blocks the person already sees, through `computeAppActivityDigest`
	- Discarding blocks under one minute so a stray focus does not become a claim
	- Carrying each application's covering block labels so the account is traceable to the timeline
```

`src/main/services/appActivityDigest.ts`.

```component
name: WebsiteVisitReconciler
container: Desktop Main Process
responsibilities:
	- Reconciling browser history against foreground browser time through `reconcileWebsiteVisits`
	- Serving corrected per-domain credit through `getCorrectedWebsiteSummariesForRange` by interval union and foreground clamp
```

`src/main/db/queries.ts`.

```component
name: AttributionResolvers
container: Desktop Main Process
responsibilities:
	- Resolving a day's applications and pages onto clients and projects
	- Serving the per-client application breakdown through `ClientAppBreakdownPayload`
	- Recording ambiguity through `AmbiguityEntry` rather than guessing an owner
```

`src/main/core/query/attributionResolvers.ts`.

### Relationships

#WebsiteVisitReconciler is the only source of per-domain credit that
#AppDetailProjection may use. Browser history on its own overstates time badly: a
tab left open for hours reports hours. The reconciler intersects history with
foreground browser sessions and clamps to them, so a domain is credited only for
time the browser actually held attention. Bypassing it is what produced totals a
person could not recognize.

#AppIdentityRegistry is consulted by #AppDetailProjection and #AppActivityDigest
before either groups anything. One application arrives under several bundle
identifiers and display names across updates and platforms, and without a
canonical resolution the same application appears twice in the list with its hours
split. The registry is a learned mapping with repair, not a static table, because
new identifiers appear whenever an application updates.

#AppActivityDigest reads the blocks #WorkBlockSegmenter and #WorkIntentResolver
already produced, rather than re-deriving activity from sessions. This is what
makes Apps and Timeline agree: the account of what happened in an application is
assembled from the same named blocks the timeline shows, so a claim in Apps can
always be pointed at a block. It is also why block label quality bounds Apps
quality — an application's account can be no better than the blocks describing it.

#AppDetailProjection hands its payload to #AIJobOrchestration for the
`app_narrative` job when a person asks for prose (see
[AI job orchestration](ai-job-orchestration.md)). The projection owns every number;
the model receives them and writes sentences. No total is computed by the model.

## System Contracts

### Key Contracts

- **Apps never measures time independently.** It reads the corrected totals from
  the same clamp Timeline uses. Two surfaces disagreeing about one day is the
  failure this contract exists to prevent.
- **The arithmetic on screen reconciles exactly.** `foldTinyDomains` keeps folded
  seconds inside `attributedSeconds`, so Σ visible rows + "Everything else" equals
  the attributed total. A fold is a presentation decision and never loses time.
- **An application appears once.** Canonical resolution runs before grouping.
- **A block under one minute contributes no account.** `computeAppActivityDigest`
  skips it rather than reporting a claim from a stray focus.
- **Unattributable time is stated, not hidden.** Where a stretch cannot be
  resolved to a page, the surface says so in one plain sentence rather than
  rendering a dead "No page recorded" row. This contract is specified and not yet
  met — DEV-238 and DEV-290.
- **Evidence passes the privacy boundary before any AI or MCP consumer sees it**,
  through `filterTrackingExcludedEvidence`. Architecture.md invariant 7.

### Integration Contracts

- The renderer receives the Apps payload over typed IPC and presents it. It does
  not recompute totals, fold domains, or resolve identity.
- `packages/mcp-server` and the in-app agent read these same projections through
  the shared tool executors, so an agent answer about application time cannot
  disagree with the Apps view.

### Integration Boundaries

Timeline formation stays in #WorkBlockSegmenter; this capability owns app-range
selection, app-only evidence, and reconciliation. The boundary is stated in the
source at `src/main/services/appDetail.ts` and matters because both surfaces read
overlapping data and only one may define a block.

## Architecture Decision Records

### ADR-001: Browser history explains attention rather than creating it

**Context.** Crediting time from browser history directly produced totals far
above the time the browser was actually in the foreground.

**Decision.** History is intersected with foreground browser sessions and clamped
to them. Only foreground `app_sessions` measure time; history distributes that
measured time across domains.

**Consequences.** Per-domain totals are trustworthy and reconcile with the day.
The cost is that a browser with no readable history leaves foreground time
attributed to the browser and to no page — the "No page recorded" stretches, which
must be explained in a sentence rather than shown as an empty row. DEV-238 tracks
closing that gap.

### ADR-002: Application identity is learned and repairable, not a static map

**Context.** One application arrives under several bundle identifiers and display
names across versions and platforms. A static table went stale on every update and
split one application's hours across two rows.

**Decision.** Observations accumulate in a registry with a canonical link per
application, plus an explicit repair pass over stored observations.

**Consequences.** New identifiers are absorbed without a code change, and existing
splits can be healed. The registry is state that can itself be wrong, so it needs
the repair path and an obvious, durable merge in the interface — DEV-224.

### ADR-003: The account of an application is assembled from blocks, not sessions

**Context.** "What you did there" could be derived from raw sessions and window
titles, or from the named blocks the timeline already shows.

**Decision.** It is derived from blocks, carrying each application's covering block
labels.

**Consequences.** Apps and Timeline cannot contradict each other, and every claim
in Apps traces to a block a person can open. The dependency runs the other way
too: poor block labels produce a poor application account, so Apps quality work
that ignores label quality will not converge. DEV-237 sits downstream of this.
