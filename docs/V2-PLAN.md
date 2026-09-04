# Daylens V2

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

What a person feels. Signing, CI and release plumbing are how we ship — they are chores,
not blockers, and they live at the bottom of this document.

### 1. Timeline depends on a model

Timeline should produce a good day with any model, and a useful day with none. Today the
deterministic pipeline is the floor but the day is only named well when a model runs
(`analyzeDay.ts:583` — `source: modelsUsed.size > 0 ? 'ai' : 'deterministic'`), and the
model choice is not portable across providers.

**Done when:**
- With no provider configured at all, opening a day shows named blocks built from evidence
  — not "Unlabeled", not an empty state.
- The same day analysed with each supported provider produces blocks whose boundaries match
  within one session, and names that a person judges equivalent.
- Switching provider mid-day does not orphan or relabel already-closed blocks.

### 2. The answers must be right

A number the app shows must be the number it has. Per-site duration is the known hole:
`DeterministicFactKind` has no `site_total_time`, so "how long was I on X" gets no
deterministic override and the model guesses.

**Done when:**
- "How long was I on <site> today" returns the same seconds `website_visits` holds, for ten
  sites picked at random from the real profile.
- Timeline total, Apps total, and the chat's answer for the same day agree exactly.
- Every number in a recap traces to a row; a fact with no row is not printed.

### 3. The app is three times faster

Measured 2026-09-04 on the real 1.19GB profile: `getTimelineDayPayload` 111-166ms,
`getAllAppsForLabeling` 16-53ms. **The database is not the bottleneck.** The wait a person
feels is startup, renderer, and model latency — that is where the 3x comes from.

`ANALYZE` has still never run on this profile (`sqlite_stat1` does not exist, 202 indexes
across 122 tables), and 108MB of the file is freelist. Cheap to fix, not the main win.

**Done when:**
- Cold launch to an interactive Timeline is under 2s on the real profile.
- Switching between Timeline, Apps and Chat paints in under 200ms, every time.
- No interaction blocks the UI thread beyond ~200ms.

### 4. Apps view loads and scrolls instantly

**Done when:**
- Apps opens with content in under 500ms on the real profile.
- Scrolling a year of apps holds 60fps with no blank rows and no layout shift.
- Per-app detail opens in under 300ms.

### 5. AI chat is fast

Today the tab renders nothing until settings resolve — `AIWorkspace.tsx:451` returns
"Loading AI…" while `settings` and `hasApiKey` are null. Then the answer waits on context
assembly and a 90s narrative timeout (`wrappedNarrative.ts:65`).

**Done when:**
- The chat tab paints its input in under 200ms, before settings resolve.
- First token is under 2s for a question about today.
- A question with no model configured still answers from deterministic facts rather than
  failing.

---

## Chores that gate distribution

Not blockers — nobody feels them until release day, but a release cannot happen without
them.

- **Windows code-signing certificate.** Azure Trusted Signing, ~$10/month. Without it
  `release-windows.yml:100` hard-fails and `updater.ts:218` disables updates. Owner action.
- **Billing via pawapay** while the Flutterwave application is in progress. Today no
  checkout can render: `DAYLENS_BILLING_API_URL` is never set and no service is deployed.
- **CI lives on `spcsorg`.** Blacksmith is installed on the org, not the personal account.
- **The morning/evening crash (DEV-487).** Real but rare, and now self-reporting: the next
  crash sends its frame to PostHog. Screenshot it when it happens.

## Where the code actually is

**Works.** Calendar and Granola agent tools · Timeline merge, zoom, week popover · Apps
junk/icon/identity fixes · per-slide wrap export · screen-context honesty pane ·
corrupt-database recovery with restore/fresh/quit · readable memory mirror.

**Half-built.** Per-site duration answers — `DeterministicFactKind` has no
`site_total_time`, which is the whole bug · Context Inspector — backend emits evidence, no
UI reads it · command palette never reaches `planRetrieval` · entity write-through exported
but uncalled · screen context captures frames with no extractor installed, backlog full at
100 frames and all quarantined.

**Not started.** Billing at a real boundary · Windows signing · a model-optional Timeline.

**Gone.** The OAuth connector framework, removed 2026-07-26. It is not V2 scope and no
longer gates the release.

---

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
