# Shipping Daylens V2

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

The surface sections below are written in the present tense against the state of
the application when they were recorded. Several of the defects they describe have
since closed. The dossier, not this document, is current on what still fails.

## Timeline

Timeline is a calendar-like account of what actually happened during a day —
understandable blocks of activity aligned to wall-clock time, with the evidence
and corrections underneath them. It is the surface a person looks at first, and
today it misrepresents the day and resists correction.

**Today**

- Continuous work is split into back-to-back fragment blocks. One morning of
  building split into "daylens Channel", "ChatGPT", and "Screen & System Audio
  Recording"; another day showed four consecutive duplicate "Working on Cursor
  Agents" blocks. Capture was healthy throughout, so this is segmentation, not a
  permissions artifact. A block summary also duplicated its own wording ("Spent
  37m spent on ChatGPT").
- Selecting two or more blocks and choosing merge does nothing — no merge, no
  error, no feedback of any kind. The cause is a rule that refuses to join
  blocks separated by fifteen minutes or more of absence, and the refusal never
  reaches the interface.
- A live block renames itself repeatedly during the day instead of holding a
  stable name until it closes.
- A calendar event overlapping a work block is greyed until unreadable. Turning
  on a category filter dims non-matching blocks so heavily that their labels
  collide with event labels, producing overlapping unreadable text.
- Clicking an event in week view navigates away to that day instead of opening
  details in place. Day and week views have a single fixed zoom.
- "Re-analyze with AI" returns in under a second and always reports "Labels
  refreshed," whether or not any analysis ran. The "attended" confirmation toast
  never dismisses.

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
  readable and both clickable, like Google Calendar (references in the dossier's
  `16-reference-google-calendar/`). A filter highlights matches without making
  anything else illegible. Clicking a week-view event opens a popup in place.
- Re-analyze reports what it actually did ("Re-labeled 3 blocks" / "Already up to
  date"). The attended toast dismisses itself within a few seconds.

**Decided behavior.** The live day is a single block spanning the time the
laptop has been on, split only where the laptop went absent, asleep, or idle.
That block is divided into smaller labeled blocks only when the person clicks
Analyze-day-with-AI (available once the day holds at least two hours of tracked
time) or when the day ends and a new one begins. The rule that blocked merges
across an absence is removed.

**Tracked in** DEV-232 (fragment blocks), DEV-233 (merge does nothing),
DEV-234 (overlap and filter legibility), and the remaining Timeline entries in
INDEX §01.

## Apps

Apps explains where time went, per application, with an expandable per-domain
and per-page breakdown. Its center is the "What you did there" account for each
application — the reason the view exists — and that account is currently wrong.

**Today**

- "What you did there" is unreliable everywhere. Notion renders raw JSON on
  screen instead of prose. Safari shows nothing for nineteen minutes of tracked
  time. Generated titles are wrong. Even where the layout is clean, the content
  is inaccurate — reporting fifteen minutes on an app "mostly between 10 and 11"
  without being able to say what happened. Generate works on some app pages and
  produces garbage on others.
- Large stretches of browser time are unattributed: one browser showed "No page
  recorded — 11h 21m" over seven days, and over forty hours across thirty. Safari
  history access reads as unknown.
- Junk data appears as real activity: a keyboard-mash string shown as a
  fourteen-minute page, one- and two-second visits given their own rows, and the
  same application listed twice as two separate entries.
- Icons are wrong and ranking is untrustworthy — one app ranks first with the
  wrong icon while another with several tracked hours is buried off-screen.
- Performance degrades with range. Seven days is acceptable; thirty days lags
  while scrolling; Generate at thirty days freezes the machine.

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

- The first numeric answer is wrong. Asked how long was spent on a learning site
  this week, it answered ten minutes, then corrected to three hours and
  forty-three minutes only after being pushed — both from the same local data.
  Most people will not push back.
- The chat cannot reach calendar or Granola data. No calendar or Granola tool is
  registered for the agent, so "What's on my calendar tomorrow?" is answered with
  "I have no such tool," even though Timeline itself shows calendar events.
- Provider and model state contradict across the app. Settings shows a provider
  connected while the chat's picker says it is not installed, and chats keep
  running on a previously saved model regardless of the switch.
- Tool activity is presented as a wall of every file touched — dozens of chips,
  including unrelated personal notes for a simple question — under the label
  "what the AI saw." The full context packet attaches to every message,
  including "hi." Citations render as raw filenames with hashes.
- The tab shows "Loading AI…" on a blank screen for several seconds on every
  open, and sometimes sticks there.
- Answers need work in tone and clarity beyond correctness: unclear phrasing and
  responses that are sometimes flatly wrong.

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

- Recap content is inaccurate and contradicts itself. A day's recap omitted the
  evening that was its main activity, reported study hours that started late, and
  a weekly summary ranked the raw string "2026-07-20" as an activity. A daily
  wrap showed one total in its header while its prose described a different one.
- A wrap slide rendered nearly invisible with the timeline bleeding through and
  buttons overlapping, and exporting a wrap glued every slide into one image.

**When it's right**

- Recaps use the same numbers Timeline shows, never contradict themselves within
  one screen, never surface raw dates or internal labels as activities, and name
  the day's dominant activities.
- Slides render cleanly, and export saves each slide as its own image.

**Tracked in** DEV-247 and INDEX §04.

## Settings

Settings must state what each page does in plain words and behave predictably.

**Today**

- Several pages bury their function under paragraphs of filler.
- A toggle turns itself back off after navigating away and returning.
- "Chat about your memory" merely navigates to the AI tab with no visible effect.
- Screen context reports itself on while admitting its extraction is not
  installed, and its diagnostic button produces no visible result.

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
