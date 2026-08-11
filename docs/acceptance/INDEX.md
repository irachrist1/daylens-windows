# Failure register

Every tracked defect behind the acceptance lines, its true board state, and where
the layers disagree. Read [ACCEPTANCE.md](ACCEPTANCE.md) for the graded lines;
this file is for reconciliation.

Compiled 2026-08-11 from Linear (team DEV, project Daylens V2) and from merged
commits on `factory/v2-ship`.

## Where the layers disagree

Three kinds of drift are live right now. Each one makes a different layer lie.

### 1. The priorities document describes closed defects as current failures

`docs/V2-SHIP-PRIORITIES.md` is written in the present tense about defects that
are Done. Its Timeline section is the clearest case: every failure it lists under
"Today" is closed.

| Described as a live failure | Actual state |
| --- | --- |
| Continuous work split into fragment blocks | DEV-232 Done |
| Selecting blocks and choosing merge does nothing | DEV-233 Done |
| A calendar event overlapping a work block is greyed until unreadable | DEV-234 Done |
| Clicking a week-view event navigates away | DEV-236 Done |
| Day and week views have a single fixed zoom | DEV-235 Done |
| "Re-analyze with AI" always reports "Labels refreshed" | DEV-231 Done |
| The attended confirmation toast never dismisses | DEV-230 Done |
| A block summary duplicated its own wording | DEV-266 Done |
| Recap content is inaccurate and contradicts itself | DEV-247 Done |

The document also points at DEV-232, DEV-233, and DEV-234 under "Tracked in",
which reads as open work.

This matters because `docs/development.md` names `V2-SHIP-PRIORITIES.md` as source
of truth zero — the first thing anyone reads. Reading it today produces a wrong
picture of what remains.

### 2. The board lists issues whose implementation has merged

Seven issues sit in Backlog with merged commits on this branch. `AGENTS.md` rule 4
says Backlog means an open blocker or an unaccepted specification, and Backlog
issues are never worked — so these are both worked and marked unworkable.

| Issue | Title | Commit |
| --- | --- | --- |
| DEV-239 | Junk data is shown as real activity in the Apps view | `bb14bd0b` |
| DEV-240 | Wrong icons, wrong ranking, and hidden hours in the Apps list | `bb14bd0b` |
| DEV-248 | A wrap slide renders broken and export glues all slides into one image | `5cd9aa08`, `11c985cc` |
| DEV-249 | Usage call log clips the date column | `511abf3b` |
| DEV-250 | Settings pages bury their purpose in dense text | `511abf3b` |
| DEV-251 | Screen context claims to be on with no evidence it works | `511abf3b` |
| DEV-252 | Raycast Focus toggle does not persist | `511abf3b` |
| DEV-253 | "Chat about your memory" leads nowhere visible | `511abf3b` |

### 3. Ten issues sit In Review with no execution record

These have no `.sw-factory/` directory, so there is no record of what was planned,
reviewed, or verified for any of them. Two are Urgent.

| Issue | Title | Priority |
| --- | --- | --- |
| DEV-223 | Tracking and retrieval are broken — full-screen / second-monitor time missing or wrong | Urgent |
| DEV-261 | The app must notice and report its own freeze — main-thread stall watchdog | Urgent |
| DEV-224 | Entities — same app shows up twice; merge must be obvious, fast, and stick | High |
| DEV-173 | The real July day reads the same on every surface | — |
| DEV-184 | Files open to the agent in three separate steps | — |
| DEV-177 | Projects, clients, people, and meetings become durable entities | — |
| DEV-175 | Deletion removes everything, everywhere, once | — |
| DEV-176 | Retire the legacy capture tables | — |
| DEV-199 | Fix your day by telling the agent | In Progress |
| DEV-259 | Make development and runtime startup fast again | In Progress |

## Open defects by surface

The work that is genuinely not implemented.

### §01 Timeline

| Issue | Title | State |
| --- | --- | --- |
| — | A live block renames itself repeatedly instead of holding a stable name until it closes | untracked |
| DEV-288 | Stored block labels predating the name guards still say "Cursor Agents" | Backlog |
| DEV-119 | Detours can't distinguish off-task browsing from legitimate learning | Backlog |
| DEV-294 | Load calendar context progressively on the first Timeline open | Todo |

### §02 Apps

| Issue | Title | State |
| --- | --- | --- |
| DEV-237 | "What you did there" app summaries are unreliable | Backlog, High |
| DEV-238 | Half of browser time has no page attached | Backlog, High |
| DEV-290 | History-fill can credit hours of a titleless browser to its last-visited media page | Backlog |

### §03 AI chat

| Issue | Title | State |
| --- | --- | --- |
| DEV-246 | The first numeric answer from chat is wrong | Backlog, High |
| DEV-242 | Model and provider state contradict across the app | Backlog, High |
| DEV-243 | AI tab shows "Loading AI…" on a blank screen every open | Backlog, High |
| DEV-244 | Chat tool activity is a wall of files instead of a clean summary | Backlog |
| DEV-245 | Multi-step AI work shows no structured progress | Backlog |
| DEV-225 | Inspect exactly what the model saw | Backlog |
| DEV-258 | External MCP activity is invisible in the app | Backlog |
| DEV-287 | Wire the interpretation-agent runtime behind interpretationAgentEnabled | Backlog |

### §04 Recaps and wraps

| Issue | Title | State |
| --- | --- | --- |
| DEV-292 | Make the day recap good: an iteration tool over real days, and a budget that lets it finish | Todo — `.sw-factory/DEV-292/`, approved, one item open |

### §05 Settings and elsewhere

| Issue | Title | State |
| --- | --- | --- |
| DEV-289 | Decide: focus score + distraction alerter are spec-removed but fully live | Backlog |
| DEV-293 | Recover legacy local history and keep dev and packaged Daylens on one profile | Todo |

### Foundation

| Issue | Title | State |
| --- | --- | --- |
| DEV-255 | Calendar depends on a third-party CLI instead of native EventKit | Backlog, Urgent |
| DEV-212 | Ship a Developer-ID-signed, notarized macOS updater | Backlog |
| DEV-226 | Windows: full-screen and second-monitor visibility capture | Backlog |
| DEV-207 | The Version 2 acceptance run | Backlog |

## Reference screenshots

None. `V2-SHIP-PRIORITIES.md` refers to reference material in the old external
dossier, including `16-reference-google-calendar/` for the overlapping-event
layout. That material is not in the repository and was not on the machine. Where a
line needs a visual reference, capture it during the grading pass and store it
beside the observation, with no real personal activity in the frame.
