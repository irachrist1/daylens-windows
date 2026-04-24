# Daylens MCP — Work-context server for coding tools

Plan only. No code shipped yet. Status: `draft, awaiting user review`.

## Why this exists

Tonny's coding tools (Claude Code, Codex, Cursor, Zed, etc.) don't know what work he's been doing until he types it into the prompt. Daylens already has the answer locally: named work blocks, live session, focus sessions, top workstreams, standout artifacts, daily/weekly/monthly recaps, and 500+ routed entities in SQLite.

An MCP server turns that local knowledge into first-class tool calls those assistants can make on their own. Concretely: when Tonny says "help me finish what I was working on" inside Claude Code, the assistant should be able to call `daylens.current_session` and `daylens.recent_blocks` instead of asking him to describe it.

This is a strict extension of the existing local-first contract. No data leaves the machine unless the *calling* assistant sends it outbound itself, and the assistant only sees what the user already sees inside Daylens.

## Product shape

One sentence: **a read-only MCP server that exposes Daylens's own timeline, recap, workstream, and artifact data to any MCP-capable client on the same machine, over stdio, with no network surface and no write paths.**

### Scope rules (locked before any code)

- **Read-only in v1.** No mutating tools. No "start focus session" or "rename block" from MCP. Those are product surfaces and belong in the app. Keeps the blast radius zero.
- **Local transport only.** stdio first (works with Claude Code, Cursor, Codex out of the box). No HTTP/TCP listener in v1 — even on loopback, that creates a surface area we don't need.
- **Single source of truth is the live Daylens SQLite file** at `~/Library/Application Support/Daylens/daylens.sqlite` (macOS; platform-appropriate paths for Windows/Linux). better-sqlite3 opened `readonly`, WAL-friendly, no locks on the running app.
- **Shared types, shared aggregator.** Reuse `src/shared/types.ts` and `src/renderer/lib/recap.ts` so MCP output and in-app output can never drift. If we can't reuse them we have architectural debt to address first.
- **PII posture = exactly what the user already sees in the app.** Same allow-list scrubber the analytics pipeline uses. Never return raw URLs, raw window titles, or keystroke content beyond what the app already surfaces.

### Non-goals for v1

- No multi-user / remote access.
- No write tools (rename, override, start/stop tracking).
- No Daylens-app running requirement — v1 must work against the SQLite file even when Daylens itself is closed, because coding tools are often opened first.
- No provider-backed AI calls from the MCP server. It ships evidence, not generated prose. If the calling assistant wants a summary, it generates one from the evidence it fetched.

## Tools to expose (v1)

Each is a standard MCP tool with a JSON-Schema input and a typed output.

| Tool | Purpose | Input | Output |
|---|---|---|---|
| `daylens.current_session` | What is the user actively doing right now? | none | `{ active: boolean, startedAt, durationSeconds, label, dominantCategory, topApp, evidenceSummary }` |
| `daylens.recent_blocks` | Last N work blocks across days. | `{ limit?: number (default 10, max 50), sinceHours?: number }` | `WorkContextBlockSummary[]` (pared-down `WorkContextBlock`) |
| `daylens.blocks_by_date` | All blocks for a date or range. | `{ date?: "YYYY-MM-DD", from?, to?, label?: string }` | `WorkContextBlockSummary[]` |
| `daylens.recap` | Deterministic daily/weekly/monthly recap. Wraps `buildRecapSummaries`. | `{ period: "day" \| "week" \| "month", date?: "YYYY-MM-DD" }` | `RecapSummary` (chapters, metrics, workstreams, coverage) |
| `daylens.top_workstreams` | Top workstreams over a range. | `{ period, date?, limit?: number }` | `{ label, seconds, blockCount, isUntitled }[]` |
| `daylens.focus_sessions` | Recent focus sessions with durations and planned apps. | `{ sinceHours?: number, limit?: number }` | `FocusSessionRow[]` |
| `daylens.artifacts` | Query AI-generated artifacts. | `{ threadId?, kind?, sinceHours?, limit? }` | `AIArtifactRecord[]` (without file bodies unless `include: "preview"`) |
| `daylens.artifact_body` | Fetch a single artifact's content. | `{ id: number }` | `{ content, byteSize, mimeType }` |
| `daylens.entities` | List routed entities (clients/projects) and their recent block coverage. | `{ kind?: "client" \| "project", limit? }` | `{ id, label, kind, recentSeconds, recentBlockCount }[]` |
| `daylens.search_evidence` | Text search across block evidence (app names, page titles, document labels). | `{ query: string, sinceHours?, limit? }` | `{ blockId, label, date, matchType, snippet }[]` |
| `daylens.platform_status` | What tracking capability is available on this machine right now. | none | `{ platform, tracker, hasPermission, notes }` |

`WorkContextBlockSummary` is a deliberately narrower view than the in-app `WorkContextBlock` — no `topArtifacts[].openTarget`, no raw `evidenceSummary.pages[].url`, no keystroke-like fields. The in-app view can show raw URLs because it's the user's own window; MCP hands data to a third-party assistant process and should hand less.

## Prompts (v1)

MCP supports server-defined prompt templates. Two are load-bearing for coding tools:

- `daylens/what-was-i-doing` — returns a single packaged prompt that calls `current_session` + `recent_blocks(limit: 5)` and formats it as a grounded context block for the assistant to read before answering.
- `daylens/this-week-in-my-work` — calls `recap(period: "week")` and renders it as a compact briefing.

Both prompts are just convenience — the same data is reachable via the tools.

## Transport and packaging

- **Transport:** stdio MCP over JSON-RPC. No HTTP.
- **Runtime:** Node >= 20 (aligns with Daylens's existing toolchain). No Electron dependency — the MCP server must be runnable headlessly so `npx daylens-mcp` works on fresh machines.
- **Distribution (in order of priority):**
  1. `npx @daylens/mcp` — primary. The user adds one line to `~/.claude.json` / Cursor config / Codex config and it works.
  2. A `daylens mcp` subcommand baked into the packaged app for users who already have Daylens installed. Same binary, different entry point.
  3. Homebrew/WinGet later if demand justifies it.
- **Repo layout proposal:**
  - `src/mcp/server.ts` — bootstraps stdio transport, registers tools.
  - `src/mcp/tools/*.ts` — one file per tool; imports the shared aggregator where possible.
  - `src/mcp/db.ts` — opens SQLite readonly, resolves platform-specific userData path, honors `DAYLENS_DB_PATH` env override for tests.
  - `src/mcp/entry.ts` — CLI entrypoint (`#!/usr/bin/env node`), wired into `package.json` `bin`.
  - `tests/mcp/*.test.ts` — table-driven tests per tool that boot the server in-process and exercise via the MCP SDK's client.
- **No Electron imports.** The MCP server must be pure Node so `npx` works without building a full Electron app. That's a hard architectural constraint and one reason to audit what `recap.ts` imports — if it pulls Electron-only modules, it needs to be split.

## Privacy and truthfulness posture

This is where the plan needs the most care, because MCP output crosses a trust boundary.

1. **Output never exceeds in-app visibility.** Anything the user can't see in Timeline / Apps / AI today stays out of MCP output for now.
2. **No raw URLs or page titles by default.** Replace with domain + derived label (the same transform `src/main/services/analytics/scrub.ts` already does). Add an explicit `daylens.search_evidence` opt-in for cases where a coding tool genuinely needs a URL/filename to ground a question — gate it behind a config flag (`DAYLENS_MCP_ALLOW_RAW_EVIDENCE=1`) so it's deliberate.
3. **No keystroke / content data ever.** Already true in the app. MCP must not regress this.
4. **Artifact bodies gated.** `daylens.artifacts` returns metadata only; `daylens.artifact_body` requires an explicit ID, so the calling assistant has to have seen the metadata first. Prevents "list and dump everything" patterns.
5. **Audit log.** Every tool invocation logged to `~/Library/Application Support/Daylens/mcp.log` with tool name, args shape (not values), and byte-size returned. Opt-out via env var, but on by default. Transparent to the user.
6. **No telemetry from the MCP server in v1.** Not a hill to die on; can be added later as an opt-in. First, ship honest.

## Integration with the existing contract

Cross-checked against `docs/AGENTS.md`:

- **Top-level nav is Timeline / Apps / AI / Settings** — MCP doesn't add a nav surface, it's a separate process.
- **Build priorities (tracking → persistence → timeline → AI → apps → settings)** — MCP reads persisted state and timeline; it's downstream of priorities 1–3. Doesn't change them.
- **Cross-platform parity** — `npx @daylens/mcp` must work on macOS, Windows, and Linux with the correct userData path resolution. Add a `platform_status` tool that is honest about Linux X11/Wayland capability and macOS permission state so the coding tool can surface "tracking is currently limited on this machine" to the user.
- **Truthfulness lens per `docs/CLAUDE.md`** — v1 status in `docs/ISSUES.md` must read `implemented pending verification` for anything other than unit tests; real-client validation (Claude Code + Cursor + Codex) is a separate pass.

## Phases

Each phase is ship-and-stop, with its own status line in `docs/ISSUES.md`.

- **Phase 0 — this doc.** Review and lock scope.
- **Phase 1 — read-only core.** `current_session`, `recent_blocks`, `blocks_by_date`, `top_workstreams`, `recap`. Backed by table-driven tests against a sandbox SQLite fixture. `npx @daylens/mcp` works. Config snippets for Claude Code documented in README.
- **Phase 2 — artifact + evidence surface.** `artifacts`, `artifact_body`, `search_evidence`, `focus_sessions`, `entities`. Gated evidence flag. Audit log.
- **Phase 3 — packaged-app subcommand.** `daylens mcp` inside the Electron bundle, shares the same handler code. Useful for users who already have Daylens installed and don't want a separate npx package.
- **Phase 4 — live-session bridge (optional).** When Daylens is running, prefer an in-memory handoff over the SQLite read for `current_session`, so the live block's duration is fresh to the second instead of last-persisted. Wire via a tiny Unix-socket / named-pipe bridge the main process exposes. No network.
- **Phase 5 — real-client validation.** Drive it end-to-end from Claude Code, Cursor, and Codex. Measure latency, error rate, and what coding questions actually benefit. Only after this pass does anything graduate from `implemented pending verification` in ISSUES.md.

## Open questions for Tonny

1. **Package name.** `@daylens/mcp` vs `daylens-mcp` vs folded into `daylens` CLI? Default: `@daylens/mcp` on npm, also exposed as `daylens mcp` once the packaged app ships with a CLI entry.
2. **Do we ship Phase 1 publicly (npm) or privately-scoped?** Private scope is safer while the tool surface is still settling.
3. **Evidence raw-URL opt-in.** Is `DAYLENS_MCP_ALLOW_RAW_EVIDENCE=1` the right shape, or should it be a per-tool MCP client capability the user toggles inside the Daylens Settings surface (cross-device synced)? The second is more honest but couples MCP to the app being open.
4. **Testing story.** Stand up a fixture SQLite in `tests/mcp/fixtures/daylens.fixture.sqlite` with deterministic content, or build fixtures programmatically at test time like `tests/recap.test.ts` already does? The second is easier to evolve.
5. **Does the MCP server count as "shipped functionality that must have cross-platform parity from day one"?** Per the hard rule in AGENTS.md, yes. That means Phase 1 can't ship until Windows + Linux userData path resolution and platform_status truthfulness are covered.

## What this doc is not

- Not a promise to start coding. That happens after you review.
- Not a substitute for `docs/ISSUES.md` — nothing here is `done`, `landed`, or even `in progress` until it is.
- Not an architecture-rewrite trigger. It reuses what's already proven (SQLite, recap aggregator, shared types).
