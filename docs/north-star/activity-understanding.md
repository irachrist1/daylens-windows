# Activity understanding: from evidence to one clear picture

The product goal: describe a day the way the person who lived it would — the
real activity, not the open tabs. The reference failure set is
[gap-analysis-2026-07-20.md](gap-analysis-2026-07-20.md). This document
defines the model that fixes those failures and the order to build it in.

## The core idea: attention is the budget

Every derived number must be creditable to *attention*, and attention is
bounded: one foreground window at a time, ~5s poll resolution. Any pipeline
that can credit more seconds to a domain than the browser was foregrounded
is wrong by construction (Netflix got 1249s inside a block where Dia+Safari
held ~800 foreground seconds — from overlapping browser-history rows summed
raw).

Rules, in order:

1. **Foreground app sessions are the spine.** `app_sessions` (5s poll) is the
   only source that measures attention. Everything else — browser history,
   calendar, git, artifacts — is *context* that explains attention, never a
   source of additional time.
2. **Browser history explains, never adds.** Per-domain credit inside any
   interval = interval-union of that domain's visits, clamped so the sum over
   all domains ≤ the browser app's foreground seconds in that interval.
   Overlapping duplicate rows (chrome_history emits several per second) merge
   by union before any sum. `reconcileWebsiteVisits` exists for this; every
   consumer must go through it — no raw `SUM(duration_sec)` anywhere.
3. **Media domains are ambience unless they own the foreground.** A media
   domain (domainPolicy `entertainment`) gets *activity* status only when the
   browser was foregrounded on it for a sustained run (its page title in the
   foreground title stream, or it holds the majority of the browser's
   clamped budget). Otherwise it is an `aside` ("Netflix was open in a tab"),
   surfaced as ambience, excluded from kind voting. Same for Spotify the
   native app: `passivePresence` already models this for holds; extend the
   concept to classification.
4. **Kind voting uses clamped seconds only.** `resolveBlockKind` currently
   skips browser foreground time and votes with raw website seconds — the
   exact inversion of rule 1. It must vote with reconciled, clamped credits.

## Naming the work: entities above strings

"Cursor Agents" (a window title) appeared in 8 of 12 slides of a day whose
actual project — Daylens — never got named, despite `daylens (Channel)` and a
repo-sync artifact sitting in the evidence. The naming ladder:

1. **Durable entity** (project/client/repo/course), when block evidence maps
   to one through `entities` + aliases: "Daylens", "Andrew Ng's ML course".
2. **Subject inferred from content signals** (`inferWorkIntent`): document
   names, repo names, page titles that name a *thing being worked on*.
3. **App-qualified activity** ("coding in Cursor") — only when 1–2 are empty.
4. Never: agent-surface titles ("Cursor Agents", "New chat - Claude",
   "AI Chat", "Copilot", "✳ Claude Code"). These are *tools talking to
   tools*; add them to `workNameGuards` disqualifiers. When an AI-surface
   title co-occurs with a real subject elsewhere in the block, the subject
   wins; when nothing else exists, fall to tier 3 ("working with AI agents in
   Cursor").

Slack/chat evidence carries subjects too: a persistent channel artifact
("#daylens") is a project alias candidate, not communication noise.

## Interleaving: threads, not fragments

Real days interleave (study interrupted by agent-driving; work punctuated by
comms). Block segmentation by time-contiguity alone either fragments the day
or merges over real seams (the 11:37–14:46 "block" spans an untracked lunch).

- **Within a block**: report the dominant activity plus a bounded set of
  *threads* (secondary activities with ≥15% of block attention), each named
  by the same ladder. "ML course, threaded with Daylens Slack" — one line,
  honest.
- **Across blocks**: the same subject recurring in ≥3 blocks across ≥3 hours
  is a *day thread*; wrap facts get it as a first-class fact ("Daylens ran
  through the whole day: morning fixes, afternoon repo sync, evening CI"),
  so prose can tell the day's real shape.
- **Segmentation seams**: a ≥30 min evidence gap always ends a block. No
  block may span an untracked gap.

## Gaps are facts

Untracked time ≥45 min inside the day's span becomes an explicit `gap` fact
with clock bounds ("17:14–21:24 away from the computer"), cross-referenced
against calendar when available ("matches 'Run' 18:00–20:00"). The narrative
layer already has honesty directives about untracked time; giving it the gap
as a *fact* lets it say something true instead of avoiding the topic (or
worse, implying a continuous grind).

## Freshness: a report is a view of facts, not a snapshot

A stored day narrative whose `facts_hash` no longer matches:

- same-day open → reconcile (current behavior, correct: no churn while the
  day accrues);
- **later-day open → regenerate once.** A completed day whose stored
  narrative was generated mid-day is permanently wrong (2026-07-20 froze at
  10:38am as "short day"). One provider call fixes it forever; after that the
  hash matches.

## Privacy propagation, both directions

- Exclusions must hold everywhere (they do go through
  `filterTrackingExcludedEvidence` on the AI/MCP boundary) — but redaction
  must not over-fire: excluding the app "Messages" currently redacts any
  prose containing the word "messages" (`[excluded]` labels on ordinary
  blocks). Common-word app names need case/context-sensitive matching.

## What the model may see

`compactDayFacts` must feed the model *day facts*, never presentation
artifacts: no "Other" chart bucket as a named surface (the model narrated
"the chart calls it Other"), no self-referential plumbing. If a fact isn't
something a human assistant would say about the day, it doesn't go in the
prompt.

## Build order

1. Reconciled website credits everywhere + kind voting on clamped seconds
   (fixes Netflix-block class of errors) — pure, testable.
2. Name guards for agent-surface titles + entity-first naming ladder.
3. Gap facts + day threads in `DayWrapFacts` and `compactDayFacts`.
4. Completed-day regeneration policy in `getWrappedNarrative`.
5. Redaction common-word fix.
6. Interpretation agent (see [context-agent.md](context-agent.md)) for the
   ambiguity that deterministic rules can't resolve.

Every step lands with fixture coverage in `tests/timeline-eval/` (hermetic)
and is validated against the real 2026-07-20 day via
`tests/wrapped-bench/debug.ts`.
