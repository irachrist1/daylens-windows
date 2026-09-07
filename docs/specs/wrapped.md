# Wrapped

**Status:** Ready for review.

This specification defines the V2 Wrapped: a recap of a day, week, month, or year built from the same corrected facts, interpretation, and voice as Timeline, Apps, and the AI agent. Wrapped is part of the Version 2 release; it ships rebuilt on the shared systems, not as a parallel pipeline.

Wrapped is the moment Daylens proves its promise back to the person: everything it understood about the period, told as a story they recognize, with every claim standing on evidence they can inspect.

## Product behavior

A person can open a wrap for:

- the current or any past day
- a week, month, or year

The wrap presents, as a sequence of visual scenes:

- what the period was actually about — the projects, clients, meetings, people, and subjects that defined it
- deterministic totals: active time, top applications and websites, work and personal balance, meeting time
- genuinely notable specifics the evidence supports — a shipped feature, a long focused stretch, a new tool, a heavy meeting day
- honest gaps: days without capture, paused stretches, and periods Daylens cannot explain

A wrap never assigns a productivity score and never inflates thin evidence into a story. It may name the live distraction profile when those facts are on the table. It does not turn that split, or a focus score, into a judgment of personal worth.

## One fact system

Every number and every named entity in a wrap comes from the shared corrected activity facts — the same query boundary Timeline and Apps use.

- Totals reconcile exactly with Timeline and Apps for the same period and filters.
- Corrections change wraps the same way they change every other surface; a regenerated wrap reflects them.
- Excluded and deleted activity never appears in a wrap, its narrative, or its export.
- Deterministic facts are computed first and independently of any model; the fact table is inspectable.

## Narrative

A model turns the deterministic facts into short narrative lines in the shared product voice, using the person's chosen tone (straight, warm, or witty — warm by default).

- Every generated line is validated against the fact table before display. A line naming an entity, number, or event that the facts do not support is rejected and regenerated with a repair prompt; persistent failure falls back to the deterministic phrasing.
- Narrative interprets; it does not add facts. "You shipped the export feature" requires supporting evidence; "a productive week" is never generated.
- Connected evidence (repositories, calendars, meetings) may enrich lines only through the shared evidence system and its permissions.
- Without a model provider or managed allowance, the wrap still renders complete deterministic scenes; only the narrative lines are absent.

## Readiness

A preflight gate decides whether a period can produce an honest wrap:

- **empty** — no captured activity; the wrap explains that instead of inventing content
- **too early** — the period has barely begun
- **partial** — enough for a wrap that names its gaps
- **full** — a complete period

The gate's reasons are shown in product language. A wrap over partial data says so inside the wrap itself.

## Presentation and export

- The wrap is a paged deck of scenes; each scene owns one idea.
- Category colors, entity names, and icons match Timeline and Apps.
- A deck exports to shareable images rendered locally; export contains only what the person saw and approved on screen.
- Opening the evidence behind a scene lands on the same inspection used by Timeline blocks.

## Failure behavior

- Model failure, rate limits, or exhausted allowance degrade to deterministic scenes, never to an error page.
- A narrative line that fails validation is never shown; the deterministic fallback appears in its place.
- Regenerating a wrap after new evidence or corrections produces a wrap consistent with the current facts; stale cached narrative is invalidated by a facts hash.
- Export failure reports which scenes rendered and leaves no partial share on disk.

## Evaluation

- Wrap facts are covered by the deterministic suite and the strict Timeline evaluation, since they derive from the same projections.
- Narrative grounding is covered by honesty and adversarial fixtures: lines with unsupported names, numbers, or outcomes must be rejected.
- The paid wrap benchmark judges narrative quality and grounding on representative data and requires explicit approval to run.
- The private real-day benchmark includes the day wrap of the reviewed day; its facts must match the accepted reconstruction.

## Acceptance criteria

- Wrap totals reconcile exactly with Timeline and Apps for the same period.
- Every narrative line is traceable to the fact table; unsupported lines cannot render.
- Corrections, exclusions, and deletion change regenerated wraps everywhere, including exports.
- A wrap renders fully without a model provider, minus narrative lines.
- Empty, too-early, partial, and full periods produce the documented experiences.
- No wrap output judges productivity or personal worth. Naming a leisure surface from the distraction profile is allowed; grading the person is not.
- The rebuilt wrap is reviewed against real days in the running product before Version 2 ships.

## Implementation starting point

The first ticket should move wrap fact computation onto the shared corrected activity-fact query and prove reconciliation with Timeline and Apps by test, without changing the visible deck. Narrative, scene, and export changes follow only after the facts ride the shared seam.
