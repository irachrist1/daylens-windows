# Daylens V2

**Status:** Accepted product direction.

**The only planning document.** Scope, status, blockers, and acceptance criteria.
Everything else was deleted on 2026-09-04 — it was stale, contradicted itself, or
duplicated a tracker. Product behaviour lives in `docs/specs/`; how to build and ship
lives in `docs/operations/`. Nothing else plans V2.

Kept in sync with Linear project **Daylens V2** and GitHub `spcsorg/daylens`. When they
disagree, this document is wrong and gets fixed.

---

## What V2 is

Daylens remembers your computer day and can answer questions about it.

V2 ships when a stranger can install it, use it for a week, and trust what it says.
That is the whole gate. It is not a feature list.

---

## The five blockers

Each one is a list of named defects, not a theme. Issue numbers are `spcsorg/daylens`
unless marked. Nothing ships while any of these is open.

### 1. Timeline needs a model to be any good

The deterministic pipeline is the floor, but a day is only *named* well when a model runs —
`analyzeDay.ts:583` sets `source: modelsUsed.size > 0 ? 'ai' : 'deterministic'`. With no
provider you get blocks with no useful names. With a different provider you get different
boundaries. Neither is acceptable for a product whose main screen is the day.

- **#109** — `analyzeDay.ts` has an `interpretationAgentEnabled` flag whose runtime logs
  "not wired yet" and falls back to the legacy pipeline. Called the highest-leverage
  remaining build for activity understanding, and it is switched off.
- **#110** — stored block labels written before the name guards still say "Cursor Agents".
  Read-path guards do not rewrite what is already in the database; this needs a backfill.
- **#116** — calendar context blocks the first Timeline paint instead of loading behind it.
- **#113** — the question card asks about meetings that have not happened yet. The detector
  never checks the clock and writes durable attendance marks for future events.

**Done when:**
- With no provider configured, a day opens with blocks named from evidence — window titles,
  page titles, file names. Not "Unlabeled", not an empty state.
- The same day run through each supported provider gives boundaries within one session of
  each other.
- No stored label contains a name the current guards would reject.

### 2. The numbers are wrong

- **#68** — "How much time did I spend on Coursera this week?" returns the wrong number on
  the first try. Cause: `DeterministicFactKind` has no `site_total_time`, so per-site
  duration questions get no deterministic override and the model guesses. Every other fact
  kind is enforced; this one hole is the whole bug.
- **#112** — `reconcileWebsiteVisits` grants a history row up to `HISTORY_FILL_MAX_MS` (4h)
  of foreground time until the next navigation. For a browser with no window titles and no
  active-tab events, the last-visited page — often Netflix or YouTube — absorbs a long work
  dwell. Block labelling was hardened 2026-07-26 so it no longer flips blocks, but the
  per-domain minutes are still inflated. `browser_context_events` exists and nothing writes
  to it; populating it for Chromium browsers fixes this properly.
- **#60** — half of browser time has no page attached. Safari needs Full Disk Access; Dia
  exposes no tab API.
- **#21** — Timeline, Apps, the chat and exports disagree about the same day.

**Done when:**
- Ten domain-time questions picked at random from the real profile return the seconds
  `website_visits` holds.
- Timeline total, Apps total and the chat's answer for one day are identical.
- No domain's daily minutes exceed the foreground time of the browser that hosted it.

### 3. Startup and navigation are slow

`#253` (irachrist1) measured this properly. The 5.7s unconditional `PRAGMA integrity_check`
before `createWindow()` was the dominant cost and is fixed — it now runs `quick_check`
(1.2s) after an unclean shutdown and escalates only on a real fault. Dev launch went ~12s →
~6.6s. What is left, from that issue's own checklist:

- **~1.1s of eager module eval** at "Electron ready". The AI SDK and ExcelJS load at
  top level, on the paint path. Still open. Lazy-import them so they load when chat or
  export actually runs.
- **#83** — the app freezes for minutes and silently stops recording, with no marker in the
  day. Needs a main-thread stall watchdog.

Measured 2026-09-04 on the real 1.19GB profile via `npm run bench:surfaces`:
`getTimelineDayPayload` 111-166ms, `getAllAppsForLabeling` 16-53ms. **The database is not
the bottleneck.** Do not spend time on SQL for this blocker.

Cheap and unrelated to the above: `ANALYZE` has never run on this profile — `sqlite_stat1`
does not exist across 202 indexes on 122 tables — and 108MB of the 1.19GB file is freelist.

**Done when:**
- Cold launch to an interactive Timeline is under 2s on the real profile.
- Switching Timeline → Apps → Chat paints in under 200ms every time.
- A stall over 5s writes a marker the day can show, instead of vanishing.

### 4. Apps view

Four named defects, all in Phase 3:

- **#59** — "What you did there" summaries are unreliable: raw JSON on screen, empty
  summaries where time was tracked, invented specifics.
- **#61** — junk strings shown as real activity; the same app appears twice; one- and
  two-second visits get their own rows instead of collapsing.
- **#62** — wrong icons, unbelievable ranking, and apps with real hours hidden out of the
  main list.
- **#60** — browser rows resolve to no page (shared with blocker 2).

**Done when:**
- Apps opens with content in under 500ms on the real profile.
- The five most-used apps at Today / 7d / 30d each show a summary that matches what you
  remember doing, with no raw JSON and no empty summary where time was tracked.
- Each app appears exactly once. Google shows its own icon. YouTube's real hours are in the
  main list.
- One- and two-second visits collapse into a single "everything else" line.

### 5. AI chat

- **#65** — the tab shows "Loading AI…" on a blank screen every open.
  `AIWorkspace.tsx:451` returns early while `settings` and `hasApiKey` are null, so the
  chat renders nothing — not even its own input box — until a settings round-trip finishes.
- **#64** — provider and model state contradict across the app. Settings and the chat picker
  disagree; a CLI provider shows connected in one place and missing in another. Default out
  of the box should be Haiku 4.5, shown identically everywhere.
- **#66** — tool activity is a wall of file names instead of a one-line summary that expands.
- **#67** — multi-step work shows no structured progress.
- **#114** — the day recap times out. Two stacked 15s timeouts, and model-tier selection
  that does not do what it claims. Needs one measured budget, following the pattern
  `wrappedNarrative.ts:65` already set with `NARRATIVE_TIMEOUT_MS`.

**Done when:**
- The chat paints its input in under 200ms, before settings resolve.
- First token under 2s for a question about today.
- Opening the tab repeatedly never shows a blank screen.
- Switching provider in Settings changes the next answer, and the picker agrees.
- With no model configured the chat still answers from deterministic facts.

---

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
- **#51** — the app trusts the accessibility flag instead of verifying capture works.
  0 of 83 samples carried a window title while the health page read "granted".

## Where the code actually is

**Works.** Calendar and Granola agent tools · Timeline merge, zoom, week popover ·
per-slide wrap export · screen-context honesty pane · corrupt-database recovery with
restore/fresh/quit · readable memory mirror · the 5.7s startup integrity scan, fixed.

**Half-built.**
- `site_total_time` missing from `DeterministicFactKind` — #68
- interpretation-agent runtime behind a flag that logs "not wired yet" — #109
- Context Inspector: backend fills `ChatAgentResult.evidence`, no UI reads it
- command palette calls `ipc.search.semantic` and never reaches `planRetrieval`
- entity write-through: `adoptAppIdentityWrite` and `adoptArtifactWrite` exported, uncalled
- screen context captures frames with `noExtractorInstalled`
  (`screenContext.handlers.ts:61`); backlog full at 100 frames, all quarantined — #73
- `browser_context_events` table exists, nothing writes to it — the proper fix for #112

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
