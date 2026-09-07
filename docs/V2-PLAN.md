# Daylens V2

**Status:** Accepted product direction.

**The only planning document.** Scope, status, blockers, and acceptance criteria.
Everything else was deleted on 2026-09-04 — it was stale, contradicted itself, or
duplicated a tracker. Product behaviour lives in `docs/specs/`; how to build and ship
lives in `docs/operations/`. Nothing else plans V2.

**Linear project Daylens V2 is the backlog.** This document is the plan; it does not
duplicate the backlog. GitHub Issues exist for people outside the project to report
things, and get triaged into Linear.

Issue references below are Linear `DEV-nnn`. A bare `#nn` means `spcsorg/daylens`;
`irachrist1#nn` is the older personal repo, which still holds open PRs — the two
repositories number their issues independently, so a bare `#nn` is ambiguous unless
qualified.

---

## On the board

```
DAYLENS — WHAT WE ARE FIXING

The one test:   npm run eval:days
   names the work        85%  ->  95%
   never names a tool    97%  ->  99%
   honest about gaps     95%  -> 100%

 1  NAME THE WORK, NOT THE TOOL      <- biggest gap
 2  COUNT THE TIME HONESTLY
 3  MAKE IT FAST                     <2s launch, <200ms paint
 4  THE APPS VIEW MUST BE TRUE
 5  CHAT: FAST, AND NEVER CONTRADICTS ITSELF

Cannot ship without:  Windows cert · billing live · calendar off icalBuddy

Done = a stranger opens their day and it reads true.
```

Everything below is the detail behind those five lines. If the two ever disagree,
the board is the promise and the detail is what is currently known.

---

## What V2 is

**Daylens describes your day the way you would.** Not the tabs you had open — the work you
actually did.

That is one measurable thing, and the measurement already exists. `npm run eval:days` scores
19 ground-truth days against the journal the owner actually wrote. Today:

```
primary work named:   85%   (threshold 85%)
tool-surface clean:   97%   (threshold 95%)
gap honesty:          95%   (threshold 95%)
```

Two of three are sitting exactly on their floor. What that percentage means in practice, from
today's run:

```
✗ primary work never named anywhere visible: TARS (chief-of-staff skill, npm publish, landing page)
✗ primary work never named anywhere visible: ML study (Coursera)
✗ block label is a tool surface, not work: "Cursor Agents"      ×6
✗ block label is a tool surface, not work: "ChatGPT"            ×4
✗ block label is a tool surface, not work: "Claude Code"
✗ wrapped line presents banned-as-work "claude": "Claude quietly took 22m today."
```

You spent a day building TARS and the app said "Cursor Agents". That is the product failing at
the only thing it claims to do.

**V2 ships when the eval reads 95 / 99 / 100 and a stranger's day reads true on first open.**

The model that gets there is written down: [activity understanding](north-star/activity-understanding.md)
and [the context agent](north-star/context-agent.md). Both were deleted by accident in
`d5cdcdbe` — a commit about eval plumbing — and are restored.

---

## The five blockers

Ranked by how much each moves the score above. Issue IDs are Linear `DEV-nnn` and
`spcsorg/daylens#nn` — both, always, so the trackers and this document cannot drift.

### 1. The day is named after tools instead of work

The single biggest gap: 15% of primary work is never named, and tool surfaces still leak into
labels. `activity-understanding.md` gives the naming ladder — durable entity, then subject
inferred from content signals, then never the tool.

- **DEV-287 / #109** — **the ticket is out of date: the runtime is wired.**
  `analyzeDay.ts:220` reads `interpretationAgentEnabled(getSettings())` and calls
  `runInterpretationAgentRelabel`, with a Settings toggle at `Settings.tsx:3197`. It is
  OFF by default. The open work is not wiring it — it is turning it on and proving it beats
  the legacy path on the eval, then making that the default. This is still the build that
  moves primary-work naming.
- **DEV-288 / #110** — **the backfill is in place.** `labelGuardRepair` rewrites stored
  `timeline_blocks` labels that fail today's work-name guards on startup, once per
  `WORK_NAME_GUARD_VERSION`. The finalize ladder also rejects those labels on read, so a
  compacted window title (`Cursor Agents — daylens …`) cannot persist as the block name
  after the stamp. Remaining naming work is DEV-287 (turn the interpretation agent on).
- **DEV-223 / #21** — Timeline, Apps, chat and exports disagree about the same day.

**Done when:** `npm run eval:days` reports primary work ≥95% and tool-surface clean ≥99%, and
no block on any of the 19 ground-truth days is labelled with an app or assistant name.

### 2. Time is credited to the wrong thing

`activity-understanding.md` states the rule: **attention is the budget.** One foreground window
at a time. Anything that credits more seconds to a domain than the browser was foregrounded is
wrong by construction. Netflix once took 1249s inside a block where the browsers held ~800
foreground seconds.

- **DEV-246 / #68** — "how long was I on Coursera this week" returned the wrong first number
  because the name was looked up as an app and per-site duration was left to the model.
  Domain-time questions now resolve through website lookup and a computed `site_total_time`.
- **DEV-290 / #112** — `HISTORY_FILL_MAX_MS` lets a titleless browser credit up to 4h to its
  last-visited page, usually Netflix or YouTube. The original ticket said to populate
  `browser_context_events`; that table was dropped (`migrations.ts:2071`). The restated
  fix is: persist Chromium `active_browser_context` when history corroborates an
  unverifiable-mode tab, and cap uncorroborated entertainment history-fill on titleless
  browsers at two minutes.
- **DEV-238 / #60** — half of browser time has no page attached.

**Done when:** no domain's credited seconds exceed its browser's foreground seconds in the same
interval, on all 19 eval days; and ten random domain-time questions match `website_visits`.

### 3. Startup and navigation are slow

**DEV-259 / irachrist1#253** measured this and fixed the dominant cost — a 5.7s unconditional
`PRAGMA integrity_check` before `createWindow()`, now a 1.2s `quick_check` that escalates only
on a real fault. Dev launch went ~12s → ~6.6s. Left from that issue's own checklist:

- **~1.1s of eager module eval** at Electron ready. The AI SDK and ExcelJS load at top level, on
  the paint path. Lazy-import them.
- **DEV-261 / #83** — the app freezes for minutes and silently stops recording. Half done:
  `stallWatchdog.ts:135` captures `main_thread_stalled` to telemetry, but nothing writes a
  marker the day itself can show, which is what the acceptance below asks for.

Measured 2026-09-04 on the real 1.19GB profile (`npm run bench:surfaces`):
`getTimelineDayPayload` 111-166ms, `getAllAppsForLabeling` 16-53ms. **The database is not the
bottleneck — do not spend time on SQL here.**

**Done when:** cold launch to an interactive Timeline under 2s; Timeline → Apps → Chat paints
under 200ms; a stall over 5s writes a marker the day can show.

### 4. Apps view lies about what you did there

- **DEV-237 / #59** — summaries are unreliable: raw JSON on screen, empty summaries where time
  was tracked, invented specifics.
- **DEV-239 / #61** — junk strings shown as activity; the same app twice; 1-2s visits get rows.
- **DEV-240 / #62** — wrong icons, unbelievable ranking, real hours hidden from the main list.

**Done when:** Apps opens in under 500ms; the five most-used apps at Today / 7d / 30d each show a
summary matching what you remember; each app appears once; short visits collapse to one line.

### 5. AI chat is slow and contradicts itself

- **DEV-243 / #65** — "Loading AI…" on a blank screen every open. `AIWorkspace.tsx:451` returns
  early while `settings` and `hasApiKey` are null, so nothing renders — not even the input box.
- **DEV-242 / #64** — provider and model state disagree between Settings and the chat picker.
- **DEV-292 / #114** — the day recap times out on two stacked 15s timeouts, with model-tier
  selection that does not do what it claims. One measured budget, following `NARRATIVE_TIMEOUT_MS`.
- **DEV-244 / #66**, **DEV-245 / #67** — tool activity is a wall of files; no structured progress.

**Done when:** the chat paints its input under 200ms before settings resolve; first token under
2s; opening repeatedly never blanks; switching provider changes the next answer.

## Chores that gate distribution

Real, required to release, felt by nobody until release day.

- **Windows code-signing certificate.** Azure Trusted Signing, ~$10/month.
  `release-windows.yml:100` hard-fails without it and `updater.ts:218` disables updates.
  Owner action.
- **Billing via pawapay** while the Flutterwave application is in progress. No checkout can
  render today: `DAYLENS_BILLING_API_URL` is never set and no service is deployed.
- **CI lives on `spcsorg`.** Blacksmith is installed on the org, not the personal account.
- **DEV-487, the morning/evening crash.** Rare, and now self-reporting — the frame goes to
  PostHog. Screenshot it when it fires.
- ~~**DEV-229 / #51** — trusts the accessibility flag instead of verifying capture works.~~
  **Shipped.** `services/permissionWatcher.ts` verifies with real reads and
  `getCaptureVerificationState` exposes it. Linear says Done; GitHub #51 is still open and
  should be closed.
- **DEV-255 / #77** — calendar on macOS now reads EventKit through `calendar-helper`
  instead of icalBuddy. Windows still uses Outlook COM; Linux has no store. Needs
  acceptance on a Mac: events after one Calendar prompt, no CLI installed.
- **DEV-289 / #111** — focus score and distraction alerter are spec-removed but fully live.
  Needs a decision, not code.
- **DEV-207** — the V2 acceptance run. The gate itself; it cannot pass until the five close.

## Where the code actually is

**Works.** Calendar and Granola agent tools · Timeline merge, zoom, week popover ·
per-slide wrap export · screen-context honesty pane · corrupt-database recovery with
restore/fresh/quit · readable memory mirror · the 5.7s startup integrity scan, fixed.

**Half-built.**
- ~~`site_total_time` missing from `DeterministicFactKind`~~ — #68; domain-time questions now compute and enforce a site total
- interpretation-agent runtime behind a flag that logs "not wired yet" — #109
- Context Inspector: backend fills `ChatAgentResult.evidence`, no UI reads it
- ~~command palette never reaches `planRetrieval`~~ — **not true**;
  `search.handlers.ts:56` returns `planRetrieval(...)`
- entity write-through: `adoptAppIdentityWrite` and `adoptArtifactWrite` exported, uncalled
- screen context captures frames with `noExtractorInstalled`
  (`screenContext.handlers.ts:61`); backlog full at 100 frames, all quarantined — #73
- `browser_context_events` was dropped in migration 42 (never written in production). Live
  page capture is `website_visits` with source `active_browser_context`.

**Not started.** Billing at a real boundary · Windows signing · a model-optional Timeline ·
the ~1.1s of eager module eval on the paint path.

**Gone.** The OAuth connector framework, removed 2026-07-26. Not V2 scope, no longer gates
the release.

## Not in V2

Windows tracking before a consent screen — **intentional**; the download is the disclosure.
macOS notarization ($99, a Gatekeeper warning, not a dead platform). Database
retention/VACUUM. Dual capture pipelines. Linux capture helper and Wayland. Windows Store.
Web companion and sync. Wrapped telemetry. Settings redesign.

---

## Release channels

Stable from tags, Nightly automatically from `main`, independent feeds. Pattern from
`pingdotgg/t3code` — same stack.

Channel derives from the binary's own version (`X.Y.Z-nightly.YYYYMMDD.<run>`). Stable
omits `channel` and keeps `latest-mac.yml`; nightly sets `channel: "nightly"` →
`nightly-mac.yml`, published as a prerelease in the same repo. `allowPrerelease` must be
true on nightly or electron-updater silently finds nothing. Merge the per-arch macOS
manifests before upload or one architecture stops updating with no error.

**One deviation:** separate `userData` per channel. t3code shares one directory. We have a
1.2GB SQLite database with a migration chain that already renumbers, and a nightly running
a forward migration would leave stable unable to open its own database. Distinct `appId`
and `productName`, side-by-side install. DEV-293 consolidates the four existing profile
directories first.
