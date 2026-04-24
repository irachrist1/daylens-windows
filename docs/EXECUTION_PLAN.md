# Daylens — Execution Plan (Q2 2026)

Single reference for the AI agent executing this work. Before starting any task:
read this document fully, then read `docs/OVERVIEW.md` for how the system
actually works today. Do not read old product docs — they are outdated; code is
truth.

---

## 0. What we're building toward

Daylens is a local-first Electron desktop work tracker. Two product modes under
one app, sharing one evidence layer:

- **Reflection ("Spotify Wrapped for your workday")** — daily/weekly recap,
  trends, distraction totals. Mostly works today; needs honest numbers and
  better writing.
- **Recall ("Google for your workday")** — ask anything, find anything. Today
  this is architecturally broken because the AI gets pre-aggregated stats, not
  the ability to query rows. Fixing this is the centerpiece of Q2.

**The "holy shit" moment we are sequencing toward:** a new macOS user installs
without a Gatekeeper fight, uses Daylens for a few days, types *"what did I work
on Wednesday?"* into AI chat, and gets a grounded answer with specific app
names, times, and artifact references pulled live from their own SQLite.

Everything in this plan ladders to that moment as fast as possible.

---

## 1. Rules of engagement

### 1.1 Scope discipline

- Each task names **files in scope** and **files off-limits**. Do not touch
  off-limits files. If you think an off-limits file needs changing, stop and
  surface it — do not silently expand scope.
- No "while I'm in here" refactors. No renaming for consistency. No extracting
  helpers that weren't asked for. Additive changes only unless a task says
  otherwise.
- No new npm dependencies unless the task explicitly allows one.

### 1.2 Testing discipline

- **Tests verify behavior that matters, not coverage theater.** The existing
  repo writes behavior tests under `tests/` using the `ts-loader.mjs` pattern.
  Match that.
- **One meaningful test per user-visible behavior.** Not one test per function.
  If you catch yourself writing the fifth variant of the same test, the code is
  wrong, not the test coverage.
- Prefer integration tests over unit tests for DB/IPC/AI flows.
- Do not mock SQLite. Use real SQLite against a temp DB.
- Do not add snapshot tests for UI unless the task asks for them.
- Existing tests must still pass. If one breaks because the behavior legitimately
  changed, update the test and say why in your report. Never delete a test to
  make CI green.

### 1.3 Cleanup

- "Done" means: typecheck passes, tests pass, the feature works when run in
  `npm run dev`, and no scaffolding is left behind.
- Remove spike scripts, throwaway benchmarks, and console.logs before reporting
  done — unless the task specifies keeping them.
- No `TODO:` comments for things you could have completed. No commented-out
  code. No `// removed X` markers.
- If you touched a file and left it in a worse state than you found it, you are
  not done.

### 1.4 Innovation lane

You are **expected to push back** on the plan when you have a better idea. Do
this explicitly, not silently. Format:

> **Proposed deviation:** [one line]
> **Why:** [what's better about it]
> **Cost of being wrong:** [what we lose if this choice is worse than the plan]
> **Waiting for:** approval / proceeding unless vetoed

Two modes:

- **Within-task innovation** (different implementation of the same outcome) —
  proceed unless the user vetoes within your next message.
- **Scope or outcome change** — wait for explicit approval.

Do not silently ignore the plan. Do not rewrite the plan into your own plan.
Surface, justify, proceed or wait.

### 1.5 Kill gates

Two tasks in this plan have explicit kill gates (Task C and Task E). If the
gate fails, **stop and report**. Do not "push through." Do not "just try anyway."
The gate exists because the cost of continuing on a failed gate is higher than
the cost of pausing.

### 1.6 Reporting format

At the end of every task, report in this shape. Keep it short.

```
## Result
[One line: shipped / blocked / killed-by-gate]

## What changed
- file:line — one-line summary
- ...

## How I verified it works end-to-end
[Concrete: "ran `npm run dev`, typed X in the search box, got Y results.
Pasted full output below." Typecheck passing alone is not verification.]

## Deviations from plan
[Any "Proposed deviation" you acted on, and why.]

## What I left undone that a reasonable reader might assume was included
[Be honest. This is the most important section.]

## Numbers / benchmarks (if the task required them)
```

---

## 2. Codebase map (only the parts you'll touch)

Read these files before the task that touches them. Do not read everything.

### 2.1 Storage

- `src/main/db/migrations.ts` — additive migrations. Every new migration is
  idempotent and doesn't rewrite history.
- `src/main/db/queries.ts` — all SQL lives here. Follow existing patterns
  (prepared statements, typed returns).
- `src/main/db/schema.ts` — type definitions for rows.
- SQLite lives at `~/Library/Application Support/Daylens/daylens.sqlite` on
  macOS. `better-sqlite3` already supports FTS5; no new dep needed.

### 2.2 Main-process services

- `src/main/services/ai.ts` — ~4000 lines. The whole AI layer. Key anchors:
  - `buildDayContext` starts around line 1909 — today's pre-aggregated context.
  - `buildAllTimeContext` at 1850-1907 — lifetime pre-aggregated context.
  - Main chat system prompt at **3904-3935** — where persona, grounding rules,
    and context are assembled.
  - `DISTRACTION_DOMAINS` at line 1869 — constant.
  - `routeInsightsQuestion` (deterministic router, imported from
    `src/main/lib/insightsQueryRouter.ts`) — fast path. Keep it.
  - Provider adapters: `sendWithAnthropic` (line 855), `sendWithOpenAI` (line
    888), `sendWithGoogle` (line 945). Output caps: `max_tokens: 1024` /
    `max_output_tokens: 1024`.
- `src/main/services/aiOrchestration.ts` — job policy, redaction, provider
  selection.
- `src/main/services/settings.ts` — electron-store backed. `userName: ''` at
  line 27 is the dead field you will wire.
- `src/main/services/onboarding.ts` — onboarding state reconciliation.
- `src/main/services/tracking.ts`, `browser.ts`, `workBlocks.ts` — **off-limits
  unless a task explicitly includes them**.

### 2.3 IPC + preload

- `src/main/ipc/` — one file per handler group. Follow the pattern; name new
  handler groups like `search.handlers.ts`.
- `src/preload/index.ts` — typed API under `window.daylens`. Add new
  namespaces here (e.g. `window.daylens.search.*`).

### 2.4 Renderer

- `src/renderer/views/Insights.tsx` — AI chat surface. This is where search
  UI lands.
- `src/renderer/views/Onboarding.tsx` — stages. Personalize stage around line
  679-710.
- `src/renderer/views/Settings.tsx` — settings editor.
- `src/renderer/views/Timeline.tsx`, `Apps.tsx` — **off-limits unless task says
  otherwise**.

### 2.5 Focus score

- `src/main/lib/focusScore.ts` — `computeFocusScoreV2`. The formula you will
  replace.
- `tests/focusScoreV2.test.ts` — the test suite you will rewrite.

### 2.6 Tests

- `tests/` with `tests/support/ts-loader.mjs` — the pattern to follow.
- Run tests with the command visible in existing ELECTRON_RUN_AS_NODE
  invocations in CI or recent commits.

---

## 3. The work

Five units of work. Critical path is A → C → D → E. B runs in parallel with A.
Apple notarization (M) is founder work, not agent work.

---

### Track M — Apple notarization (founder, not agent)

**Outcome:** Users install Daylens on macOS with one dialog (Apple-verified)
instead of the "damaged" / "unidentified developer" dance.

Enroll in Apple Developer Program ($99). Generate a Developer ID Application
certificate. Add GitHub Actions secrets: `MAC_CERTIFICATE_FILE`,
`MAC_CERTIFICATE_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`,
`APPLE_API_ISSUER`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.
`.github/workflows/release-macos.yml:82-90` auto-detects signing mode; no code
change needed. Push a `vX.Y.Z-mac` tag, download the DMG, verify install UX
on a clean macOS VM.

Kill condition: if Apple approval takes >10 business days, hire an Electron
notarization freelancer on Upwork ($200-400 budget). Do not let paperwork block
the product.

---

### Task A — FTS5 search layer

**Outcome:** A user can type "Figma" into the AI view's new search box and
get back a chronological list of every session, block, browser page, and
artifact where "Figma" appears, with date + time + highlighted excerpt. No AI
involved. This is the foundation for Task D and proves recall is useful before
any model work.

**Files in scope:**

- `src/main/db/migrations.ts` (new migration file, additive)
- `src/main/db/queries.ts` (add search functions)
- `src/main/ipc/search.handlers.ts` (new)
- `src/preload/index.ts` (expose `window.daylens.search.*`)
- `src/renderer/views/Insights.tsx` (add search input + results list)
- `tests/search.test.ts` (new)
- `scripts/benchmark-fts5.mjs` (new, **delete before "done"**)

**Files off-limits:** everything else.

**Spike first (cannot skip):**

Before writing the migration, create `scripts/benchmark-fts5.mjs`:

1. Temp SQLite DB.
2. Insert 365 days × 30 sessions/day of synthetic `app_sessions` with realistic
   window titles ("VS Code - daylens/src/...", "Chrome - <article title>",
   "Slack", "Zoom Meeting", "Figma - <project>", plus noise).
3. Build the proposed FTS5 schema.
4. Run 20 MATCH queries across classes: single-word, multi-word, phrase,
   rare-word, common-word, with date filter, without date filter.
5. Report p50 / p95 / p99 latency per class; total DB size; index size.

Run it. **Report numbers before building the migration.** If p95 on any class
exceeds 300ms, pause and propose options (partitioned indexes, external-content
tables, etc.) — do not silently work around.

**FTS5 tables to build:**

- Over `app_sessions` indexing `app_name`, `window_title`.
- Over `timeline_blocks` indexing current label + merged labels.
- Over `website_visits` indexing `url`, `page_title`.
- Over `ai_artifacts` indexing `title`; and `content` only when stored inline
  (<32KB).

Use the external-content FTS5 pattern so we don't duplicate data. Triggers on
insert/update/delete keep the index in sync. Backfill on first run.

**Search API (in `queries.ts`):**

```ts
searchSessions(query: string, opts: { startDate?: string; endDate?: string; limit?: number }): SessionSearchResult[]
searchBlocks(query, opts): BlockSearchResult[]
searchBrowser(query, opts): BrowserSearchResult[]
searchArtifacts(query, opts): ArtifactSearchResult[]
```

Each returns FTS5 `snippet()` output for highlighted excerpts. Date filtering
is a WHERE clause against the base table timestamps, not inside the MATCH
expression.

**UI:**

Add a simple search input at the top of `Insights.tsx`. Debounce 150ms. Show
results as a flat chronological list: icon / app name / window title or page /
date+time / highlighted excerpt. Click a result → open the right detail view
(timeline scrolls, artifact opens, etc.). No animations. No filters beyond date
range. This is a utility surface for now.

**Success criteria:**

- Typecheck passes.
- `tests/search.test.ts` passes: covers (1) insert-then-search, (2) update
  keeps index in sync, (3) delete removes from index, (4) date filter works,
  (5) one query per search function against real SQLite. **Five tests total, not
  twenty.**
- Benchmark numbers from the spike pasted in your report.
- You ran `npm run dev`, typed 3 real queries, pasted the results.
- `scripts/benchmark-fts5.mjs` deleted from the working tree (it's a spike,
  not shipped infrastructure).

---

### Task B — Onboarding wiring + focus score rework

**Outcome:** Three small, honest fixes shipped together.

1. User sets a name in onboarding / Settings. The AI uses it in the persona
   line.
2. The "reduce distractions" and "deep-work" onboarding goals actually change
   what the AI's daily context contains.
3. Focus score stops returning ~20 on zero input. A single honest number:
   percentage of active time in deep-work sessions.

**Files in scope:**

- `src/renderer/views/Onboarding.tsx` (personalize stage ~line 679-710)
- `src/renderer/views/Settings.tsx` (profile section)
- `src/main/services/settings.ts` (persist name if not already; confirm goals
  are persisted)
- `src/main/services/ai.ts` — **only** `buildDayContext` (line 1909+). Do not
  touch the system prompt, routing, or any other function in this file.
- `src/main/lib/focusScore.ts` (replace computeFocusScoreV2)
- Call sites of the old focus score (find via `grep -rn computeFocusScoreV2
  src/`)
- `tests/focusScoreV2.test.ts` (rewrite)
- Renderer components that visualized the 4-term score (collapse to 1 number
  + 3 small supporting numbers)

**Files off-limits:** everything else, especially all of `ai.ts` outside
`buildDayContext`.

**1. Name capture:**

- Add a text input to the personalize stage. Label: *"What should Daylens call
  you?"* Optional. Default placeholder pulled from `os.userInfo().username` on
  first load. Persist via the IPC that already saves goal chips.
- Add the same field to Settings so the user can change it later.
- Do not touch `ai.ts` — it already reads `settings.userName` correctly at
  line 3895-3898 and line 1941. Once the field is populated, persona works.

**2. Goals → behavior:**

Two goal→behavior wires. Both live in `buildDayContext` only.

- If goals include `less-distraction`: prepend a line `Distraction today: X
  minutes across [top 3 distraction domains today]` using the
  `DISTRACTION_DOMAINS` constant already at `ai.ts:1869`.
- If goals include `deep-work`: prepend `Deep work today: X minutes across Y
  sessions. Longest streak: Z minutes.` using the new focus score helper
  (Task B part 3).

The other two goals (`understand-habits`, `ai-insights`) stay collected-but-
unused. That's fine — note it honestly in your report.

**3. Focus score rework:**

Delete the 4-term weighted formula. Replace with:

```
deepWorkPct = round(100 * totalDeepWorkSeconds / totalActiveSeconds)
```

A deep-work session is any continuous active period of **25+ minutes** within
a single app category (same "focused" categories the existing code uses).
Return:

```ts
{
  deepWorkPct: number | null,     // null if totalActiveSeconds < 1800
  longestStreakSeconds: number,
  switchCount: number,
  deepWorkSessionCount: number,
}
```

Null means "Not enough data" in the UI — don't render a number.

Fix every call site. Any caller reading the old `.coherence`, `.switchPenalty`,
`.artifactProgress`, or `.deepWorkDensity` fields must be updated to use the
new fields or have the reference removed. Grep; don't guess.

**Renderer:** any component that drew 4 weighted bars collapses to one
percentage + 3 small supporting numbers beneath. Do not design a new
visualization. Simpler is better.

**Tests:** rewrite `tests/focusScoreV2.test.ts` against the new definition.
Keep edge cases (empty input → null, single 25-min session → 100,
interruption breaks a streak, category change breaks a streak). **~6 tests
total. Don't add more just to pad.**

**Success criteria:**

- Typecheck passes.
- All tests pass including the rewritten focus score suite.
- `npm run dev`: set a name, complete onboarding, see your name in AI persona
  output. Pick "less-distraction" goal, check that today's chat context
  includes the distraction line (log it or paste a screenshot).
- Report includes focus score values for 3 real days from your own
  daylens.sqlite — do they pass a gut-check?

---

### Task C — Tool schemas + prompt-engineering spike (KILL GATE)

**Outcome:** Either (1) we have proof that current frontier models can reliably
call well-designed tools to answer recall questions, and a tool schema file
ready to integrate — or (2) we know tool-use won't work for our data shape and
we fall back to expanded static context. No integration code written this task.

**Files in scope:**

- `src/main/services/aiTools.ts` (new; schema definitions only)
- `scripts/spike-toolcalls.mjs` (new spike; **delete before "done"** unless
  it becomes the regression harness for Task D — decide in report)

**Files off-limits:** `ai.ts`, `aiOrchestration.ts`, all IPC, all renderer.
This task writes **no production code** except `aiTools.ts`.

**Deliverable 1 — Tool schemas:**

Starting set (deviate only with justification):

```
searchSessions(query, startDate?, endDate?, limit?)
getDaySummary(date)
getAppUsage(appName, startDate?, endDate?)
searchArtifacts(query)
getWeekSummary(weekStartDate)
getAttributionContext(entityName)
```

For each tool in `src/main/services/aiTools.ts`:

- TypeScript parameter interface.
- TypeScript return interface.
- JSON Schema for Anthropic's `tools` parameter.
- JSON Schema for OpenAI function calling format.
- One-sentence description the model sees.
- Per-parameter description.

The file exports schemas. Nothing imports it yet. That's expected.

**Deliverable 2 — The spike (this is the kill gate):**

Create `scripts/spike-toolcalls.mjs`:

1. Load schemas from `aiTools.ts`.
2. 15 representative queries — use exactly these, do not invent new ones:
   - "What did I work on last Wednesday?"
   - "When did I last use Figma?"
   - "Compare my coding time this week vs last week."
   - "What's my most-used app this month?"
   - "Show me every session where I was in Figma in March."
   - "What was I doing between 2pm and 4pm last Friday?"
   - "Which days last week did I have the most deep work?"
   - "How long did I spend on ClientX work in the last 30 days?"
   - "What documents did I touch yesterday?"
   - "Summarize my Monday."
   - "Did I work on the Daylens repo this morning?"
   - "What was I reading on Hacker News last week?"
   - "When did I last have a meeting with Sarah?"
   - "What apps do I use most on Fridays?"
   - "Show me my longest deep work session this week."
3. Send each to Anthropic (claude-sonnet-4-6 or claude-opus-4-7) **and** OpenAI
   (gpt-5.5 or current flagship) with system prompt `"You have tools to query
   a local work tracker. Use them to answer the user's question. Today is
   [YYYY-MM-DD]."` + the tool schemas. Capture the tool calls.
4. Grade per query per model:
   - `correct_tool_chosen` (yes / no)
   - `parameters_correct` (yes / partial / no)
   - `would_have_answered` (yes / no — if the tool returned sensible data,
     could the model synthesize a good answer?)
5. Output a markdown table.

**Kill-gate decision:**

- **≥12/15 across both models with correct tool + correct|partial params →
  proceed to Task D.**
- 8-11/15 → report, propose schema changes, human decides re-spike vs proceed.
- <8/15 → tool-use is not ready. Propose fallback: expand `buildAllTimeContext`
  and `buildDayContext` to include last 7 days of pre-aggregated context. Task
  D becomes that instead.

**Success criteria:**

- `aiTools.ts` committed with all schemas.
- Spike output table pasted in report.
- Clear go/no-go recommendation.
- `scripts/spike-toolcalls.mjs` decision documented (delete vs keep as
  regression harness — state which and why).
- Total spike cost should be <$2. Paste actual cost from API dashboards.

---

### Task D — Tool-use integration (only runs if Task C gate passes)

**Outcome:** A user typing a recall question that the deterministic router
can't handle ("what was I doing between 2 and 4 last Friday?") gets a grounded
answer produced by the model calling our tools and synthesizing over real
rows. Deterministic router stays as fast path. No regression on questions the
router already answers.

**Files in scope:**

- `src/main/services/ai.ts` — **only the freeform fallback path**, the section
  starting around line 3887. Do not refactor other parts of this file while
  you're in there, even if tempted.
- `src/main/services/aiTools.ts` (wire schemas into provider calls)
- IPC handlers for the tool-backing queries (they mostly exist from Task A; add
  wrappers only where missing)
- `tests/aiToolUse.test.ts` (new)

**Files off-limits:** deterministic router, block labeling, weekly brief
synthesis, day summary generation, report generation, follow-up suggestions.
All of those stay static-context for now.

**Architecture:**

- In the freeform fallback path (today's behavior: assemble huge context string
  → stuff into system prompt → send), swap to: small system prompt describing
  tools + today's lightweight context only → send with `tools` parameter →
  handle tool_use response blocks in the streaming handler → execute tool →
  return result → loop until the model emits a final text response.
- Provider coverage: Anthropic (primary), OpenAI (fallback). **Do not add
  tool-use to Google in this task.** Google stays on the old static-context
  path as a degraded fallback; this is intentional scope control.
- Tool execution happens in main process. Reuse query functions from Task A
  where possible; add thin adapters only where a tool needs a shape the queries
  don't return.
- Hard limit: max 5 tool calls per user message. If the model wants a 6th,
  force a final answer. This prevents runaway loops.
- Budget: max 8000 input tokens post-tool-results per turn. Truncate tool
  results if needed (oldest first) and tell the model in-stream that you did.

**Testing:**

Reuse `scripts/spike-toolcalls.mjs` if you kept it — or write
`tests/aiToolUse.test.ts` that runs 8 representative queries against the
**real tool-use path** (real provider, real DB) and asserts:

- Model called at least one tool.
- Tool params were parseable.
- Final answer references a fact that only a tool could have produced
  (specific time range, specific app session duration).

These tests cost real API money. Run sparingly. Mark them `.skip()` by default
and add a script to run them intentionally (`npm run test:toolcalls`). Leave
them out of default CI.

**Kill condition:** if final-answer quality on the 15-query set from Task C
is worse than the current static-context path on more than 6/15 questions,
revert and fall back to expanded static context. Do not ship regressions.

**Success criteria:**

- Typecheck passes.
- Existing test suite passes.
- 8-query behavior test passes when run with real keys.
- Manually ran 10 of the 15 Task C queries in `npm run dev`, pasted
  question + answer for each in report. Grade each: correct / partial / wrong.
- Deterministic router questions ("how long on Figma today?") still answer
  from the router, not from tool-use. Confirm by log line or trace.

---

### Task E — MCP server (GATED on community-interest probe)

**Outcome:** Power users can point Claude Desktop / Cursor / Claude Code at a
local Daylens MCP server and ask their agent questions about their own workday.
Ships as opt-in toggle in Settings, default off.

**Probe first (founder, not agent):** before Task E starts, post in one real
developer community with a concrete description of the feature. If fewer than
5 people express genuine interest (asking follow-up questions, not polite
emoji), use weeks 9-10 for accessibility-API metadata enrichment instead.

**Files in scope (if gate passes):**

- `packages/mcp-server/` (new) using `@modelcontextprotocol/sdk`
- `src/main/services/mcpServer.ts` (spawn/manage the subprocess)
- `src/renderer/views/Settings.tsx` (toggle + config snippet display)
- `src/preload/index.ts` (expose enable/disable)

**Implementation:**

- The MCP server is a separate stdio process that wraps the same tool schemas
  from `aiTools.ts`.
- Daylens spawns it on demand when the user enables the toggle.
- Settings UI shows the exact JSON snippet to paste into the user's MCP client
  config.
- No network surface. No auth needed — stdio between local processes.

**Success criteria:**

- `npm run dev`, enable toggle, connect Claude Desktop or Cursor, ask "what
  did I work on yesterday?" — get an answer sourced from your Daylens data.
  Paste the full transcript in report.

**Post-ship kill:** if <5% of active users enable the toggle within 4 weeks,
stop investing. MCP is a feature, not a strategy.

---

## 4. Absolute no-go this quarter

Do not touch any of these without explicit approval, even if you spot "easy
wins." Each has a reason.

- **New AI providers** (Groq, Mistral, Ollama, Gemini 2.5, Cohere, etc.). The
  existing four cover every user who matters. Each integration is 2-3 days.
- **Schema refactors** — `raw_window_sessions`, `browser_context_events`,
  `file_activity_events` stay as dead tables. Cleanup costs migration risk.
- **Linux browser capture.** Hard no. Q3 at earliest.
- **Web companion features.** Whatever it is today stays today.
- **AI chat UI redesign.** Answer quality (Task D) fixes this, not visuals.
- **Landing page overhaul.** Ship a notarized build, update the link, move on.
- **Wiring `aiSpendSoftLimitUsd`, `aiActiveBlockPreview`, `aiModelStrategy`.**
  These can remain under-wired.
- **Screenshot capture.** Explicitly ruled out. We do metadata-first; richer
  metadata via accessibility APIs is a Q3 workstream.
- **Web AI thread continuity.** Not this quarter.
- **Splitting `ai.ts` into smaller files.** It's 4000 lines and it annoys us.
  Still don't refactor. Task D edits one section; leave the rest alone.

---

## 5. Activator prompts

Each prompt is short because this document carries the context. Paste one at
a time. Wait for the report. Review. Then the next.

### Prompt 1 — Execute Task A

```
You are executing Task A from docs/EXECUTION_PLAN.md. Read that document
fully, then read docs/OVERVIEW.md. Follow the rules of engagement in
section 1 exactly. Your scope is strictly Task A.

Start with the spike (scripts/benchmark-fts5.mjs). Report the benchmark
numbers before writing the migration. If any p95 exceeds 300ms, stop and
propose options — do not work around silently.

Report in the format specified in section 1.6.
```

### Prompt 2 — Execute Task B

```
You are executing Task B from docs/EXECUTION_PLAN.md. Read that document
fully, then read docs/OVERVIEW.md. Follow the rules of engagement in
section 1. Scope is strictly Task B's three sub-tasks: name capture, goal
wiring, focus score rework.

Commit each sub-task separately for reviewability.

Report in the format specified in section 1.6. Include focus score values
for 3 real days from the local daylens.sqlite in your report.
```

### Prompt 3 — Execute Task C (KILL GATE)

```
You are executing Task C from docs/EXECUTION_PLAN.md — the kill-gate spike.
Read the document fully. Scope is strictly: produce aiTools.ts schemas,
run the spike script, report the grading table, give a clear go/no-go
recommendation.

You are writing NO production code this task except the schemas file.
Do not start integration. Do not edit ai.ts.

Report in the format from section 1.6 plus the grading table and your
go/no-go call against the criteria in Task C.
```

### Prompt 4 — Execute Task D (only if Task C passed)

```
You are executing Task D from docs/EXECUTION_PLAN.md. Task C has passed.
Read the document fully. Scope is strictly the freeform fallback path in
ai.ts plus aiTools.ts wiring. Do not refactor the rest of ai.ts.

Anthropic + OpenAI only in this task. Google stays on the old path.
Hard cap 5 tool calls per user message. Hard cap 8000 input tokens
post-tool-results.

Report in section 1.6 format. Include 10 real question/answer pairs from
npm run dev, graded.
```

### Prompt 5 — Execute Task E (only if probe passed)

```
You are executing Task E from docs/EXECUTION_PLAN.md. The community probe
has passed. Read the document fully. Scope is the MCP server package and
the Settings toggle.

Reuse tool schemas from aiTools.ts. No new query logic.

Report in section 1.6 format, including a full transcript of Claude Desktop
or Cursor successfully answering a Daylens question via MCP.
```

---

## 6. Monday-morning move

1. Start Apple Developer Program enrollment.
2. While waiting: paste Prompt 1 into the agent.
3. End of Monday: you should have spike numbers and know whether FTS5 is
   fast enough to build on. Every other week of this plan depends on that
   answer.
