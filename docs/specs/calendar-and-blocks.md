# Calendar events and tracked blocks

**Status:** Accepted (DEV-273, reviewed with the owner). The running
implementation already matches this model: attendance marks are durable and
undoable with feedback that dismisses itself, they and scheduled events ground
the recap and analysis, the clarification agent asks about unconfirmed meetings,
and scheduled events render as a quieter dashed outline beside the blocks.

Daylens shows two kinds of thing on one timeline: **observed blocks** — what the
device evidence says actually happened — and **scheduled events** — what the
calendar says was planned. Their relationship has never been written down, so
every surface (the click feedback, the overlap rendering, the recap wording, the
re-analysis inputs) was built ad hoc. This spec defines the model once. It
aligns with [agent-runtime-and-context.md](agent-runtime-and-context.md)
(information authority) and [day-recap-and-analysis.md](day-recap-and-analysis.md)
(how the recap grounds in it).

## The one rule

**Observed activity is the truth of what happened; a calendar event is context
about what was planned.** A scheduled event never, by itself, creates a block or
adds a second of tracked time. Presence is proven by device evidence, a matched
meeting-app capture, or the person's own confirmation — never by a calendar row
alone. This is the information-authority order applied to the calendar: a
person's confirmation > device observation > the calendar's scheduled fact.

## How a scheduled event and an observed block over the same time relate

- **Matched** — the event's time overlaps observed meeting-app activity (a
  captured call). The block is the meeting; the event supplies title,
  participants, and the scheduled range as context. Observed active time is the
  block's truth; a meeting that ran long or short uses observed time, with the
  scheduled range shown alongside.
- **Calendar-only, activity present** — the event overlaps tracked work that is
  not a meeting capture. The block stands as the work it was; the event is
  faint scheduled context over it. Daylens does not assert the meeting occurred
  unless the person confirms it (see clarifications).
- **Calendar-only, no activity** — a scheduled event with nothing observed in
  its window. It is scheduled context only, plainly marked "no observed
  activity." It claims no time and is never presented as a thing that happened.
- **Overlapping events never create additive time.** Two calendar events over
  the same hour, or an event over a work block, resolve to one chronology, not
  stacked time.

## Attendance states

A person can mark any scheduled event: **attended**, **skipped**, **moved**,
**unrelated**, or leave it **unmarked**.

- **Attended** is the person's confirmation of presence. It is authoritative:
  it grounds "you were in X" in the recap and analysis even when device evidence
  is thin (a phone call, a room without the laptop).
- **Skipped / moved / unrelated** say the event did not happen as scheduled (or
  was never a real meeting). The day's account excludes it — it is not asserted,
  named, or counted.
- **Unmarked** falls back to the evidence: matched ⇒ treated as occurred;
  calendar-only ⇒ scheduled context, not asserted.

**Feedback and change.** Marking an event gives immediate visible feedback — the
event's state updates in place and a brief confirmation appears and dismisses
itself within a few seconds (the old toast that never dismissed is a defect).
A mark can be changed or cleared at any time; it is durable and survives
rebuilds.

## What attendance and calendar feed

Stated plainly so nothing is implied (the DEV-273 requirement):

- **Re-analyze and recap DO use them.** Scheduled events and their attendance
  marks are grounding inputs to the day-analysis agent: an attended meeting
  grounds a meeting block and the recap's account of it; a calendar-only event
  with no activity is context the recap may mention as planned-but-unobserved,
  never as something that happened. This is wired through the grounded day
  context (day-recap-and-analysis.md §The grounded day context).
- **The clarification agent asks about the ambiguous ones.** A substantial
  scheduled event with no proof it happened and no mark surfaces as an
  answer-or-skip question; the answer writes the durable attendance mark.
- **Blocks:** a matched meeting annotates its block; a scheduled-only event
  never becomes a block and never claims time.

## Visual hierarchy

- **Blocks are the spine** of the day — the full-height cards, read first.
- **Scheduled events are quieter context** rendered in their own column beside
  the blocks (the Google-Calendar side-by-side model), both readable and both
  clickable. An event is never dimmed into illegibility and never collides with
  a block's label; a category filter highlights matches without making anything
  unreadable.
- A calendar-only event with no observed activity is visibly lighter than a
  block — an outline, not a filled card — so the eye reads "planned" vs
  "happened" without a legend.

## Acceptance

- No scheduled event adds tracked time; overlaps resolve to one chronology.
- Every attendance state has a clear meaning, immediate dismissible feedback, and
  is changeable and durable.
- The recap and analysis demonstrably use attendance (an attended meeting is
  named; a skipped one is absent; a calendar-only-no-activity event is never
  asserted to have happened).
- Blocks and events coexist legibly at every zoom, neither obscuring the other.
