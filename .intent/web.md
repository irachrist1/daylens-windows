# Daylens Web — Parity closure and Snapshot v2 plan

Plan only. No code shipped yet. Status: `draft, awaiting user review`.

Sibling repo: `/Users/tonny/Dev-Personal/daylens-web` (Next.js 16 + Convex). This plan describes changes that will span **both** repos: desktop (this repo) and web.

## Why this exists

`daylens-web` is a read-only dashboard for synced Daylens data plus a web AI chat. It exists, it works, and the auth/sync scaffolding is solid. But the **Snapshot v1 contract** it speaks is frozen at pre-v1.0.28 Daylens:

- App-level timeline, no work blocks → web is still the "app vanity dashboard" shape the product contract rejects.
- Focus Score v1 formula → disagrees with the desktop's Focus Score v2.
- `platform: macos | windows` only → Linux syncs fail at the Convex validator today.
- `aiSummary: string | null` → one freeform paragraph, no recap chapters, coverage, or entities.
- No artifacts, threads, or entity data on web → the AI surface on web is thinner than on desktop and can't ground questions against the same evidence the user sees locally.

Shipping "mobile later" on top of this contract would re-freeze thinner-than-real data for another product generation. Snapshot v2 has to land first, and it has to be shaped by what the desktop actually computes now.

The web *idea* is right: read-only lens on the local-first data, AI on the go, mobile extension later. This plan closes the gap so the idea is backed by truthful data.

## Concrete runtime bug to fix before anything else

`daylens-web/convex/snapshotValidator.ts:47` declares:

```ts
platform: v.union(v.literal("macos"), v.literal("windows")),
```

`daylens/src/main/services/snapshotExporter.ts:67` already emits:

```ts
platform: 'windows' | 'macos' | 'linux'
```

First Linux user who links a workspace will get `ArgumentValidationError` on every 5-minute sync. Silent — it would only surface in Convex logs and in the user's "web shows nothing" complaint.

Fix in Phase 1 even if everything else slips: widen the validator to include `"linux"`, land it, deploy. Ten-line change, unblocks Linux users the day the desktop app ships to them.

## Snapshot v2 — the contract

### Design principles

- **Carry what the desktop computes, nothing the desktop invents.** Web and mobile cannot render richer than local data; that'd be fake confidence.
- **One-way desktop → cloud → lenses.** No bidirectional write-back in v2. Mobile state lands in v3 once the write-back contract is actually designed.
- **Backward compatible on the wire.** v1 clients keep uploading and reading. v2 is additive, not a breaking replacement, until all desktops have migrated.
- **Schema versioned, not feature-flagged.** `schemaVersion: 2` at the top; Convex validates by version; web renderer picks the right view per uploaded version.
- **No PII inflation.** v2 does not add raw keystrokes, raw URLs beyond what v1 already carries in `topPages[].url`, or anything else the desktop scrubs locally.

### Proposed fields (additive)

```ts
interface DaySnapshot {
  schemaVersion: 2                      // was 1
  deviceId: string
  platform: 'macos' | 'windows' | 'linux'   // + linux
  date: string
  generatedAt: string
  isPartialDay: boolean

  // — v1 fields preserved verbatim —
  focusScore: number                    // legacy v1 formula, kept for v1 web renderers
  focusSeconds: number
  appSummaries: AppSummary[]
  categoryTotals: CategoryTotal[]
  timeline: TimelineEntry[]
  topDomains: TopDomain[]
  categoryOverrides: Record<string, Category>
  aiSummary: string | null
  focusSessions: FocusSession[]

  // — v2 additions —
  focusScoreV2: {
    score: number                       // 0–100
    coherence: number                   // 0–1
    deepWorkDensity: number             // 0–1
    artifactProgress: number            // 0–1
    switchPenalty: number               // 0–1
  }

  workBlocks: WorkBlockSummary[]        // NEW — the primary unit
  recap: {
    day: RecapSummaryLite
    week: RecapSummaryLite | null       // null until week has data
    month: RecapSummaryLite | null
  }
  coverage: RecapCoverage               // attribution % + quiet day count
  topWorkstreams: WorkstreamRollup[]    // named + untitled, same honesty rules
  standoutArtifacts: ArtifactRollup[]   // metadata only — no bodies
  entities: EntityRollup[]              // clients/projects routed that day
  hiddenByPreferences: boolean          // true if user had hiddenApps/Domains filters applied
}

interface WorkBlockSummary {
  id: string
  startAt: string
  endAt: string
  label: string                         // current label (user > ai > rule)
  labelSource: 'user' | 'ai' | 'rule'
  dominantCategory: Category
  focusSeconds: number
  switchCount: number
  confidence: 'high' | 'medium' | 'low'
  topApps: { appKey: string; seconds: number }[]   // bounded 3
  topPages: { domain: string; title: string | null; seconds: number }[]   // bounded 3, already-scrubbed
  artifactIds: string[]                 // pointers into standoutArtifacts[]
}

interface RecapSummaryLite {
  headline: string
  chapters: { id: RecapChapterId; eyebrow: string; title: string; body: string }[]
  metrics: { label: string; value: string; detail: string }[]
  changeSummary: string
  promptChips: string[]
  hasData: boolean
}

interface WorkstreamRollup {
  label: string
  seconds: number
  blockCount: number
  isUntitled: boolean
}

interface ArtifactRollup {
  id: string                            // matches ai_artifacts.id on desktop
  kind: 'markdown' | 'csv' | 'json_table' | 'html_chart' | 'report'
  title: string
  byteSize: number
  generatedAt: string
  threadId: string | null
  // No body. Fetched via Convex action only on explicit open.
}

interface EntityRollup {
  id: string
  label: string
  kind: 'client' | 'project' | 'repo' | 'topic'
  secondsToday: number
  blockCount: number
}
```

**Size impact.** Desktop's local `WorkContextBlock` can be fat (evidence arrays, domain breakdowns, AI narratives). v2's `WorkBlockSummary` deliberately projects the narrow subset web needs. Back-of-envelope: a busy day with 15 blocks × ~1 KB per summary = ~15 KB more per snapshot, on top of v1's ~10–40 KB. Still well inside Convex document limits.

### What stays OUT of v2 (on purpose)

- **Raw activity events.** Those are local-only forever. Web does not need them.
- **AI artifact bodies.** Metadata only in the snapshot. If/when web exposes a preview, add a separate Convex action that fetches an artifact on demand from a dedicated table (`web_artifact_bodies`, workspace-scoped, TTL'd) populated on explicit user request from desktop. Keeps the snapshot small and gives the user explicit consent per artifact.
- **AI thread messages.** Web already has its own `web_chats.messages`. Unifying desktop threads + web chats into one pane is a separate problem (see "Open questions").
- **Window titles.** Already scrubbed in v1; stays scrubbed in v2.

## Desktop-side changes (this repo)

- `src/main/services/snapshotExporter.ts` — emit `schemaVersion: 2` and all new fields. Reuse `getTimelineDayPayload` for `workBlocks[]`; reuse `buildRecapSummaries` from `src/renderer/lib/recap.ts` for `recap{}`. Split `recap.ts` into a pure-Node aggregator module if it currently imports any Electron-only bindings (it shouldn't, but confirm — same audit the MCP plan needs).
- `src/main/lib/focusScore.ts` — expose the v2 breakdown components so the snapshot carries them, not just the aggregate score.
- `src/main/services/syncUploader.ts` — no change in cadence; add a single `schemaVersion` constant so v1 ↔ v2 rollout can be forced back if needed.
- `src/shared/snapshot.ts` — new file, single source of truth for the v2 types. Both this repo and `daylens-web` consume it. Publish as an internal package (`packages/snapshot-schema`) that `daylens-web` imports. **The web repo already has `packages/snapshot-schema/snapshot.ts` — unify it instead of forking.**
- `tests/snapshotExporter.v2.test.ts` — new. Fixture payload, assert every v2 field is present, assert Linux platform round-trips, assert `schemaVersion: 1` still buildable for rollback.

## Web-side changes (daylens-web repo)

- `convex/snapshotValidator.ts` — widen `platform` to include `"linux"`. Add v2 fields as `v.optional(...)` so v1 uploads keep validating. Add a branch inside the validator for `schemaVersion: 2` that requires the new fields.
- `convex/schema.ts` — no table changes needed; the snapshot column is validator-driven. Consider adding a `snapshotSchemaVersion: v.number()` top-level field on `day_snapshots` for query-time filtering.
- `convex/snapshots.ts` — queries return v2 where available, fall back to v1.
- `convex/ai.ts` — web AI action now grounds on v2 snapshot fields (workBlocks, recap, topWorkstreams, entities) instead of app-level timeline. Explicit prompt template update; this is the whole reason web-AI was thin.
- `app/(app)/dashboard/DashboardClient.tsx` — render `workBlocks[]` as the primary surface. App summaries become a secondary "evidence" drawer, not the hero.
- `app/(app)/history/HistoryClient.tsx` — per-day drilldown shows block list, workstreams, and the day's `RecapSummaryLite` chapters.
- `app/(app)/chat/page.tsx` + `components/GlobalChat.tsx` — wire the recap promptChips as suggested chips; ground follow-ups on the full v2 payload.
- New `app/(app)/recap/page.tsx` — dedicated recap surface matching the desktop AI tab's recap card. Renders chapters, coverage ribbon, change comparison, top workstreams. Reuses the desktop aggregator output; doesn't recompute anything.
- `packages/snapshot-schema/snapshot.ts` — swap local `computeFocusScore` (v1) for a shim that reads `focusScoreV2.score` when present, falls back to `focusScore` (v1) otherwise, so legacy v1 snapshots keep rendering.

## Privacy and truthfulness posture

- **What web can show ≤ what desktop shows.** Hard invariant. If the desktop's local view scrubs a URL, web must scrub it too.
- **Workspace hiddenApps/hiddenDomains already in Convex** (`workspace_preferences`). v2 snapshots must honor them server-side before they reach the renderer — do the filter inside the Convex query, not in the Next.js client, so the browser never holds hidden data.
- **`hiddenByPreferences: boolean`** on the snapshot tells the UI to show a small honesty ribbon ("some apps and sites are hidden per your preferences") instead of quietly producing shorter totals.
- **No mobile yet.** Mobile is out of scope for v2. v3 is where it lands, and v3 includes the write-back contract. Calling v2 "mobile-ready" now would be the same overclaim the current `aiSummary` field represents.

## Rollout phases

- **Phase 0 — this doc and sister `.intent/web-docs-refresh.md`.** Review, push back, lock scope.
- **Phase 1 — unblock Linux.** Widen `platform` validator. Ship to Convex. Confirm a Linux desktop can link and sync without errors. Ten-line change; can ship on its own the same day.
- **Phase 2 — snapshot v2 contract frozen.** Write `src/shared/snapshot.ts` in this repo and mirror into `daylens-web/packages/snapshot-schema/snapshot.ts`. Typecheck both repos against it. No runtime change yet.
- **Phase 3 — desktop uploads v2.** `snapshotExporter.ts` emits v2 for all new syncs. Convex validator accepts both v1 and v2. Rollout is gated behind a `DAYLENS_SNAPSHOT_V2=1` env at first; flip to default after one week of clean syncs from the author's own machines.
- **Phase 4 — web renders v2.** Dashboard, history, and AI chat all read the new fields. Recap surface ships as a new route. App-level timeline stays as a secondary drawer.
- **Phase 5 — entity and artifact surfaces.** Web shows routed entities and artifact metadata. Artifact bodies stay gated behind per-artifact explicit-open actions.
- **Phase 6 — prune v1 if/when safe.** After all linked desktops have shipped v2, stop writing v1 fields. Keep reading v1 for historical snapshots until N months of history has been converted or aged out.
- **Phase 7 (separate plan) — mobile.** New `.intent/mobile.md` that designs the write-back contract before a single line of mobile code is written.

Each phase ships with a status line in `docs/ISSUES.md` using the same `implemented pending verification` language as the rest of the repo. Nothing graduates to "landed" until real-device validation has happened on macOS, Windows, and Linux.

## Concrete acceptance tests (for the implementer)

- Fresh Linux desktop can `createWorkspace` → upload a snapshot → web dashboard renders it, without any Convex error in logs.
- A v1 snapshot still in `day_snapshots` still renders cleanly in the web dashboard after the v2 rollout.
- The web recap surface's copy for a given day matches the desktop AI surface's recap card word-for-word (same aggregator output, no re-computation).
- `workBlocks[]` in the snapshot contains the same number of blocks as the desktop shows in Timeline for that day (± live-session block, which is correctly marked `isLive` on desktop and excluded from the snapshot if not yet closed).
- `hiddenApps` and `hiddenDomains` from `workspace_preferences` actually remove matching entries from `appSummaries`, `topDomains`, `workBlocks[].topApps`, and `workBlocks[].topPages`.
- A Focus Score v2 breakdown for a day's snapshot is bit-for-bit identical to what `computeFocusScoreV2` produces locally on the desktop that uploaded it.
- `test:ai-chat` and `test:entity-prompts` still pass on the desktop after `snapshotExporter.ts` changes.

## Open questions for Tonny

1. **Shared package home.** Publish `packages/snapshot-schema` as `@daylens/snapshot-schema` on npm and have both repos depend on it? Or symlink / vendor it? npm is cleanest for future mobile, worst for iteration speed during active design.
2. **Artifact bodies on web.** Do you want web users to be able to open an AI artifact's body (markdown, chart HTML) from the web dashboard? If yes, Phase 5 grows — we need a second Convex table for body uploads, size limits, retention policy, per-artifact user consent. If no, keep metadata-only forever and web always links out to "open on desktop."
3. **Thread unification.** Desktop has `ai_threads` + `ai_artifacts`. Web has `web_chats`. Today they're parallel worlds. Do we converge them (one thread table, web is just another device typing into it), keep them parallel (each is a separate conversation that happens to share context), or pick one as canonical? This is the biggest design question in the whole plan and deserves its own `.intent/ai-thread-parity.md` before any code.
4. **Recap on web for long histories.** Desktop computes recap from the previous month's data window. Web snapshots are uploaded per-day. The web recap view needs to either (a) query N days of snapshots and aggregate server-side in a Convex query, or (b) embed the already-aggregated recap in each day's snapshot (what this plan proposes). Option (b) is simpler but means the recap for "this month" is baked in at each day's upload time and goes stale if the user edits a block label afterward. Accept the staleness, or add a "recompute recap on read" Convex action for the current week/month?
5. **Focus Score v1 on historical snapshots.** Do we back-compute v2 for pre-v2 snapshots (a one-off Convex mutation) or accept that old dashboards show v1 numbers and new ones show v2? The honest option is the second, with a visible "legacy score" label on pre-v2 days.
6. **Daylens-web repo consolidation.** ARCHITECTURE.md still describes the three-repo world. Before any of this work starts, decide: keep `daylens-web` as a separate repo (sibling to `daylens`) or fold it in as an app inside this monorepo? The sibling layout makes sense today; the monorepo layout makes sense once the snapshot schema is shared.

## What this doc is not

- Not a promise to start implementing. Code starts after you review and accept (or reshape) the contract.
- Not a mobile plan. Mobile is Phase 7 with its own separate doc.
- Not a marketing-site plan. `REDESIGN.md` in the web repo is a separate concern and gets its own short note in `.intent/web-docs-refresh.md`.
- Not an auth refactor. The existing BIP39 + ES256 JWT + HttpOnly cookie scaffolding is correct and stays as-is.
