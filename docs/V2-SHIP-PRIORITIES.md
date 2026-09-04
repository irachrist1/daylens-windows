# Shipping Daylens V2

> **Superseded by [docs/V2-PLAN.md](V2-PLAN.md) (2026-09-04)** for V2 scope, status, and priority.
> This document keeps its detail; it no longer sets scope.


**Status:** Active. Maintained against the running desktop application.

Daylens V2 is complete when the desktop experience is dependable: capture is
trustworthy, Timeline and Apps agree on the same day, corrections persist,
search retrieves useful detail, and the AI agent answers real questions from the
same memory. Every planned surface already exists in the shipped application.
What remains is the distance between what each surface does today and what a
person needs it to do.

This document describes that distance, surface by surface. It is judged from the
outside — by what a person sees and can accomplish, not by internal
architecture. A change belongs to V2 when it moves one of the surfaces below
from its current behavior toward its intended behavior.

The graded record of what passes and what fails is the acceptance dossier:
[acceptance/ACCEPTANCE.md](acceptance/ACCEPTANCE.md) (the graded list per surface)
and [acceptance/INDEX.md](acceptance/INDEX.md) (every tracked failure, its true
board state, and where the layers disagree). The dossier is the authority; this
document explains how its entries fit together and where each is tracked in
Linear.

The surface sections below are written in the present tense. They were audited
against the code on 2026-08-14: every failure listed under "Today" either still
reproduces in the code, or is marked as closed with the code that closed it.
Failures that need a person to open the running application to confirm are
marked as such and left standing. The dossier remains the grading authority.

## Timeline

Timeline is a calendar-like account of what actually happened during a day —
understandable blocks of activity aligned to wall-clock time, with the evidence
and corrections underneath them. It is the surface a person looks at first.

**Today**

- Continuous work is split into back-to-back fragment blocks. Capture was healthy
  throughout, so this is segmentation, not a permissions artifact. A block summary
  also duplicated its own wording. Segmentation work has since merged (DEV-232,
  DEV-268, DEV-277, DEV-281, DEV-266); neither symptom has been re-observed in the
  running application.
- A live block renames itself repeatedly during the day instead of holding a
  stable name until it closes. Untracked — no issue covers it.

**Closed since this section was written**

- The "attended" confirmation toast never dismissing (DEV-230). The accepted
  [calendar-and-blocks spec](specs/calendar-and-blocks.md) records the running
  implementation as already matching: attendance marks are durable and undoable,
  with feedback that dismisses itself.
- Merge doing nothing on a multi-block selection. The absence veto now applies
  only to automatic merges; a merge a person asks for goes through, and a merge
  that cannot proceed raises a message at the click instead of failing silently
  (`workBlocks.ts:2172`, `Timeline.tsx:2981`, DEV-233).
- Overlapping events and blocks, and filter dimming. Events render in their own
  column beside blocks with lane geometry, and filters no longer collide labels
  (`Timeline.tsx:249`, `510`, `576`, DEV-234, DEV-286).
- Clicking an event in week view. It opens a popover in place
  (`Timeline.tsx:2422`, `2560`, DEV-236).
- Fixed zoom. Day and week each keep their own persisted zoom, driven by ⌘+ /
  ⌘− / ⌘0 (`Timeline.tsx:75`, DEV-235).
- "Re-analyze with AI" reporting "Labels refreshed" regardless. It now reports
  what it did — re-labeled and merged counts, "All labels already up to date",
  and a reason for anything it could not name (`Timeline.tsx:1675`, DEV-231,
  DEV-278).

**When it's right**

- A block spans a continuous work session and ends only on a real absence,
  sleep, or the start of a meeting. During the live day the session is one block
  that grows with the clock; it is divided into finer, labeled blocks only when
  the person asks for it or the day closes.
- A merge a person asks for always produces one block. If a genuine blocker ever
  exists, the interface states it in plain words at the moment of the click and
  still offers to merge anyway. The merge survives leaving the day and returning.
- A live block keeps its name until it closes and is labeled once, after closing.
- Overlapping events and blocks render side by side in their own columns, both
  readable and both clickable, like Google Calendar. The
  `16-reference-google-calendar/` reference material this line used to cite is
  in the old external dossier and is not in this repository.
  A filter highlights matches without making
  anything else illegible. Clicking a week-view event opens a popup in place.
- Re-analyze reports what it actually did ("Re-labeled 3 blocks" / "Already up to
  date"). The attended toast dismisses itself within a few seconds.

**Decided behavior.** The live day is a single block spanning the time the
laptop has been on, split only where the laptop went absent, asleep, or idle.
That block is divided into smaller labeled blocks only when the person clicks
Analyze-day-with-AI (available once the day holds at least two hours of tracked
time) or when the day ends and a new one begins. The rule that blocked merges
across an absence is removed.

**Tracked in** the open Timeline entries in INDEX §01 — DEV-288 (stored labels
predating the name guards), DEV-119 (detours), DEV-294 (progressive calendar
context), and the untracked live-block renaming. DEV-232, DEV-233 and DEV-234
are Done; do not pick them up.

## Apps

Apps explains where time went, per application, with an expandable per-domain
and per-page breakdown. Its center is the "What you did there" account for each
application — the reason the view exists — and that account is currently wrong.

**Today**

- "What you did there" is unreliable everywhere. It renders raw JSON on screen
  instead of prose for some apps, shows nothing at all for others despite tracked
  time, and generates wrong titles. Even where the layout is clean, the content
  is inaccurate — reporting a duration without being able to say what happened.
  Generate works on some app pages and produces garbage on others. DEV-237,
  still open.
- Large stretches of browser time are unattributed, shown as a dead "No page
  recorded" row running to hours across a week and tens of hours across a month.
  Browser history access reads as unknown. DEV-238 and DEV-290, still open.

**Closed since this section was written**

- Junk data shown as real activity. Sub-few-second visits fold into the
  aggregate (`appDetail.ts:129`), junk strings are caught by
  `src/shared/workNameGuards.ts`, and one install resolves to one identity —
  `src/main/services/entities/appIdentityTwinDedupe.ts` collapses existing twins
  and `appsFacts.ts:55` keeps new ones from forming (DEV-239, DEV-224).
- Wrong icons and untrustworthy ranking. `iconResolver.ts` gained a cross-site
  redirect guard and homepage-first favicon ranking (DEV-240).
- Performance degrading with range, and Generate freezing at thirty days
  (DEV-227). Merged; not re-observed in the running application.

**When it's right**

- Opening any application shows an accurate, plain-language account of what was
  done there — never raw JSON — backed by the per-domain and per-page breakdown
  that the strongest app cards already demonstrate. That layout is the pattern
  everywhere, and Generate produces the same quality on every app and range.
- Browser time resolves to real pages. Where a stretch genuinely cannot be
  attributed, one plain sentence explains why instead of a dead "No page
  recorded" row.
- Junk strings are filtered out, an application never appears twice, and
  sub-few-second visits collapse into a single line. Icons are correct, ranking
  is believable, and nothing with real hours is hidden.
- Load and scrolling are smooth at every range, and Generate never freezes.

**Tracked in** DEV-237 ("What you did there" summaries) and the remaining Apps
entries in INDEX §02.

## AI chat

The AI tab is where a person asks questions about their own day and history. It
must answer correctly on the first try, reach every source Daylens ingests, and
present its work calmly. Today it is wrong in substance and cluttered in
presentation.

**Today**

- The first numeric answer to a per-site duration question is wrong. WO-53
  shipped deterministic fact enforcement, but `DeterministicFactKind` has no
  `site_total_time`, so nothing overrides the model on that question shape
  (`src/main/agent/deterministicFacts.ts:40`). Totals, focus time, per-app time
  and app/site counts are enforced.
- Provider and model state contradict across the app. Settings shows a provider
  connected while the chat's picker says it is not installed, and chats keep
  running on a previously saved model regardless of the switch.
- Tool activity is presented as a wall of every file touched, under the label
  "what the AI saw." Context attached to a message does not scale with the
  question — nothing in `contextPacket.ts` or `chatAgent.ts` treats a greeting
  differently. Citations render as raw filenames with hashes.
- The tab shows "Loading AI…" on a blank screen for several seconds on every
  open, and sometimes sticks there (`AIWorkspace.tsx:451`).
- Answers need work in tone and clarity beyond correctness: unclear phrasing and
  responses that are sometimes flatly wrong.

**Closed since this section was written**

- The chat reaching calendar and Granola. `get_calendar_events` and
  `read_meeting_notes` are registered agent tools
  (`src/main/agent/contextTools.ts:62`, `86`), alongside `get_git_activity`
  (DEV-241, DEV-256).

**When it's right**

- The first answer to a factual question is the correct number, grounded in the
  same facts Timeline and Apps show.
- Every source Daylens ingests — calendar, Granola, connectors — is reachable by
  the chat.
- Provider and model have one source of truth, shown identically in Settings and
  the chat picker. A provider either works for chat or is not offered.
- Tool activity is a collapsed one-line summary that expands on demand, with
  inline status as the agent works — never a wall of file chips. Context attached
  to a message scales with what the question needs; a greeting attaches nothing.
- The tab opens instantly.

**Tracked in** DEV-246 (first numeric answer), DEV-242 (provider and model
state), DEV-244 (tool-activity presentation), DEV-243 (blank AI tab), and the
remaining AI entries in INDEX §03.

## Recaps and wraps

A recap tells the story of a day or week; a wrap presents it as shareable slides.
Both must be grounded in the same numbers the rest of the app shows.

**Today**

- Stored Wrapped narratives do not re-voice when the recap tone changes. Voice is
  deliberately kept out of `factsHash`, so a tone change writes no invalidation
  reason. A correct fix needs a stored-voice column.

**Closed since this section was written**

- Recap content contradicting itself, omitting the day's main activity, and
  ranking a raw date string as an activity (DEV-247, DEV-279, DEV-280, and the
  voice lane's WO-99 through WO-107).
- Wrap export gluing every slide into one image. `src/main/services/wrapSlideExport.ts`
  writes one PNG per slide into a fresh folder, with the disk guarantees covered
  by `tests/wrapSlideExportFiles.test.ts` (DEV-248).
- The broken wrap slide render (DEV-248). Not re-observed in the running
  application.

**When it's right**

- Recaps use the same numbers Timeline shows, never contradict themselves within
  one screen, never surface raw dates or internal labels as activities, and name
  the day's dominant activities.
- Slides render cleanly, and export saves each slide as its own image.

**Tracked in** DEV-292 (INDEX §04). DEV-247 is Done.

## Settings

Settings must state what each page does in plain words and behave predictably.

**Today**

- Screen context reports itself on while its extraction is not installed. Issue
  #73 was re-confirmed against the running application on 2026-08-11, after the
  Settings rebuild below. The Settings page now renders the backlog and
  quarantine honestly; what it says about sampling is still wrong.
- Several pages bury their function under paragraphs of filler, and a toggle
  turning itself back off after navigation, both addressed in `511abf3b` but
  neither re-observed in the running application.

**Closed since this section was written**

- "Chat about your memory" leading nowhere. It now stashes a seed prompt and the
  AI tab sends it as the first message of a new thread
  (`src/renderer/lib/aiSeed.ts`, DEV-253).
- Screen context having no evidence it works.
  `src/renderer/views/settings/ScreenContextSection.tsx` shows the frame backlog,
  per-frame state, quarantine, and explicit Retry/Delete (DEV-251).

**When it's right**

- Every page says what it does in the fewest words a person needs.
- Toggles keep their state. Buttons produce a visible result. A page shows real
  evidence it is working, or does not claim to be on.

**Tracked in** the Settings entries in INDEX §05.

## Legibility across every surface

Timeline, Apps, AI, and Settings are word-dense and cluttered with no gain to the
person reading them. This is a product-quality bar, not a cleanup pass deferred
to the end: the application should do things, not describe them. Each surface
above is finished only when it is legible — fewer words, clearer layout, and
information presented at the moment it is useful rather than stacked. The
acceptance line "every settings page says what it does in plain words, without
paragraphs of filler" applies, in spirit, to all of them.

## Sequence

The surfaces are worked in this order, because each depends on the day beneath it
being right:

1. **Timeline** — the day must read correctly and be correctable before anything
   built on it can be trusted.
2. **Apps** — the per-application account of the same day.
3. **AI chat** — answers drawn from a day that Timeline and Apps now agree on.
4. **Recaps and wraps** — narratives over a corrected, agreed day.
5. **Settings and the remaining surfaces** — legibility and predictable behavior
   throughout.

Foundation work — capture reliability, cost controls, startup performance — is
in service of these surfaces, not a substitute for them. It is finished when the
acceptance lines it supports pass, and it does not displace the surface work
above.
