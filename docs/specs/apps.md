# Apps

**Status:** Accepted.

This specification defines Apps as an explanation of what happened inside each application and how that activity connected to pages, files, meetings, projects, clients, and Timeline blocks.

Apps is not a leaderboard of software usage and does not judge whether time was productive.

## Product behavior

Apps supports day, week, and month ranges in the first V2 release.

The overview answers:

- Which applications were involved?
- How much canonical active time belonged to each one?
- What was done inside each application?
- Which projects, clients, meetings, pages, and files were connected to that time?
- How did the selected period differ from the preceding comparable period?

The same filters and facts used by Timeline and the AI agent apply here.

## Overview

Each application row shows:

- canonical application name and local icon
- total active time
- direct explanation of the main activity
- main projects, clients, meetings, pages, or files
- change from the preceding comparable range when available
- capture, correction, or missing-context state when it materially affects the result

Rows are ordered by active time by default. Search and filters can narrow by application, category, project, client, person, meeting, and work or personal activity.

The overview does not show focus scores, distraction labels, or rankings of personal value.

## Application identity

- Platform bundle, executable, profile, and normalized identities resolve to one canonical application.
- Browser profiles retain distinct source identity but roll up to one browser by default.
- Renamed or rebranded applications preserve historical continuity.
- Two applications are never merged from display-name similarity alone.
- A person can correct an application identity or keep two instances separate.
- Icons come from the installed application or approved local cache; icon lookup never sends activity to a third party.

## Active time

Apps consumes canonical corrected intervals.

- One second belongs to no more than one foreground application.
- Idle, sleep, lock, pause, capture failure, and unobserved gaps contribute no application time.
- A browser page explains browser time but does not add to it.
- Meetings running inside an application may explain that interval without becoming additive time.
- Corrections and permanent deletion change Apps and Timeline together.
- The range total equals the union of visible corrected application intervals under the selected filters.

## Browser behavior

A browser is a container application.

The browser detail view groups its owned time by:

- website and page
- project and client
- category
- related Timeline block
- browser profile when requested

Website duration is clipped to the browser's input-focused intervals and to that same browser's full-screen / second-monitor visible spans. Visible page time is presence, not another application total — it does not add to the browser's foreground figure. Browser history with no foreground overlap and no visible presence for that browser may support retrieval but contributes no active time.

Page and website totals cannot sum to more than the browser's combined in-front plus second-display-visible time for the same range. Unattributed browser time is shown explicitly as browser time without verified page context. When Daylens has the browser on a second display but almost no page, it says so — it does not pretend the 10-minute history row was the morning.

## Application detail

An application detail view contains:

- total active time and range comparison
- day-by-day trend within week or month ranges
- plain-language account of the main work
- projects and clients
- pages, files, documents, meetings, people, and repositories
- related Timeline blocks
- corrected and unattributed time
- representative questions for the AI agent

The explanation should say “You developed the Daylens Wrapped feature” or “You reviewed ACME’s financial report,” not merely “Cursor was active” or “You used Chrome.”

## Projects and clients

Projects and clients remain reusable filters and entity links rather than top-level tabs.

- An application interval may relate to several supporting entities but has one non-additive duration.
- Project and client totals use attributed interval overlap, not a sum of application totals.
- An uncertain relationship is shown as suggested and does not silently change totals.
- Explicit attribution corrections outrank inference everywhere.

## Range behavior

### Day

Shows applications and their activity for one local day — the same owned-day window Timeline uses, so a sitting that crosses midnight stays on the day that started it.

### Week

Shows seven local calendar days ending on the selected date. The comparison range is the preceding seven days.

### Month

Shows one local calendar month. The comparison range is the preceding calendar month and is labeled with its actual length.

Custom ranges are outside the first V2 release.

Partial current periods are compared with the equivalent elapsed portion of the preceding period rather than a complete period.

## Corrections and evidence

Apps links to the same correction commands as Timeline. A person can correct application identity, category, project, client, page ownership, or exclude and delete evidence.

Opening an explanation reveals supporting intervals and evidence. The interface does not expose duplicate raw rows or internal confidence numbers.

## Failure behavior

- Missing page context appears as unattributed browser time.
- Missing application identity uses a stable unknown identity rather than dropping time.
- A failed explanation keeps deterministic totals and relationships visible.
- A failed icon lookup uses a local fallback without affecting identity.
- A partial period states that it is partial.
- A corrected or deleted interval invalidates every cached range containing it.
- An unavailable model does not disable Apps.

## Acceptance criteria

- Day totals reconcile exactly with Timeline under identical filters.
- Week and month totals equal the union of their corrected daily intervals.
- Browser pages never create additive time or exceed browser totals.
- Personal, entertainment, work, meeting, idle, and unattributed cases have representative fixtures.
- Application identity is stable across profiles, renames, restart, and platform-specific source labels.
- Explanations name the understood activity when evidence supports it.
- Corrections and deletion update overview, detail, Timeline, search, and the AI agent.
- Apps remains fully useful without a model provider.
- With a representative year stored locally, day and month totals compute within 100 ms and year-scope aggregates within 500 ms at the 95th percentile (`npm run bench:queries` documents the basis), and each range view is interactive within 1 second of navigation.
- Day, week, and month views are reviewed in the running application on supported desktop platforms.

## Implementation starting point

The first ticket should route the Apps overview and detail totals through the same corrected activity-fact query used by Timeline. It should add reconciliation tests before changing the visible design or generated explanations.
