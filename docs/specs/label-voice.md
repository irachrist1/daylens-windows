# Label voice

**Status:** Accepted. Follow-up recorded in
[real-day-timeline-apps-reconciliation.md](../tickets/real-day-timeline-apps-reconciliation.md):
"The label voice has a recorded definition, and the labeling path is evaluated
against it in the real-day review."

This specification records the voice of a Timeline block label concretely
enough to score against. [timeline.md](timeline.md) ("Labels and descriptions")
states the principle — a label describes the activity, not the software — and
the reviewed real-day replays showed the principle alone does not hold the
line: block labels kept reading as raw window and video titles or generic
activity phrases, and reviews kept failing on label quality even when block
boundaries were right. This document is the recorded definition; the rules
below are executable, and both the real-day review and the hermetic timeline
evaluation score every produced label against them.

## The voice in one line

A label says what I was doing, in my own everyday words — a short activity
phrase — never the software that hosted it, the artifact title that proved it,
or the telemetry that captured it.

- “Developed the Daylens Wrapped feature”
- “Reviewed ACME’s FY2026–2027 financial report”
- “Researched television upgrade options”
- “Watching a Formula 1 documentary”

## Rules

Every rule is a named, deterministic check in `src/shared/labelVoice.ts`,
returning pass or fail plus the offending fragment. The rules are not only
scored: the label chooser (`finalizedLabelForBlock`) rejects any candidate that
fails an invariant rule, and rejects an interpreted candidate (the AI label, an
artifact title) that reproduces a captured title verbatim or is a bare app
name. A rejected candidate falls to the next in priority; a person's own
override is never touched. The AI labeler gets one corrective retry with the
violation named before the deterministic fallback stands (DEV-276).

Rules come in two tiers:

- **Invariant** rules hold for every produced label, including deterministic
  fallback labels. A violation is a defect in the labeling path.
- **Target** rules are the final voice the labeling path aims for. A
  deterministic fallback label may miss a target rule when evidence is thin;
  every miss is scored and named in review rather than silently absorbed.

### Invariants

| Rule | Requirement | Fails on |
| --- | --- | --- |
| `nonempty-bounded` | A label exists and stays a short phrase: never empty, at most 90 characters and 12 words, no trailing sentence punctuation. | “” · a full sentence ending in a period |
| `no-raw-artifact-forms` | No raw machine forms reach a label: URLs, bare domains, filenames of any kind (code filenames included — DEV-276), JSON fragments, bracketed title fragments, underscore filenames, SCREAMING identifiers, notification counts, browser-tab soup (3+ `\|` segments), trailing browser names. | “https://github.com/…” · “youtube.com” · “handoff.md” · “report_final_v2.xlsx” · “AGENT-EXECUTION-PLAN.md” · “{"questions":[…” · “[Week 1]” · “(3) Inbox” · “W2_Reading \| Intro to ML \| Perusall” · “Docs — Google Chrome” |
| `no-plumbing-or-hype` | Everyday words only: no capture vocabulary (“foreground”, “window title”, “app session”, “captured signal”, “telemetry”, “bundle id”) and none of the assistant voice contract’s banned marketing filler (“deep dive”, “seamless”, “streamline”, …). | “Foreground app sessions” · “Deep dive into metrics” |
| `no-judgment` | A label never judges productivity, focus, distraction, or personal worth. Naming a real focus-timer session stays allowed. | “Unproductive browsing” · “Wasted afternoon” · “Doomscrolling” |
| `leisure-activity-shaped` | A leisure block’s label reads as the activity — “Watching…”, “On…”, “Listening…”, “Browsing…” — never a bare page or video title. | “Big Buck Bunny 4K60” as a leisure label |

### Targets

| Rule | Requirement | Fails on |
| --- | --- | --- |
| `activity-not-software` | The label names what I was doing, never a bare app or browser name, with or without filler. “Cursor,” “Chrome browsing,” and “Editor activity” are fallback evidence labels, not acceptable final labels when Daylens knows the subject. | “Cursor” · “Chrome browsing” · “Slack, Cursor and Warp — activity” |
| `no-verbatim-window-title` | The label never reproduces a captured window or page title verbatim. Titles are evidence inside the block; the label interprets them. | a label equal to any captured window/page title |
| `concrete-over-generic` | When the evidence names a subject (window titles, pages, files), the label names it too — the project, client, meeting, site, or thing worked on. No generic category or fallback label on a block that carries subject evidence. | “Development” · “Misc Tasks” · “Web Session” on an evidence-rich block |
| `short-activity-phrase` | The label reads like a 2–7 word activity phrase, usually verb + object. | “Meeting” (1 word) · an 11-word run-on title |

Entity naming is intentional in `concrete-over-generic`: a label may name a
project, client, person, or meeting only when the block’s evidence supports it
— the same evidence-before-narrative contract every other surface follows.

## How the labeling path is evaluated against this definition

- **Real-day review** (`npm run verify:real-day`): every produced block label
  for the replayed day is scored against every rule. The observation written to
  `candidate.json` / `review.json` carries the per-rule outcome, and the
  `wrapped.md` review document gains a “Label voice” section that names each
  failing label, the rule it failed, and why — so label-quality failures are
  named explicitly during review instead of surfacing only as reviewer
  dissatisfaction. This section is part of the human review that gates
  accepting a private day as a baseline.
- **Hermetic timeline evaluation** (`npm run timeline:eval`): the same checks
  run against the labels the deterministic path produces for the offline
  fixtures. Invariant failures fail the run like the other Target-Design
  invariants; target-tier scores are reported per fixture so the gap between
  fallback labels and the final voice stays visible.
- **Unit suite** (`tests/labelVoice.test.ts`): pins each rule’s pass and fail
  behavior with concrete examples.

## Relationship to other recorded voice

- [timeline.md](timeline.md) “Labels and descriptions” is the source principle;
  this document makes it evaluatable and does not change it.
- The assistant voice contract (`src/main/ai/voiceContract.ts`) and the wrap
  narrative guard (`src/main/lib/wrapNarrativeShared.ts`) govern prose surfaces;
  the banned-vocabulary and no-judgment rules here mirror them at label scale.
- The block observation rule stands: a block may include one short supported
  observation, and it must not judge productivity, focus, distraction, or
  personal worth.
