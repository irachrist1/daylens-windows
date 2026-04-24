# Daylens Web — Docs refresh (ARCHITECTURE.md + REDESIGN.md)

Plan only. No code or docs shipped yet. Status: `draft, awaiting user review`.

Scope: `/Users/tonny/Dev-Personal/daylens-web/ARCHITECTURE.md` and `/Users/tonny/Dev-Personal/daylens-web/REDESIGN.md`. This plan does not touch runtime code — only docs.

## Why this exists

Both docs drifted across the Daylens repo consolidation:

- `ARCHITECTURE.md` still describes a **three-repo system**: `daylens` = macOS SwiftUI app, `daylens-windows` = Electron Windows app, `daylens-web` = dashboard. In reality, the unified cross-platform Electron repo now lives at `/Users/tonny/Dev-Personal/daylens` (still named `daylens-windows` inside `package.json` for historical reasons) and covers macOS + Windows + Linux in one codebase. A new contributor reading the current ARCHITECTURE.md would wire up the wrong source-of-truth, expect SwiftUI for macOS, and miss Linux entirely.
- `REDESIGN.md` is labelled `Status: NOT IMPLEMENTED. Previous attempt failed completely.` It's an unprosecuted TODO from April 2026 that nobody has closed out or acted on. Either the redesign happened and the doc is stale, or it didn't and the doc is still live — either way, it should not be sitting in `main` with that header indefinitely.

These docs are small and independent from the Snapshot v2 work in `.intent/web.md`. They can ship in parallel without any coordination.

## ARCHITECTURE.md — what changes

### Change 1: replace the three-repo table with the current reality

Current (lines ~5–11):

```
| `daylens` | macOS desktop app + marketing site | Swift / SwiftUI |
| `daylens-windows` | Windows desktop app | Electron / React / Vite |
| `daylens-web` | Web dashboard + Convex backend | Next.js / Convex |
```

Proposed:

```
| `daylens` | Unified cross-platform desktop app (macOS + Windows + Linux) + marketing site | Electron / React / Vite / TypeScript |
| `daylens-web` | Web dashboard + Convex backend | Next.js / Convex |
| `daylens-linux` | Public MIT transition repo; points contributors back to `daylens` | — |
| `daylens-swiftUI` | Legacy macOS SwiftUI prototype (archived, non-shipping) | Swift / SwiftUI |
```

The prose block below that table ("The web app cannot work alone…") can stay; it's still true.

### Change 2: fix `Platform` union everywhere it appears

ARCHITECTURE.md references `Platform: "macos" | "windows"` in the Data Flow and Database Schema sections. These are stale — Linux ships in the unified desktop app, and once the Snapshot v2 plan (`.intent/web.md`) lands, the validator will accept `"linux"` too.

- Update "Data Flow" ASCII diagram's caption from `Desktop App (macOS or Windows)` to `Desktop App (macOS, Windows, or Linux)`.
- Update the `devices` schema block: `platform: "macos" | "windows" | "web"` → `platform: "macos" | "windows" | "linux" | "web"`.
- Add a one-line note under the schema: *Linux platform support requires the Snapshot v1 validator to be widened; see `.intent/web.md` Phase 1. Linux is architecturally supported today but will be rejected by the current Convex validator until that phase ships.*

### Change 3: authentication flow still accurate, no changes needed

The auth diagrams (BIP39 mnemonic, link codes with 5-min TTL, ES256 JWT, HttpOnly cookies) are all accurate as of this review. Leave them as-is.

### Change 4: add a new top-level section

```
## Status vs. `daylens` desktop

This doc describes the web companion only. The desktop app's current
implementation status, platform validation state, and open gaps live in the
unified repo's `docs/ISSUES.md`. When this doc and that one disagree, that one
wins for desktop behaviour and this one wins for web behaviour.
```

This is the same pattern the unified repo already uses: one doc owns status, others link to it.

### Change 5: add the Snapshot v2 deprecation note

Add a single line above the Database Schema section:

```
> Snapshot schema v1 is documented below and is what the web renders today.
> Snapshot v2 is in design — see `.intent/web.md` in the `daylens` repo for
> the proposed contract. This doc should be updated when v2 lands.
```

No other schema changes today — v2 is a forthcoming contract, not a shipped one.

## REDESIGN.md — what changes

Three possible fates, pick one. The plan's recommendation is option 2.

1. **Delete it.** If the redesign has since happened (landing page rebuilt, hero restructured, glass nav shipped), the postmortem is no longer relevant — archive the file to the repo's git history and remove it from `main`. Low cost, high honesty.

2. **Convert it into a short `DESIGN.md`.** Strip the "what went wrong" postmortem framing entirely. Keep the **design principles** the doc actually defines (cornflower blue palette from the app icon, ToDesktop-style gradient hero, white glass nav, layered shadows, `cubic-bezier(0.6, 0.6, 0, 1)` easing, ~450ms transitions). Those are useful regardless of whether the redesign is done. Delete the failure-mode story and the "next attempt prompt" — both are noise once the redesign has landed.

3. **Keep it as-is but date-stamp the status.** If the redesign genuinely hasn't happened yet and the postmortem still describes open work, add a `Last reviewed: 2026-04-19` line at the top and a clear "what is still open" bullet list. Do not leave an undated "Previous attempt failed completely" header in `main` — that reads as abandoned, not as active work.

Recommend option 2. The palette + ToDesktop-style patterns the doc identified are worth keeping as design references; the postmortem is not.

Whichever option is chosen, the doc should also:

- Cross-link to the Daylens app icon color source (cornflower blue `#7CB9F5`) so the palette has a stated provenance.
- Note that the `daylens` desktop repo defines the product story; the web marketing site should align with it, not invent a parallel narrative.

## Acceptance tests (informal — it's docs)

- A new contributor can read `ARCHITECTURE.md` and know that (a) there is one desktop codebase, (b) it supports macOS + Windows + Linux, (c) Linux sync has a known gating validator issue tracked in `.intent/web.md`.
- `REDESIGN.md` either doesn't exist, or exists as a short positive design guide with no undated "this failed" language.
- No doc in the web repo describes the desktop as SwiftUI + separate Windows Electron. That was the pre-consolidation world.

## What this doc is not

- Not a marketing-site redesign plan. That's a product/design task, not a parity task.
- Not a snapshot or Convex schema change. Those live in `.intent/web.md`.
- Not a repo-consolidation plan. Whether `daylens-web` should eventually fold into the unified repo is one of the open questions in `.intent/web.md`, not this doc's call to make.
