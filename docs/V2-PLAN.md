# Daylens V2 — the plan

**Status:** Authoritative. Supersedes `V2-SHIP-PRIORITIES.md`, `V2-SPRINT-STATE.md`,
`TO-DO.md`, and the `acceptance/` dossier as the answer to "what ships and when".
Compiled 2026-09-04 from Linear, both GitHub trackers, Software Factory, and the code.

Where a claim here contradicts an older doc, this document wins. The older docs keep
their detail; they no longer set scope.

---

## The five blockers

Ranked by what stops a release. Everything else is out of scope — see the bottom.

### 1. Windows cannot ship or update itself

Windows is where most users are. Today the platform has neither a release path nor an
update path.

- `.github/workflows/release-windows.yml:100` hard-fails unless `WIN_CERTIFICATE_FILE`,
  `WIN_CERTIFICATE_PASSWORD`, and `WIN_CERT_SUBJECT_NAME` are all set. The repo has four
  secrets and none of them are these. The workflow cannot complete.
- `src/main/services/updater.ts:218` disables updates outright on an unsigned build:
  "This Windows build is unsigned, so built-in updates are disabled."

**Tracked in:** irachrist1#129 (missing env block). No Linear issue covers the cert.

**Fix:** Azure Trusted Signing (~$10/month, signs from CI without an HSM). Traditional OV
certs need a hardware token since June 2023, which does not work in GitHub Actions without
cloud-HSM plumbing. `electron-builder.config.js:82-92` expects a PFX file, so the signing
hook changes shape — this is real work, not just adding secrets.

**Owner action:** the certificate. Everything downstream is mine.

**Acceptance:**
- `gh workflow run release-windows.yml --repo spcsorg/daylens` completes without the
  secret-guard failure.
- `Get-AuthenticodeSignature <installed exe>` returns `Valid`.
- A packaged Windows build reports `getAutoUpdateSupport().supported === true`.
- An installed build moves N-1 -> N from the published feed without manual download.

### 2. DEV-487 — main process dies twice a day, silently stopping capture

`RangeError: Maximum call stack size exceeded` in the main process during the morning and
evening notification windows. The main process owns capture, so each crash stops tracking
until restart.

**The ticket's stated cause is disproven.** DEV-487 blames "the notifier invoking Timeline
and Wrapped data paths on a one-minute schedule". Two findings contradict that:

- `scripts/repro-dev487.ts` runs those exact paths against a read-only copy of the real
  1.2GB profile — `getTimelineDayPayload`, `getWrappedNarrative`, and
  `buildWrappedPeriodFacts`/`getWrappedPeriodWrap` for week, month, and year. All pass on
  the five heaviest days (peak 1,277 sessions). No overflow.
- `src/main/services/dailySummaryNotifier.ts:497-505` wraps all three checks in one
  `try/catch` that logs and swallows. A `RangeError` raised there never reaches
  `process.on('uncaughtException')` at `src/main/index.ts:2`, but the ticket says the crash
  does reach it. The overflow therefore starts outside the notifier's await chain.

No fix exists: `git log -S"Maximum call stack" --all` returns nothing.

**Blocked on evidence, not effort.** The ticket's unmet dependency was "retrieve the
captured Sentry stack". Sentry has since been removed from the product — `captureException`
now emits a PostHog `$exception` with parsed, redacted frames
(`src/main/services/analytics.ts`), capped at 50 because a stack-overflow trace is
thousands of identical frames. So the next installed build that crashes reports the frame
to PostHog, and the missing evidence becomes recoverable without new instrumentation.

**Acceptance:**
- The overflowing frame is named from a captured stack or a deterministic repro.
- A regression test fails on pre-fix code and passes after.
- An installed build survives 48h spanning two morning and two evening windows with the
  real profile attached and no `app_crashed` event.

### 3. CI runs on the repo without runners

Not broken — misdirected. `spcsorg/daylens` and `irachrist1/daylens` carry identical
workflows on the same `blacksmith-4vcpu-ubuntu-2404` label. Blacksmith is installed on the
org, not on the personal account.

Measured 2026-09-04: a dispatched job on `spcsorg` was picked up in **under 15s and
succeeded**; the same job on `irachrist1` sat **queued 14+ minutes** and never got a runner.
On `irachrist1`, 52 of the last 60 runs auto-cancelled after queuing unpicked since
2026-08-15.

Both remotes are at `cf405e84` — identical. Nothing needs migrating; the work moves repo.

Two gaps once it moves: `verify-macos-runtime.yml` and `verify-windows-runtime.yml` are
`disabled_manually` on `spcsorg`, and both last failed on `irachrist1` (2026-08-15) at
their packaged smoke-test step. CI must build and package a real app, not only run tests.

**Fix:** make `spcsorg/daylens` the CI home, re-enable both verify workflows, fix the two
smoke tests, add a packaged macOS build to the PR path.

**Acceptance:**
- Every push to `main` on `spcsorg` completes CI green.
- CI packages a real macOS app and fails the run when packaging fails.
- Zero runs auto-cancel for want of a runner over seven consecutive days.

### 4. Billing is unreachable in shipped builds

No checkout button can render. `DAYLENS_BILLING_API_URL` is never set by the build, no
billing server is deployed, and release builds carry no entitlement public key (WO-62).

**Tracked in:** irachrist1#152 (verified, file:line), plus WO-59, WO-60, WO-62, WO-66,
WO-69, WO-71, WO-80, WO-83, WO-84, WO-85, WO-90. Downstream: #153 (copy promises $5/month,
backend grants $5 once) and #156 — both unreachable until this is fixed.

**Decision required:** deploy the billing service, or cut to BYOK-only and delete the
subscribe UI. Shipping the current state means shipping a dead button.

**Acceptance:**
- A packaged build reaches checkout and returns a signed entitlement, **or** the subscribe
  UI is gone and Settings offers only BYOK.
- `npm run billing:sandbox` passes against the deployed service.

### 5. The V2 release gate cannot be satisfied

`docs/product/v2.md` gates V2 on "the priority read-only connectors". The OAuth connector
framework was **deleted 2026-07-26** (`docs/specs/connectors.md:3`), and the code agrees —
no `src/main/services/connectors`, no adapters. Only `granolaCache.ts` and
`externalSignals.ts` survive.

Nine documents still describe connectors as in-scope: `TO-DO.md:38`, `product/v2.md`
(three places), `README.md`, `V2-SHIP-PRIORITIES.md`, `acceptance/ACCEPTANCE.md`,
`product/positioning.md`, `testing/v2-manual.md`.

Until the gate is amended, "is V2 done?" has no answerable form.

**Fix:** amend `v2.md` to drop connectors from the gate; strike them from the other eight;
regrade `ACCEPTANCE.md`'s AI-chat line 2, which cannot be graded as written.

**Acceptance:**
- No document lists connectors as a V2 requirement.
- Every remaining gate condition maps to a runnable command or an observable behavior.

---

## Current honest state

Evidence-based, not doc-based.

### Shipped (verified in code)
Calendar + Granola agent tools (`contextTools.ts` — kills the most-repeated stale doc
claim) · Timeline merge/zoom/week-popover · Apps junk, icon, and identity fixes ·
`wrapSlideExport.ts` per-slide export · screen-context honesty pane · `discover_repositories`
(`systemTools.ts:565`) · recap-tone control · corrupt-DB recovery with restore/fresh/quit
(`databaseRecovery.ts`, `index.ts:795-860`) — **irachrist1#139 is stale, this is fixed**.

### Half-built
Per-site duration answers — `DeterministicFactKind` has no `site_total_time`, which is the
whole of spcsorg#68 · Context Inspector — backend emits evidence, no renderer reads it
(WO-76) · command-palette semantic status never reaches `planRetrieval` (WO-13) · entity
write-through — `adoptAppIdentityWrite` and `adoptArtifactWrite` exported, never called
(WO-30/38) · screen context captures frames with `noExtractorInstalled`
(`screenContext.handlers.ts:61`), backlog full at 100 frames/61.2MB, all quarantined ·
**memory mirror — ~50KB uncommitted and untracked**, though `positioning.md` calls it
"Shipped 2026-08-14".

### Not started
Connector program (deleted) · any `passing` acceptance grade — 0 of 24 lines, plus 60
unindexed lines in `acceptance/performance.md` · managed billing at a real boundary · the
four desktop-milestone research gates in `TO-DO.md:53-62`.

---

## Verification bar

"Done" means observable in an installed build. A green dev-mode suite does not close
anything.

Reusable as-is from `acceptance/performance.md` — the only lines in the dossier that name a
query plan or pragma: VAL-DB-001 (`ANALYZE` has run), VAL-DB-003 (window-title query uses an
index, not a 14K-row scan), VAL-DB-004 (sargable two-sided range), VAL-DB-005 (no disk temp
B-tree), VAL-DB-010 (`EXPLAIN QUERY PLAN` positive). Plus its numeric bar: interaction
renders ~100ms; **nothing blocks the UI thread beyond ~200ms**; correctness first.

Reusable shape from `testing/v2-manual.md`: Do / Expect / Report-if.

Rewrite before use — unfalsifiable: "works correctly", "is stable", "believable" ranking,
"the tab opens instantly", "smooth at every range", the whole Legibility section.

---

## Out of scope for V2

Not blockers. Do them after, or never.

- **Windows tracking before a consent screen (irachrist1#143)** — intentional design. The
  download is the disclosure. Close as by-design.
- macOS notarization ($99 Apple enrollment) — real, but a Gatekeeper warning, not a dead
  platform. Ranks below Windows signing.
- DB retention/pruning/VACUUM (#138) — filed as "a 359MB scar"; the live profile is now
  1.2GB, so the issue understates itself 3.5x. Growing cost, not a gate.
- Dual capture pipelines (#141, #172) — root cause of the "day came out wrong" class, but
  multi-week architecture.
- Linux capture helper, Wayland, Windows Store — platform work.
- 12 issues already fixed per their own bodies: #116-#123, #125, #126, #127. Plus #128
  (stale — both remotes are at `cf405e84`). Close them.
- 9 Linear items in Backlog with merged code: DEV-239, 240, 248, 249, 250, 251, 252, 253.

---

## Release channels

Stable from tags, Nightly automatically from `main`, independent feeds. Pattern taken from
`pingdotgg/t3code` (same stack: electron-builder + electron-updater + GitHub Releases),
with one deliberate deviation.

- Channel derived from the binary's own version: `X.Y.Z-nightly.YYYYMMDD.<run>`.
- Stable omits `channel` (keeps `latest-mac.yml`); nightly sets `channel: "nightly"` ->
  `nightly-mac.yml`. Same repo, nightly as `prerelease: true, make_latest: false`.
- `allowPrerelease = true` on nightly is mandatory — electron-updater's GitHub provider
  silently finds nothing without it.
- Merge the per-arch macOS manifests before upload, or one architecture stops updating with
  no error.

**Deviation from t3code: separate `userData` per channel.** t3code deliberately shares one
directory. We have a 1.2GB SQLite database with a migration chain, and migrations already
renumber (spcsorg PR#317 moves v69 -> v81). A nightly running a forward migration would
leave stable unable to open its own database with no rollback. Take Signal's model —
distinct `appId` and `productName`, so Electron derives separate directories and the two
install side by side.

Sequencing note: this adds a fifth profile directory, and four already exist. DEV-293 owns
consolidating those and should land first.
