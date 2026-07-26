# Day recap and analysis agent

**Status:** Draft for build. Approved in direction by the owner (2026-07-22): build
as one coherent feature, with in-app clarifying questions the person can answer
or skip.

This specification defines how Daylens turns a day into an account a person
trusts — the block labels produced by **Analyze**, the day **recap**, and the
clarifying questions the system asks along the way. It realizes, for the
day-analysis and recap path, the interpretation agent and context assembler
already defined in [agent-runtime-and-context.md](agent-runtime-and-context.md)
and the voice/question discipline in [ai-agent.md](ai-agent.md). It does not
introduce a second summarization pipeline; recap and Analyze read the same
corrected facts, through the same retrieval and interpretation system, as every
other agent surface (ai-agent.md: "briefs must use the same retrieval,
interpretation, and correction system rather than a separate summarization
pipeline").

## Why this exists

Today the recap is a one-shot call over a thin scaffold — ten blocks and a few
app names — with a deterministic `fallbackDaySummary` template behind it. It
ignores almost everything Daylens captures: calendar events and the person's
attended/skipped marks, git activity, Granola notes, resolved entities, and the
editable work-memory profile. So it is confidently wrong: it collapses a day of
shipping into "Traycer for 3h 56m," ranks a bare date as an activity, and leaks
internal vocabulary ("trusted blocks", "strongest evidence") into prose a person
is meant to read. The account of the day must be grounded in what actually
happened, said in Daylens's own voice, and honest about what it does not know.

The reference failure set is
[the 2026-07-20 gap analysis](../reviews/gap-analysis-2026-07-20.md): a real
day's journal ground truth against what Daylens produced. Every rule in this
specification and in [timeline.md](timeline.md) traces to a failure there.

## Principles

1. **One interpreted account, many sources.** The recap and the block labels are
   two renderings of one grounded interpretation of the day — never independently
   computed, never contradicting each other or the timeline.
2. **Ground every claim; invent nothing.** Every asserted fact traces to a
   source. A foreground app is evidence of activity, not proof of attendance,
   comprehension, or completion (agent-runtime-and-context.md §Day understanding).
3. **Authority order settles conflicts.** Person's correction/confirmation >
   device observation > connector-native fact > corroborated fact > inference >
   generated language (agent-runtime-and-context.md §Information authority). A
   calendar event proves what was *scheduled*; only device/transcript/confirmation
   proves it *happened*.
4. **Ask when it changes the account; otherwise answer and state the gap.** The
   agent asks the person a question only when two readings would materially change
   the day. It never asks merely because evidence is thin (ai-agent.md §Question
   planning).
5. **The person's answer is durable.** A confirmed answer becomes supplied memory
   and, where it names a block's activity/category, a correction — it survives
   rebuilds and grounds future days. The agent learns.
6. **Voice and honesty are enforced, not hoped for.** Recap and narrative prose
   pass a voice eval; the deterministic fallback presents as a plain factual line,
   never imitation prose; nothing fails silently.

## The grounded day context

Analyze and recap run over a day context assembled by the context assembler (not
a prompt template), from every permitted source, each fact carrying its source
type, identifier, and effective time:

- **Corrected timeline blocks** — the same partition the timeline shows
  (boundaries, active duration, evidence), including user corrections. This is
  the spine; recap totals equal the timeline's totals, and both obey the
  attention accounting rules in [timeline.md](timeline.md): time comes only from
  foreground attention, website credit is reconciled and clamped, media in a
  background tab is ambience, not activity.
- **Calendar events + attendance marks** — scheduled context and the person's
  attended / skipped / moved / unrelated marks (see
  [DEV-273 spec](calendar-and-blocks.md) once written). Scheduling is authoritative
  for what was planned; attendance the person confirmed is authoritative for
  presence.
- **External signals** — git activity (commits, PRs) and calendar enrichment via
  the zero-setup local probes in `externalSignals.ts`, retrieved on demand within
  the block's time and entity scope. (The OAuth connector framework was removed
  2026-07-26; any reborn integration lands here as agent-pluggable evidence, not
  a settings page.)
- **Resolved entities** — clients, projects, people, meetings, repositories the
  day's evidence supports naming.
- **Work-memory profile** — the editable, human-readable "who you are" context.
- **The person's day note** — the optional line typed in the wrap flow, treated
  as a strong grounding hint, never overriding evidence.

The agent retrieves detail through narrow read tools rather than receiving one
dump, keeping the run fast, cheap, and inspectable. Retrieval obeys the same
exclusion, sensitivity, and disclosure rules as every other packet.

### Gaps are facts

Untracked time of 45 minutes or more inside the day's span becomes an explicit
`gap` fact with clock bounds ("17:14–21:24 away from the computer"),
cross-referenced against calendar when available ("matches 'Run' 18:00–20:00").
The narrative layer already has honesty directives about untracked time; giving
it the gap as a *fact* lets it say something true instead of avoiding the topic
— or worse, implying a continuous grind.

### Day threads

The same subject recurring in three or more blocks across three or more hours is
a *day thread*, and the day facts carry it as a first-class fact ("Daylens ran
through the whole day: morning fixes, afternoon repo sync, evening CI"), so
prose can tell the day's real shape instead of twelve app fragments.

### What the model may see

The facts fed to the model (`compactDayFacts`) are *day facts*, never
presentation artifacts: no "Other" chart bucket as a named surface, no
self-referential plumbing. If a fact is not something a human assistant would
say about the day, it does not go in the prompt.

## Freshness: a report is a view of facts, not a snapshot

A stored day narrative whose `facts_hash` no longer matches the day's facts:

- **Same-day open** — reconcile deterministically, without regenerating: no
  churn while the day accrues.
- **Later-day open** — regenerate once. A completed day whose stored narrative
  was generated mid-day is permanently wrong (the reference failure froze
  2026-07-20 at 10:38am as a "short day"). One provider call fixes it forever;
  after that the hash matches.

## The clarification contract

When the agent hits an ambiguity it cannot resolve from evidence and that would
materially change the account, it asks the person — in an in-app question card
modeled on the same answer-or-skip pattern shipped by Cursor, Claude Code, and
Codex.

- **Trigger.** Only a *material* ambiguity: a substantial block whose evidence
  supports two genuinely different readings; a scheduled event marked attended
  with no captured activity; an entity the evidence cannot disambiguate between
  two clients. Never "some evidence is incomplete" — that is answered and the gap
  stated plainly.
- **Shape.** One to a few questions, each with 2–4 concrete options plus free
  text, and an explicit **Skip**. The person can answer some and skip others.
- **Non-blocking.** The recap and labels generate best-effort without waiting; a
  skipped question leaves the supported-but-uncertain reading and a stated gap.
- **Durable.** An answer is written as confirmed supplied memory; when it names a
  block's activity or category it is also recorded as a correction. Both survive
  rebuilds (invariant 8) and ground future days. A skip is remembered too, so the
  same question is not re-asked every open.
- **Grounded, never leading.** Options are drawn from the evidence (the apps,
  pages, entities actually present), not invented; "Other" always allows the
  person's own words.

The runtime already models this as a `user-input request` event with an explicit
pending/resume state (agent-runtime-and-context.md §Sessions and interruption);
this contract is its product surface for the day path.

## Output: recap and labels

- **Block labels** name the activity in the person's everyday words, per
  [label-voice.md](label-voice.md) — never the app, the raw title, or the
  telemetry.
- **The recap** is 2–4 sentences of calm, plain prose that names the day's actual
  work and its shape, grounded in the same facts, with no internal vocabulary, no
  raw window titles, and no stat-dump sentence forms. It never contradicts the
  timeline's totals within one screen.
- **Uncertainty is spoken plainly**, not hidden behind confident phrasing or a
  productivity score.

## Honesty and failure

- **No silent failure.** If the model is unavailable or times out, the recap does
  not silently substitute a template dressed as prose. It shows a plainly-marked
  factual line (the day's grounded totals and top activities) and says the full
  recap could not be generated, with retry.
- The deterministic fallback line still obeys the label voice (no "trusted
  blocks", no "strongest evidence").
- A partial interpretation failure keeps the deterministic blocks with factual
  fallback labels and reports what failed.
- **Privacy propagates in both directions.** Exclusions hold everywhere —
  everything AI-bound passes the `filterTrackingExcludedEvidence` boundary —
  but redaction must not over-fire: excluding an app with a common-word name
  ("Messages", "Notes", "Music", "Mail") must not redact ordinary prose
  containing that word. Exclusion tokens need case- and context-sensitive
  matching, and a redaction that fires on a label while leaving the block's
  evidence visible protects nothing.

## Evaluation

- **Recap/analysis voice eval.** Generated recaps and block narratives are scored
  against label-voice.md plus a recap-voice rubric (no internal vocabulary, no
  stat-dump shapes, names the real work, totals match the timeline). The eval
  fails the shipped "You tracked 1h 42m across 2 trusted blocks" shape. It runs in
  the hermetic suite over representative-day fixtures, alongside the timeline eval.
- **Grounding eval.** Every asserted fact in a fixture recap must trace to a
  fixture source; a claim with no supporting source fails. Fixtures extend the
  existing `tests/timeline-eval` format with calendar, attendance, connector, and
  entity records and the expected/prohibited claims and useful questions
  (agent-runtime-and-context.md §Evaluation).

## Build order (shipped together)

The underlying inference model lands in this order, each step pure and testable,
with fixture coverage in `tests/timeline-eval/` and validation against the real
2026-07-20 day:

1. Reconciled website credits everywhere + kind voting on clamped seconds
   (fixes the Netflix-block class of errors).
2. Name guards for agent-surface titles + the entity-first naming ladder.
3. Gap facts + day threads in the day facts and the model-facing compact facts.
4. Completed-day regeneration policy for stored narratives.
5. The common-word redaction fix.
6. The interpretation agent (see
   [agent-runtime-and-context.md](agent-runtime-and-context.md) §Tiered context
   escalation) for the ambiguity deterministic rules cannot resolve.

The recap feature itself is built as one coherent whole, integrated and verified
before it ships, in this internal order so each stage is testable:

1. **Grounded day context** — assemble the day context from all permitted sources
   with provenance and authority order; recap + labels read it. (Delivers DEV-247
   accuracy: recap reads the same corrected facts the timeline shows.)
2. **Voice + honesty** — recap-voice eval; deterministic fallback as a plain
   factual line; no silent failure. (Delivers DEV-275.)
3. **Clarification** — the material-ambiguity detector, the answer-or-skip
   question card, and durable answers → memory/corrections.
4. **External-signal depth** — richer git/calendar grounding through
   `externalSignals.ts` probes and agent-pluggable evidence, reusing the same
   retrieval and disclosure.

## Acceptance

- A recap for a real day reads as something the person could have written, names
  the day's actual work, contains no internal vocabulary, and its total matches
  the timeline.
- Every factual claim traces to a source; scheduling vs attendance vs occurrence
  are not conflated.
- The agent asks only material questions, they can be answered or skipped, and an
  answer changes the account and persists across rebuilds and future days.
- With the model unavailable, the recap degrades to an honest factual line, never
  a template pretending to be prose, and never silently.
- The voice and grounding evals fail the old shapes and pass the new ones.
