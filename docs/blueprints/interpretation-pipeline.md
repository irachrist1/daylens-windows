# Interpretation pipeline

Component Blueprint. Satisfies [Timeline](../specs/timeline.md) and the
day-analysis half of
[Day recap and analysis](../specs/day-recap-and-analysis.md).

## Capability Summary

This capability turns raw foreground capture into a day a person recognizes:
continuous blocks with wall-clock bounds, a name that describes the work rather
than the tool that hosted it, a kind, and corrections that survive rebuilds. Its
central types are `timeline_blocks`, `timeline_block_members`,
`timeline_block_labels`, and `WorkKind`, and its output is what Timeline renders,
what recaps and wraps describe, and what the agent answers from. Every consumer
reads the same blocks; there is no second reconstruction of a day.

## Core Components

```component
name: WorkBlockSegmenter
container: Desktop Main Process
responsibilities:
	- Folding foreground `app_sessions` and `activity_state_events` into continuous blocks with a recorded boundary reason
	- Holding the attention budget: only foreground sessions measure time
	- Deciding where a block ends — real absence, sleep, idle, or the start of a meeting
	- Resolving a block's dominant category through `dominantCategoryForBlock` and `dominantCategoryFromDistribution`
```

`src/main/services/workBlocks.ts`.

```component
name: WorkIntentResolver
container: Desktop Main Process
responsibilities:
	- Assigning a block its role: execution, research, communication, review
	- Choosing the subject that names the block, ranked artifact > page > workflow > domain
	- Refusing any subject the guards disqualify, so a real document, channel, or repository names the block instead
```

`src/shared/workIntent.ts`.

```component
name: WorkNameGuards
container: Desktop Main Process, Renderer
responsibilities:
	- Rejecting tool brands (`isToolBrandName`) and tool surfaces (`isToolSurfaceTitle`)
	- Rejecting command lines, joined tab titles, repository-path titles, inhuman and shouting titles, machine hostnames
	- Exposing one shared verdict through `isDisqualifiedWorkSubject` and `workNameGuardLabelViolation`
	- Cleaning a surviving candidate through `cleanWorkSubject`
```

`src/shared/workNameGuards.ts`. Shared rather than main-only so a label cannot be
generated in one process and validated by different rules in another.

```component
name: WorkKindClassifier
container: Desktop Main Process, Renderer
responsibilities:
	- Classifying a block work, leisure, or personal, distribution-first rather than by any single session
	- Resolving a stored block's kind on the read path through `effectiveBlockKind`
	- Mapping a domain to a kind through `kindForDomain`, and partitioning domains work-first
```

`src/shared/workKind.ts`.

```component
name: DayAnalyzer
container: Desktop Main Process
responsibilities:
	- Regrouping and relabelling a day with the model through `analyzeTimelineDay`
	- Versioning each analysis in `day_analysis_versions` so an interpretation is replaceable, not destructive
	- Falling back to the heuristic result when no provider is configured
```

`src/main/services/analyzeDay.ts`.

```component
name: LabelGuardRepair
container: Desktop Main Process
responsibilities:
	- Enforcing the guards at generation time, so a model-authored label that names a tool never reaches storage
	- Repairing a violating label once rather than discarding the analysis
```

`src/main/services/labelGuardRepair.ts`.

```model
name: TimelineBlock
store: SQLite (local)
description: One continuous stretch of a day as the person sees it. The unit every other surface reads.
fields:
	- id: integer (required)
	- date: local date key (required)
	- start_time, end_time: epoch milliseconds (required)
	- canonical_apps: the applications inside the block
	- label_current: the name shown to the person
	- kind: work | leisure | personal
constraints:
	- Only foreground `app_sessions` contribute duration
	- A stored block's kind is resolved through `effectiveBlockKind` on read, never trusted raw
	- Corrections in `block_label_overrides` outrank any generated label
```

### Relationships

#WorkBlockSegmenter produces the blocks that #WorkIntentResolver then names. The
segmenter decides *where* a block begins and ends and what categories it contains;
the resolver decides *what to call it*, reading the block's artifacts, pages, and
workflows. The split exists because a boundary is a fact about attention while a
name is an interpretation, and the two change for different reasons — a
segmentation fix must not silently rewrite every label.

#WorkIntentResolver depends on #WorkNameGuards for every candidate subject it
considers, and #LabelGuardRepair applies the same guards to model-authored labels
before storage. Both call `isDisqualifiedWorkSubject`, so a name rejected on the
heuristic path cannot enter through the AI path. This is the single reason a
day stops reading as "Cursor Agents" and "New chat - Claude": one verdict, two
producers.

#DayAnalyzer reads the heuristic blocks and returns a regrouped, relabelled day,
writing each result as a new row in `day_analysis_versions` rather than mutating
the previous one. #LabelGuardRepair sits between the model's output and storage.
Versioning is what lets a person re-analyze without losing the account they
already accepted, and what lets a heuristic bump heal a stale day on read.

#WorkKindClassifier is consulted by both the build path and the read path. The
build path sets a block's kind from its category distribution; the read path
recomputes through `effectiveBlockKind` rather than trusting the stored value.
Reading through one resolver is what keeps a block whose dominant category is
focused work classified as work on both paths.

## System Contracts

### Key Contracts

- **Attention is the budget.** Only foreground `app_sessions` measure time. Browser
  history explains attention; it never creates it. No raw `SUM(duration_sec)`
  participates in a user-facing total. See architecture.md invariant 1.
- **One clamp everywhere.** Day totals and per-block `websites` use the same
  corrected variant. A background tab cannot outvote foreground work. Invariant 2.
- **Kind follows intent**, on the build path and the rehydrated read path alike.
  Invariant 3.
- **Subjects name the work, never the tool.** Enforced by #WorkNameGuards at every
  producer, heuristic and model alike. No email address enters a subject.
  Invariant 4.
- **Interpretation is versioned, not overwritten.** A new analysis adds a version;
  corrections outrank generated labels and survive rebuilds and future days.
- **A correction is durable.** `block_label_overrides`,
  `timeline_block_reviews`, `evidence_exclusions`, and `correction_undo_log` are
  read after generation, so re-analysis cannot silently discard a person's fix.

### Integration Contracts

- Consumers read blocks through the query layer and the projections under
  `src/main/core/projections`, never by re-segmenting sessions. #AIJobOrchestration
  (see [AI job orchestration](ai-job-orchestration.md)) receives blocks already
  named and kinded; the model is given a day to describe, not raw capture to
  interpret.
- The renderer receives blocks over typed IPC and presents them. It does not
  recompute durations, kinds, or names.

### Integration Boundaries

Segmentation and naming belong to the main process. The renderer owns
presentation and selection only — `src/renderer/lib/timelineMergeSelection.ts`
decides what the person has selected, not what a block means.

## Architecture Decision Records

### ADR-001: Name guards are shared, not main-process-only

**Context.** Labels are produced in two places: the heuristic intent resolver and
the model relabel path. When each validated names by its own rules, tool surfaces
reached storage through whichever path was laxer.

**Decision.** `workNameGuards.ts` lives in `src/shared` and is the single verdict
for both producers, applied at generation time rather than at render time.

**Consequences.** A guard change fixes every producer at once, and a violating
label cannot be stored rather than merely hidden. Labels stored before the guards
existed remain wrong in the database and need a migration or heal-on-read pass;
DEV-288 tracks the residue.

### ADR-002: Kind is resolved on read, not trusted from storage

**Context.** A block's kind was written at build time. Heuristic improvements left
older blocks classified by superseded rules, so the same day read differently
depending on when it was built.

**Decision.** Both paths resolve kind through `effectiveBlockKind`. The stored
value is an input, not the answer.

**Consequences.** Heuristic improvements apply to history without a migration, at
the cost of recomputation on every read. This is what makes the versioned
heuristic bump and heal-on-read policy possible.

### ADR-003: `workBlocks.ts` is a 7,000-line module and that is a known cost

**Context.** The segmenter has grown to roughly 7,070 lines holding segmentation,
category resolution, block display normalization, and app-detail slicing.

**Decision.** Not split as part of any surface work order. Extraction happens
incrementally, following the pattern already established for focus events, where
`src/main/core/evidence/focusEvent.ts` owns a typed contract and
`src/main/db/focusEventRepository.ts` owns its persistence.

**Consequences.** Any work order touching segmentation pays a large
context-gathering cost, and the module is the most likely place for an unnoticed
regression. Recorded here so that cost is planned for rather than discovered.
