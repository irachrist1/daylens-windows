# Timeline

**Status:** Accepted.

This specification defines the first V2 Timeline: a calendar-like account of what actually happened during one day.

Timeline is not a list of applications and is not a productivity score. It turns shared activity facts into understandable blocks while preserving the evidence and corrections underneath them.

## Product behavior

The first release opens to one day. It shows:

- what happened
- when it happened
- how long it took
- the project, client, meeting, people, pages, or files involved when known
- honest gaps where Daylens was paused, idle, asleep, locked, unavailable, or uncertain

Week and month Timeline views are outside the first release. Apps still supports day, week, and month ranges.

## Day layout

- The primary layout is a vertical calendar aligned to local wall-clock time.
- The selected day and timezone are always visible.
- A current-day indicator follows the local clock.
- Blocks use their actual start and end positions; visual minimum height never changes the displayed duration.
- Overlapping calendar information is resolved into one chronology rather than a second disconnected lane.
- Personal and entertainment activity appears in the same Timeline and can be filtered or visually softened.
- Empty, partial, live, complete, imported, and capture-unavailable days have explicit states.

The day header shows canonical captured time and the number of meaningful blocks. It does not show a focus or productivity score.

## Timeline block

A block is one contiguous, understandable stretch of activity with a coherent subject or goal.

Each block contains:

- stable block identity
- start, end, and active duration
- direct human label
- live, complete, partial, corrected, or uncertain state
- dominant subject and optional project or client
- involved applications, pages, files, people, meetings, and repositories
- category used for visual organization
- source evidence references
- correction history

Applications and pages are evidence inside a block. They do not automatically define its intent or boundaries.

## Attention accounting

Every derived number must be creditable to *attention*, and attention is bounded: one foreground window at a time, at roughly 5-second poll resolution. Any pipeline that can credit more seconds to a domain than the browser was foregrounded is wrong by construction.

1. **Foreground app sessions are the spine.** `app_sessions` is the only source that measures attention. Everything else — browser history, calendar, git, artifacts — is *context* that explains attention, never a source of additional time.
2. **Browser history explains, never adds.** Per-domain credit inside any interval is the interval-union of that domain's visits, clamped so the sum over all domains never exceeds the browser app's foreground seconds in that interval. Overlapping duplicate rows (browser history emits several per second) merge by union before any sum. `reconcileWebsiteVisits` exists for this; every consumer goes through it — no raw `SUM(duration_sec)` anywhere.
3. **Media domains are ambience unless they own the foreground.** An entertainment domain gets *activity* status only when the browser was foregrounded on it for a sustained run (its page title in the foreground title stream, or it holds the majority of the browser's clamped budget). Otherwise it is an aside ("Netflix was open in a tab"), surfaced as ambience and excluded from kind voting. The same applies to native passive-presence apps such as Spotify.
4. **Kind voting uses clamped seconds only.** A block's work/leisure/personal kind is decided from reconciled, clamped credits — never raw website seconds, which invert rule 1.

## Interleaving: threads, not fragments

Real days interleave. Segmentation by time-contiguity alone either fragments the day or merges over real seams.

- Within a block, the account is the dominant activity plus a bounded set of *threads*: secondary activities with at least 15% of the block's attention, each named by the same ladder as labels. "ML course, threaded with Daylens Slack" — one line, honest.
- Threads are not detours to hide and not reasons to split the block; they are the block's real texture.

## Segmentation

Strong block boundaries are:

- idle, sleep, lock, pause, or capture failure
- the beginning or end of a supported meeting
- a sustained subject, project, or client change
- an explicit split or merge correction
- a long enough unobserved gap that continuity cannot be supported

Brief tool switches, page checks, messages, and supporting research remain inside the surrounding block when their entities and timing support the same activity.

An unobserved gap of 30 minutes or more always ends a block. No block may span an untracked gap; bridging one (a lunch break inside a single "block") propagates invented continuity into every downstream account of the day.

Segmentation is deterministic for the same facts, projection version, and corrections. A model may propose a label or relationship but cannot own durations or silently change block boundaries.

## Labels and descriptions

A label describes the activity, not the software:

- “Developed the Daylens Wrapped feature”
- “Reviewed ACME’s FY2026–2027 financial report”
- “Researched television upgrade options”

“Cursor,” “Chrome browsing,” and “Editor activity” are fallback evidence labels, not acceptable final labels when Daylens knows the subject.

The naming ladder, in strict order:

1. **Durable entity** (project, client, repository, course), when the block's evidence maps to one through entities and aliases: "Daylens", "Andrew Ng's ML course".
2. **Subject inferred from content signals**: document names, repository names, page titles that name a *thing being worked on*.
3. **App-qualified activity** ("coding in Cursor") — only when tiers 1–2 are empty.
4. Never: agent-surface titles ("Cursor Agents", "New chat - Claude", "AI Chat", "Copilot"). These are tools talking to tools; they are disqualified as subjects (`workNameGuards`). When an AI-surface title co-occurs with a real subject elsewhere in the block, the subject wins; when nothing else exists, fall to tier 3 ("working with AI agents in Cursor").

Chat evidence carries subjects too: a persistent Slack channel artifact ("#daylens") is a project alias candidate, not communication noise. No email address ever enters a subject.

A block may include one short observation when it is supported and useful. It must not judge productivity, focus, distraction, or personal worth.

When evidence conflicts, the block states the specific uncertainty naturally and keeps the competing evidence inspectable.

The label voice is recorded as an evaluatable rubric in [label-voice.md](label-voice.md). The real-day review and the hermetic timeline evaluation score produced labels against it.

## Meetings

Meetings are unified Timeline blocks rather than a separate calendar layer.

- A calendar event alone appears as scheduled context, not proof the meeting occurred.
- Device activity, call presence, Granola, transcript, or explicit confirmation can support “you met.”
- A meeting block includes title, participants, organization or client, scheduled and observed times, notes or transcript references, and surrounding related work when permitted.
- A meeting running longer or shorter than scheduled uses observed active time while preserving the scheduled range as context.
- Overlapping calendar events do not create additive time.
- A person can mark a scheduled meeting as attended, skipped, moved, or unrelated.

## Live day

- The current block has stable identity while evidence is still arriving.
- Its end time and duration update without rebuilding unrelated blocks.
- A provisional label may improve as pages, files, connectors, and entities arrive.
- The interface indicates that the block is live without exposing internal confidence scores.
- Finalization after an app switch, meeting edge, idle boundary, or day rollover preserves the block identity when its facts remain the same.
- Restart recovery never extends a live block through an unobserved gap.

## Evidence inspection

Opening a block shows an explanation first, followed by grouped supporting evidence:

- applications
- websites and pages
- files and documents
- meetings and people
- repositories and connected records
- capture and gap state

Evidence displays source, observed time, and relevant relationship. Raw telemetry is available without becoming the block’s primary language. High-sensitivity evidence follows its own access and retention rules.

## Corrections

A person can:

- rename a block
- merge adjacent blocks
- split a block at a selected time
- change category
- assign or remove project and client relationships
- mark meeting attendance
- exclude specific evidence
- permanently delete a record or block
- undo every non-destructive correction

Corrections preview their effect on time, entities, Timeline, Apps, search, and the AI agent before they are applied.

A correction is durable product data. Reprojection, restart, source refresh, and model changes cannot overwrite it.

Permanent deletion is clearly separated from reversible exclusion or correction and requires confirmation.

## Filters

The first day view supports filters for:

- work, personal, entertainment, and other categories
- application or website
- project or client
- person or meeting
- captured, corrected, or uncertain state

Filters never recalculate duration differently. The visible total is the sum of the filtered canonical blocks.

## Data ownership

Timeline reads corrected activity facts through one main-process query boundary. It does not query raw evidence or calculate time in the renderer.

The projection owns:

- block boundaries
- active duration
- entity and meeting relationships
- evidence membership
- gap types
- projection version

The renderer owns layout, interaction, and presentation only.

## Failure behavior

- Missing permission or capture failure produces an explained gap, not fabricated activity.
- A failed interpretation keeps the deterministic block with a direct factual fallback label.
- A failed connector does not remove already captured device activity.
- A projection failure leaves the last valid day readable and offers a retry.
- An empty day distinguishes no activity, paused capture, unavailable capture, and a day outside retained history.
- Conflicting corrections do not apply partially; the command fails atomically.

## Acceptance criteria

- Representative days are recognizable without opening every block.
- Timeline and Apps totals match for the same date and filters.
- Meetings, personal activity, entertainment, idle, pause, sleep, and capture failures appear honestly.
- Labels name the understood activity when evidence supports it.
- Live block identity remains stable through normal updates and finalization.
- Every correction survives restart and reprojection and changes all consuming surfaces.
- Evidence inspection shows provenance without leaking excluded or deleted content.
- Daylight-saving changes, midnight, clock changes, restart, overlapping events, and long gaps have regression coverage.
- The day remains usable with a representative full year stored locally.
- The running application is reviewed with real or representative days on every supported desktop platform.

## Implementation starting point

The first ticket should move live and historical day reads behind one corrected activity-fact query, preserving current UI behavior. New segmentation or visual work begins only after both paths produce the same sessions, totals, gaps, and corrections.
