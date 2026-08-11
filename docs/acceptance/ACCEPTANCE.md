# Acceptance

The acceptance lines per surface, in the order
[V2-SHIP-PRIORITIES.md](../V2-SHIP-PRIORITIES.md) works them. Each line is the
"When it's right" behavior from that document, restated as something a person can
check by using the application.

States are defined in [README.md](README.md). `landed` means merged with no
running-application evidence, and it is not a pass.

Graded 2026-08-11. Board states read from Linear; `landed` derived from merged
commits on `factory/v2-ship`.

## Summary

| Surface | Lines | passing | landed | open | executing |
| --- | --- | --- | --- | --- | --- |
| Timeline | 6 | 0 | 5 | 1 | 0 |
| Apps | 5 | 0 | 3 | 2 | 0 |
| AI chat | 5 | 0 | 1 | 4 | 0 |
| Recaps and wraps | 3 | 0 | 3 | 0 | 0 |
| Settings | 5 | 0 | 5 | 0 | 0 |
| **Total** | **24** | **0** | **17** | **7** | **0** |

No line is `passing`. Seventeen lines have merged implementations that nobody has
confirmed against the running application. That distance is the honest state of
V2, and closing it is a grading pass, not more code.

## Timeline

| # | Acceptance line | State | Tracked | Evidence |
| --- | --- | --- | --- | --- |
| 1 | A block spans a continuous work session and ends only on a real absence, sleep, or the start of a meeting | `landed` | DEV-232, DEV-268, DEV-281 (Done) | — |
| 2 | The live day is one block that grows with the clock, split only on absence, sleep, or idle; divided into labeled blocks only on Analyze-day-with-AI (once the day holds 2h) or when the day ends | `landed` | DEV-232, DEV-277 (Done) | — |
| 3 | A merge a person asks for always produces one block, states any blocker in plain words at the moment of the click, and survives leaving the day and returning | `landed` | DEV-233, DEV-282, DEV-257 (Done) | — |
| 4 | A live block keeps its name until it closes, and is labeled once, after closing | `open` | unmapped | — |
| 5 | Overlapping events and blocks render side by side in their own columns, both readable and clickable; a filter highlights matches without making anything illegible; clicking a week-view event opens a popup in place | `landed` | DEV-234, DEV-236, DEV-286, DEV-264 (Done) | — |
| 6 | Re-analyze reports what it actually did; the attended toast dismisses itself within a few seconds; day and week views have zoom | `landed` | DEV-231, DEV-230, DEV-278, DEV-235 (Done) | — |

Line 4 has no issue tracking it. `V2-SHIP-PRIORITIES.md` records the failure — "a
live block renames itself repeatedly during the day instead of holding a stable
name until it closes" — and none of the closed Timeline issues covers it.

## Apps

| # | Acceptance line | State | Tracked | Evidence |
| --- | --- | --- | --- | --- |
| 1 | Opening any application shows an accurate, plain-language account of what was done there, never raw JSON, and Generate produces the same quality on every app and range | `open` | DEV-237 (Backlog) | — |
| 2 | Browser time resolves to real pages; where a stretch genuinely cannot be attributed, one plain sentence explains why | `open` | DEV-238, DEV-290 (Backlog) | — |
| 3 | Junk strings are filtered out, an application never appears twice, and sub-few-second visits collapse into a single line | `landed` | DEV-239 (Backlog — board stale) | commit `bb14bd0b` |
| 4 | Icons are correct, ranking is believable, and nothing with real hours is hidden | `landed` | DEV-240 (Backlog — board stale) | commit `bb14bd0b` |
| 5 | Load and scrolling are smooth at every range, and Generate never freezes | `landed` | DEV-227 (Done) | — |

## AI chat

| # | Acceptance line | State | Tracked | Evidence |
| --- | --- | --- | --- | --- |
| 1 | The first answer to a factual question is the correct number, grounded in the same facts Timeline and Apps show | `open` | DEV-246 (Backlog) | — |
| 2 | Every source Daylens ingests — calendar, Granola, connectors — is reachable by the chat | `landed` | DEV-241, DEV-256 (Done) | — |
| 3 | Provider and model have one source of truth, shown identically in Settings and the chat picker; a provider either works for chat or is not offered | `open` | DEV-242 (Backlog) | partial: commit `28262c39` moves provider connection through every surface |
| 4 | Tool activity is a collapsed one-line summary that expands on demand, with inline status as the agent works; context attached scales with the question | `open` | DEV-244, DEV-245, DEV-225 (Backlog) | — |
| 5 | The tab opens instantly | `open` | DEV-243 (Backlog) | — |

## Recaps and wraps

| # | Acceptance line | State | Tracked | Evidence |
| --- | --- | --- | --- | --- |
| 1 | Recaps use the same numbers Timeline shows, never contradict themselves within one screen, never surface raw dates or internal labels as activities, and name the day's dominant activities | `landed` | DEV-247, DEV-280, DEV-279 (Done) | — |
| 2 | Slides render cleanly, and export saves each slide as its own image | `landed` | DEV-248 (Backlog — board stale) | commits `5cd9aa08`, `11c985cc` |
| 3 | Generate recap produces a recap, and it finishes on a heavy, fully-enriched day | `landed` | DEV-292 (Todo → ready for In Review) | `.sw-factory/DEV-292/review-log.md` — 4/4 variants completed on a 13-block real day, 7.03-13.4s, voice-clean; all five spec acceptance lines met over two review rounds |

Line 3 is the closest thing to a pass in this dossier. It is not graded `passing`
because the evidence comes from the recap lab, which renders a panel mock to the
terminal; the recap has not been observed in the application's own Timeline panel.
Clicking Generate recap once closes it.

## Settings

Every line below was implemented in commit `511abf3b` (DEV-249 through DEV-253),
and every one of those issues still sits in Backlog. The board is stale for all
five.

| # | Acceptance line | State | Tracked | Evidence |
| --- | --- | --- | --- | --- |
| 1 | Every page says what it does in the fewest words a person needs | `landed` | DEV-250 (Backlog — board stale) | commit `511abf3b` |
| 2 | Toggles keep their state across navigation | `landed` | DEV-252 (Backlog — board stale) | commit `511abf3b` |
| 3 | Buttons produce a visible result — "Chat about your memory" does something | `landed` | DEV-253 (Backlog — board stale) | commit `511abf3b` |
| 4 | A page shows real evidence it is working, or does not claim to be on — screen context | `landed` | DEV-251 (Backlog — board stale) | commit `511abf3b` |
| 5 | The usage call log does not clip its date column | `landed` | DEV-249 (Backlog — board stale) | commit `511abf3b` |

## Legibility

Cross-cutting, and not gradeable as a single line. `V2-SHIP-PRIORITIES.md` holds
it as a product-quality bar applying to every surface above: "the application
should do things, not describe them." A surface is finished only when it is
legible, so this is graded inside each surface's pass rather than after all of
them.

## Foundation

Not surfaces, and they do not displace surface work. Listed because acceptance
lines above depend on them.

| Item | State | Tracked |
| --- | --- | --- |
| Calendar reads native EventKit rather than a third-party CLI | `open` | DEV-255 (Backlog, Urgent) |
| The app notices and reports its own freeze | `landed` | DEV-261 (In Review) |
| Development and runtime startup are fast again | `open` | DEV-259 (In Progress) |
| A Developer-ID-signed, notarized macOS updater ships | `open` | DEV-212 (Backlog) |
| Windows full-screen and second-monitor capture | `open` | DEV-226 (Backlog) |
| The real July day reads the same on every surface | `landed` | DEV-173 (In Review) |
