# Daylens Windows — Backend & Infra Agent Prompt

You are implementing the backend/infra layer for the Daylens Windows Electron app at:
`/Users/tonny/Dev-Personal/daylens-windows/`

The Mac reference app is at: `/Users/tonny/Dev-Personal/daylens/`

This is an **Electron + React + TypeScript** app. Your scope is **main process only**:
- `src/main/services/` — services (AI, tracking, notifications, etc.)
- `src/main/lib/` — pure logic (query router, synthesizer, observer)
- `src/main/ipc/` — IPC handlers
- `src/main/db/` — DB queries and migrations
- `shared/types.ts` — shared type definitions

**Do not touch any renderer/React files.** Your job is to expose clean IPC contracts that
the frontend agent can consume. Document every new IPC channel you add at the bottom of this
file once done.

Read each relevant source file fully before editing it.
Commit after each discrete feature: `feat: <what>`

---

## Feature 1 — CLI-backed AI providers

**What Mac shipped:** `Daylens/Services/AI/CLIAIProvider.swift`

Users with a Claude or OpenAI subscription can skip API keys by using the installed CLI.
The app spawns `claude` / `codex` as child processes and captures their output.

**Implement in `src/main/services/ai.ts`:**

1. Add `'claude-cli'` and `'codex-cli'` to the `AIProvider` union in `shared/types.ts`.

2. Add `detectCLITools(): Promise<{ claude: string | null; codex: string | null }>`:
   - Search these Windows paths in order for each binary:
     - `%APPDATA%\npm\claude.cmd` → `process.env.APPDATA + '\\npm\\claude.cmd'`
     - `%USERPROFILE%\AppData\Roaming\npm\claude.cmd`
     - `%USERPROFILE%\.local\bin\claude.cmd`
     - `%USERPROFILE%\.volta\bin\claude.cmd`
     - `%USERPROFILE%\.npm-global\bin\claude.cmd`
   - If none found, fall back to `where.exe claude` (spawn, capture stdout, trim).
   - Return the resolved path or `null`. Same logic for `codex`.

3. Add `runCLIProvider(tool: 'claude' | 'codex', systemPrompt: string, prompt: string): Promise<string>`:
   - Resolve binary path via `detectCLITools()`.
   - Claude args: `['-p', prompt, '--output-format', 'text', '--tools', '', '--system-prompt', systemPrompt]`
     Spawn with `shell: true` (required for `.cmd` files on Windows). Collect stdout. Timeout 180s.
   - Codex args: `['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--config', 'model_reasoning_effort="low"', '--color', 'never', '--output-last-message', tmpFilePath, prompt]`
     Prepend system prompt into the prompt string since codex has no `--system-prompt` flag.
     Read output from the temp file after process exits (codex writes there, not stdout).
   - Throw a typed error if binary not found, process exits non-zero, or times out.
   - Augment `PATH` env with the binary's directory so node/npm shims resolve correctly.

4. Route `'claude-cli'` and `'codex-cli'` through `runCLIProvider` in the existing
   `resolveProviderConfigs` / `ask` flow. These providers need no API key.

5. Register IPC handler `ai:detect-cli-tools` → calls `detectCLITools()`, returns result.

6. Register IPC handler `ai:test-cli-tool` (args: `{ tool: 'claude' | 'codex' }`) →
   runs a trivial prompt ("Reply with the single word OK") and returns
   `{ ok: true, output: string } | { ok: false, error: string }`.

---

## Feature 2 — InsightsQueryRouter (fast local answers, no AI call)

**What Mac shipped:** `Daylens/Services/AI/InsightsQueryRouter.swift`

Before sending a question to the AI, attempt to answer it purely from the local DB.
Common questions get instant answers; only open-ended synthesis hits the AI.

**Implement in `src/main/lib/insightsQueryRouter.ts` (new file):**

### Exported function

```ts
interface TemporalContext {
  date: Date
  timeWindow: { start: Date; end: Date } | null
}

interface RouterResult {
  answer: string
  resolvedContext: TemporalContext
}

export async function routeInsightsQuestion(
  question: string,
  defaultDate: Date,
  previousContext: TemporalContext | null,
  db: Database,
): Promise<RouterResult | null>  // null = let AI handle it
```

### Question patterns to handle locally

| Question matches | Answer source |
|---|---|
| "what was i working on", "what did i work on", "what should i resume" | Work blocks for the day, sorted by time. Return timeline: "9am–10:30am: X (1h 30m); 11am–12pm: Y (1h)..." |
| "what distracted me", "biggest distraction" | Top non-focus app/site by total duration that day |
| "focus score", "was i focused" | Precomputed focus score from daily summary |
| "most used app", "top app", "used the most" | First entry of app summaries sorted by duration |
| "most used site", "top website", "top site" | First entry of website summaries |
| "where did my time go", "where did the time go" | Top 3 categories with durations + top app + top site |
| "how much time in/on <name>" | Match against app names, site domains, and categories; return duration |
| Weekly variants ("this week", "last week") | Query the week's work blocks / daily facts; aggregate |
| Time-range ("at 2pm", "between 9am and 10am", "what was i doing at 14:30") | See time parsing below |

### Temporal context resolution

- Parse dates: "yesterday", "today", named weekdays ("last Monday", "this Tuesday").
- Parse time windows: `(\d{1,2})(?::(\d{2}))?\s*(am|pm)` for 12h; `\d{1,2}:\d{2}` for 24h;
  `(?:at|around|before|after)\s+(\d{1,2})` for bare hours (assume PM for 1–6, AM for 7–11).
- Single time → ±10 min window. Two times → explicit interval.
- Follow-up detection: if question contains "that time", "at that point", "then", "doing what",
  "what exactly", "that moment" → reuse `previousContext.timeWindow` (shift to resolved date
  if different day).

### Time-range answer

When a time window is resolved:
1. Query sessions overlapping the window (`getSessionsForRange`).
2. Query website summaries for the window.
3. If the top session is a browser and there's a website match, return:
   `"At 2:00 PM, you were on youtube.com viewing 'Video title'."`
4. Otherwise: `"At 2:00 PM, you were in Xcode on 'MyProject.swift'."`
5. For wider ranges (>30 min): `"Between 9am and 10am, main work was X (45m), Y (15m)."`

### Wire-up

In the `ai:ask` IPC handler (or wherever the AI chat call is made):
- Call `routeInsightsQuestion` first.
- If it returns a result, push the answer directly into the conversation without an AI call.
- Pass the returned `resolvedContext` forward so the next message can use it as `previousContext`.
- Store `previousContext` per-conversation in memory (map keyed by conversationId).

---

## Feature 3 — Two-stage work context pipeline

**What Mac shipped:** `WorkContextObserver.swift` + `WorkContextCardSynthesizer.swift`

### DB migration

Add migration (next version after current) creating:

```sql
CREATE TABLE IF NOT EXISTS work_context_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  start_ts INTEGER NOT NULL,  -- Unix ms
  end_ts INTEGER NOT NULL,    -- Unix ms
  observation TEXT NOT NULL,
  source_block_ids TEXT NOT NULL DEFAULT '[]',
  UNIQUE(start_ts, end_ts)
);
```

### `src/main/lib/workContextObserver.ts` (new file)

```ts
export async function generateObservations(
  blocks: WorkContextBlock[],
  db: Database,
  askAI: (prompt: string) => Promise<string>,
): Promise<WorkContextObservation[]>
```

Logic:
1. Sort blocks by `startTime`. Group into windows: merge consecutive blocks where gap ≤ 2 min
   and total window duration ≤ 30 min.
2. Skip any window with duration < 5 min.
3. For each window, check DB for existing observation with same `(start_ts, end_ts)`. Skip if exists.
4. For new windows, call `askAI` with this prompt (same as Mac):
   ```
   Summarize the user's work context for this window in 2-4 grounded sentences.
   Focus on the likely task, mode of work, and any notable context shifts.
   Do not use bullet points. Do not mention uncertainty unless the evidence is thin.

   Window start: <ISO8601>
   Window end: <ISO8601>
   Apps: <comma-separated>
   Websites: <comma-separated domains>
   Window titles: <pipe-separated>
   ```
5. Persist each observation to `work_context_observations`. Return all observations for the span.

### `src/main/lib/workContextCardSynthesizer.ts` (new file)

```ts
export async function synthesiseCards(
  observations: WorkContextObservation[],
  existingCards: WorkContextBlock[],
  categories: string[],
  askAI: (systemPrompt: string, prompt: string) => Promise<string>,
): Promise<SynthesisedCard[]>

interface SynthesisedCard {
  label: string
  narrative: string | null
  startTime: Date
  endTime: Date
}
```

Logic:
1. Build a cacheable system prompt (the instructions for card structure and format) — this part
   never changes and can be reused across calls.
2. Build an activity payload from observations: each observation's time window + narrative.
3. Call AI, expect JSON array of `SynthesisedCard`.
4. Validate: every card must have a non-empty `label`, `startTime` < `endTime`, and cards must
   collectively span from first observation start to last observation end (no gap > 5 min).
5. On validation failure, append the errors as retry feedback and call AI again. Up to 3 attempts.
6. Throw `CardSynthesisError` after 3 failures.

### Wire-up in `src/main/services/workBlocks.ts`

After work blocks are computed/updated for a day:
1. Call `generateObservations(blocks, db, askAI)` → get observations.
2. Call `synthesiseCards(observations, existingCards, categories, askAI)` → get cards.
3. Persist/update the synthesised cards as the preferred labels for those blocks.

---

## Feature 4 — DistractionAlerter: verify and harden

**Mac reference:** `Daylens/Services/DistractionAlerter.swift`

Audit `src/main/services/distractionAlerter.ts` against these requirements:

- Tracks **consecutive seconds** on the same non-focus app (not just "switched to it").
- Fires the notification **exactly once** per threshold crossing — not repeatedly each tick.
- Threshold default: **10 minutes**, user-configurable (read from settings key `distractionAlertThresholdMinutes`).
- When the user switches to a focus app or a different non-focus app, reset the consecutive counter.
- Notification: title `"Daylens"`, body `"You've been on <AppName> for <N> minutes."`.
- Expose IPC `distraction-alerter:set-threshold` (args: `{ minutes: number }`) so Settings can update it live.

Fix any gaps. Add the IPC handler if missing.

---

## Feature 5 — DailySummaryNotifier: add morning nudge

**Mac reference:** `Daylens/Services/DailySummaryNotifier.swift`

Audit `src/main/services/dailySummaryNotifier.ts`. Ensure both notifications exist:

**Daily recap (6pm):**
- Fires every day at 6:00 PM local time.
- Title: `"Daylens"`, body: `"See where your day went."` (frontend agent will handle exact copy).
- On click: send IPC `navigate:today` to renderer.
- Gated by settings key `dailySummaryEnabled` (default true).

**Morning nudge (9am):**
- Fires every day at 9:00 AM local time.
- Gated by: (a) settings key `morningNudgeEnabled` (default true), AND (b) user has **zero**
  focus sessions started today (`getRecentFocusSessions` filtered to today's date).
- Title: `"Daylens"`, body: `"What's your focus for today?"`.
- On click: send IPC `navigate:focus` to renderer.

Use `node-cron` or `setTimeout`-based scheduling (whatever the codebase already uses).
Use Electron's `new Notification({ title, body })` in the main process for delivery.

---

## Feature 6 — Focus session persistence for reflection

The frontend will show a post-session reflection card. Add the backend support:

1. Add column `reflection_note TEXT` to the `focus_sessions` table (new migration).
2. Add DB query `saveFocusReflection(sessionId: number, note: string): void`.
3. Add DB query `getDistractionCountForSession(sessionId: number): number` —
   count rows in `distraction_events` (or equivalent table) where `session_id = sessionId`.
4. Register IPC handler `focus:save-reflection` (args: `{ sessionId: number; note: string }`).
5. Register IPC handler `focus:get-distraction-count` (args: `{ sessionId: number }`) → `number`.

---

## IPC contract (fill this in as you go)

Document every new IPC channel you add so the frontend agent can consume them:

| Channel | Direction | Args | Returns |
|---|---|---|---|
| `ai:detect-cli-tools` | renderer → main | — | `{ claude: string \| null, codex: string \| null }` |
| `ai:test-cli-tool` | renderer → main | `{ tool: 'claude' \| 'codex' }` | `{ ok: boolean, output?: string, error?: string }` |
| `distraction-alerter:set-threshold` | renderer → main | `{ minutes: number }` | `void` |
| `navigate:today` | main → renderer | — | — |
| `navigate:focus` | main → renderer | — | — |
| `focus:save-reflection` | renderer → main | `{ sessionId: number, note: string }` | `void` |
| `focus:get-distraction-count` | renderer → main | `{ sessionId: number }` | `number` |

---

## Build / type check

```bash
cd /Users/tonny/Dev-Personal/daylens-windows
npm run typecheck    # must pass clean after each feature
npm run build        # verify production build
```

Never use `any` to paper over type errors. Fix the types.
