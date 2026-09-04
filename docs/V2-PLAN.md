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

Nothing else stops a release.

### 1. Windows cannot ship or update itself

Most users are on Windows. Today that platform has no release path and no update path.

- `release-windows.yml:100` hard-fails without `WIN_CERTIFICATE_FILE`,
  `WIN_CERTIFICATE_PASSWORD`, `WIN_CERT_SUBJECT_NAME`. None are set.
- `updater.ts:218` disables updates on an unsigned build.

**Fix:** Azure Trusted Signing (~$10/month, signs from CI without an HSM). OV certs need a
hardware token since June 2023 and do not work in GitHub Actions. `electron-builder.config.js:82`
expects a PFX, so the signing hook changes shape.

**Done when:**
- `gh workflow run release-windows.yml --repo spcsorg/daylens` completes.
- `Get-AuthenticodeSignature <installed .exe>` returns `Valid`.
- An installed build moves N-1 → N from the published feed without a manual download.

### 2. The app crashes twice a day and stops recording

`RangeError: Maximum call stack size exceeded` in the main process, morning and evening.
The main process owns capture, so every crash stops tracking until restart.

**The ticket's stated cause is disproven.** DEV-487 blames the notifier's Timeline and
Wrapped paths. `scripts/repro-dev487.ts` runs exactly those against the real 1.2GB profile
— day, week, month, year — and none overflows. And `dailySummaryNotifier.ts:497` wraps all
three checks in a `try/catch` that swallows, so a `RangeError` there never reaches the
`uncaughtException` handler the ticket says receives it. The overflow starts elsewhere.

No fix has ever existed: `git log -S"Maximum call stack" --all` is empty.

**Fix:** the frame is now recoverable — `captureException` reports a PostHog `$exception`
with parsed frames. Read the frame from the next crash, or force one locally against the
real profile with a shortened notifier interval.

**Done when:**
- The overflowing frame is named from telemetry or a deterministic repro.
- A regression test fails before the fix and passes after.
- An installed build survives 48h across two morning and two evening windows on the real
  profile with no `app_crashed` event.

### 3. CI does not run

Not broken — pointed at the repo without runners. Blacksmith is installed on the
`spcsorg` org, not on the `irachrist1` personal account. Measured 2026-09-04: the same job
was picked up in <15s and succeeded on `spcsorg`, and sat queued 14+ minutes on
`irachrist1`. On `irachrist1`, 52 of the last 60 runs auto-cancelled unpicked.

Both remotes are at the same commit. Nothing to migrate; the work moves repo.

`verify-macos-runtime.yml` and `verify-windows-runtime.yml` are `disabled_manually` on
`spcsorg`, and both last failed on their packaged smoke-test step.

**Done when:**
- Every push to `main` on `spcsorg` completes CI green.
- CI packages a real macOS app and fails the run when packaging fails.
- Zero runs auto-cancel for want of a runner across seven days.

### 4. Nobody can pay

No checkout button can render. `DAYLENS_BILLING_API_URL` is never set by the build, no
billing server is deployed, and release builds carry no entitlement public key.

**Decision needed:** deploy the billing service, or cut to BYOK-only and delete the
subscribe UI. Shipping as-is ships a dead button.

**Done when:**
- A packaged build reaches checkout and returns a signed entitlement, **or** the subscribe
  UI is gone and Settings offers BYOK only.
- `npm run billing:sandbox` passes against the deployed service.

### 5. No one has confirmed the app works

Zero of 24 acceptance lines are graded `passing`. Seventeen are merged but never opened in
a running app. This is the difference between "the code is written" and "it works", and it
is the last thing standing between the other four and a release.

**Done when** each line below is observed in an installed build against the real profile:

| # | Criterion |
|---|---|
| 1 | The live day is one block that grows with the clock, split only on absence, sleep, or idle |
| 2 | A merge a person asks for produces one block, states any blocker in plain words, and survives leaving the day and returning |
| 3 | Overlapping events and blocks render side by side, both readable and clickable |
| 4 | Opening an application shows a plain-language account of what was done there |
| 5 | Browser time resolves to real pages; an unattributable stretch says why in one sentence |
| 6 | Junk strings are filtered, an app never appears twice, sub-few-second visits collapse |
| 7 | The first answer to a factual question is the correct number, matching Timeline and Apps |
| 8 | Provider and model have one source of truth, shown identically in Settings and the chat picker |
| 9 | Recaps use the same numbers Timeline shows and never contradict themselves on one screen |
| 10 | Slides render cleanly and export saves each slide as its own image |
| 11 | Settings toggles keep their state across navigation |
| 12 | Generate recap finishes on a heavy, fully-enriched day |

Plus the database bar, which is checkable by query plan rather than opinion:

| # | Criterion |
|---|---|
| VAL-DB-001 | `ANALYZE` has run — `sqlite_stat1` is populated. **Verified failing 2026-08-11** |
| VAL-DB-002 | Tuned PRAGMAs applied on the live connection, including `temp_store = MEMORY` |
| VAL-DB-003 | The window-title evidence query uses an index, not a 14K-row scan |
| VAL-DB-004 | `gatherConcurrentEvidence`'s `website_visits` query is a true two-sided range |
| VAL-DB-005 | The `website_visits` `GROUP BY` does not spill to a disk temp B-tree |
| VAL-DB-010 | Hot read queries on big tables use indexes — positive `EXPLAIN QUERY PLAN` |

And the interaction bar: renders in ~100ms where data is light or cached; **nothing blocks
the UI thread beyond ~200ms**; no multi-second freeze. Correctness first — a wrong number
fails the line even when every timing passes.

---

## Where the code actually is

**Works.** Calendar and Granola agent tools · Timeline merge, zoom, week popover · Apps
junk/icon/identity fixes · per-slide wrap export · screen-context honesty pane ·
corrupt-database recovery with restore/fresh/quit · readable memory mirror.

**Half-built.** Per-site duration answers — `DeterministicFactKind` has no
`site_total_time`, which is the whole bug · Context Inspector — backend emits evidence, no
UI reads it · command palette never reaches `planRetrieval` · entity write-through exported
but uncalled · screen context captures frames with no extractor installed, backlog full at
100 frames and all quarantined.

**Not started.** Any `passing` acceptance grade · billing at a real boundary · Windows
signing.

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
