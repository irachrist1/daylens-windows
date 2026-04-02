# Daylens Windows — Frontend & Copywriting Agent Prompt

You are implementing the frontend layer for the Daylens Windows Electron app at:
`/Users/tonny/Dev-Personal/daylens-windows/`

The Mac reference app is at: `/Users/tonny/Dev-Personal/daylens/`

This is a **React + TypeScript** renderer (Electron). Your scope is **renderer only**:
- `src/renderer/views/` — page-level views
- `src/renderer/components/` — shared components
- `src/renderer/lib/` — renderer utilities
- `src/renderer/styles/` — CSS / design tokens

**Do not touch main-process files.** All data comes via IPC. The backend agent has already
wired the IPC handlers — use `ipc(channel, args)` from `src/renderer/lib/ipc.ts` to call them.

**Before writing any component:** read the existing file in full. Match the existing code
style, import patterns, and CSS conventions exactly. Do not introduce new dependencies.

Commit after each discrete feature: `feat: <what>`

---

## IPC channels available from backend

| Channel | Call | Returns |
|---|---|---|
| `ai:detect-cli-tools` | `ipc('ai:detect-cli-tools')` | `{ claude: string \| null, codex: string \| null }` |
| `ai:test-cli-tool` | `ipc('ai:test-cli-tool', { tool })` | `{ ok: boolean, output?: string, error?: string }` |
| `distraction-alerter:set-threshold` | `ipc('distraction-alerter:set-threshold', { minutes })` | `void` |
| `focus:save-reflection` | `ipc('focus:save-reflection', { sessionId, note })` | `void` |
| `focus:get-distraction-count` | `ipc('focus:get-distraction-count', { sessionId })` | `number` |
| Main → renderer navigation events | listen via existing event bus | `'today'` or `'focus'` |

---

## Feature 1 — AI provider selection: CLI options in Settings + Onboarding

**Mac reference:** `Daylens/Views/Onboarding/AISetupStep.swift`, `Daylens/Views/Settings/SettingsView.swift`

**Where to add:** Settings view (`src/renderer/views/Settings.tsx`) and the onboarding AI step
(`src/renderer/views/Onboarding.tsx`).

### What to build

A provider selection UI with these options (radio/card style, match existing Settings card style):

| Option | Title | Description |
|---|---|---|
| `anthropic` | Anthropic API | Bring your own API key. Full model selection. |
| `openai` | OpenAI API | Bring your own API key. |
| `google` | Google AI | Bring your own API key. |
| `claude-cli` | Claude Code CLI | Use your Claude subscription. No API key needed. |
| `codex-cli` | Codex CLI | Use your OpenAI subscription. No API key needed. |

**CLI option behaviour:**
- On mount, call `ipc('ai:detect-cli-tools')`. Store result in state.
- If the CLI is detected: show a green dot + the resolved path in small grey text below the option.
- If not detected: show the install command inline in a `<code>` block:
  - Claude: `npm install -g @anthropic-ai/claude-code`
  - Codex: `npm install -g @openai/codex`
- Add a **"Test"** button next to each CLI option (only visible when that option is selected).
  - On click: call `ipc('ai:test-cli-tool', { tool: 'claude' | 'codex' })`.
  - While running: show a small spinner, button disabled.
  - On success: show "✓ Working" in green for 3 seconds then reset.
  - On failure: show the error message in red (truncate at 120 chars).

**Copy for CLI options (use exactly):**
- Claude CLI description: `"Runs on your Claude subscription — no API key required. Needs claude CLI installed."`
- Codex CLI description: `"Runs on your OpenAI subscription — no API key required. Needs codex CLI installed."`
- Not installed hint: `"Not detected. Install with:"`
- Test button label: `"Test connection"`
- Success message: `"Connected"`
- Generic failure message: `"Could not connect. Check the CLI is installed and logged in."`

---

## Feature 2 — Insights tab: follow-up conversation feel

**Mac reference:** `Daylens/Views/Insights/InsightsView.swift`

The backend now short-circuits common questions locally (no AI call). The UI doesn't need
to change structurally — but add these polish items to `src/renderer/views/Insights.tsx`:

### a) Mode label

Below the composer input, show a small grey label that updates based on AI provider:
- `anthropic` / `openai` / `google` API key: `"Exact answers use local data. Analysis uses your <Provider> key."`
- `claude-cli`: `"Exact answers use local data. Analysis uses your Claude subscription."`
- `codex-cli`: `"Exact answers use local data. Analysis uses your OpenAI subscription."`
- No provider configured: `"Exact answers use local data. Connect AI in Settings for deeper analysis."`

### b) Suggested follow-up chips

After the assistant replies, show 2–3 tappable suggestion chips below the message:
- Always show: `"What distracted me?"`, `"Where did my time go?"`
- If the answer mentioned a specific time: also show `"What was I doing then?"`
- Style: small outlined pill buttons. On click, submit that text as the next message.

### c) Empty state copy (use exactly)

When no conversation has started:

```
Heading:   "Ask about your day"
Subheading: "What were you working on? When did you focus best? What kept pulling you away?"
```

Suggestion chips in empty state:
- `"What was I working on today?"`
- `"What distracted me most?"`
- `"When was I most focused?"`
- `"Where did my time go?"`

---

## Feature 3 — Focus tab: major upgrade

**Mac reference:** `Daylens/Views/Focus/FocusView.swift` and companion views in that folder.

Edit `src/renderer/views/Focus.tsx`. Read the full file before touching it.

### a) Full-screen ring timer (active session state)

When `focusSession.phase === 'focusing'`, replace the time grid entirely with a centered ring:

- SVG circle, radius ~90px, stroke-width ~8px.
- Background track: subtle grey stroke. Foreground arc: brand accent color.
- Arc represents elapsed / target. Animate `stroke-dashoffset` on each second tick.
- Center text: elapsed time formatted as `MM:SS` (or `H:MM:SS` if ≥ 1 hour).
- Below the ring: session intent text (from `focusIntent` setting) in medium grey.
- Below that: a `"Stop session"` button (bordered, not destructive-red — this is a normal action).
- Animate in/out with opacity + slight scale (scale 0.97 → 1.0 on enter).

**Copy:**
- Stop button: `"Stop session"`
- No intent set fallback: `"Focus session in progress"`

### b) Intent bar

At the top of the Focus view (shown when not in active session):

A single-line text input: `"What are you working on?"` as placeholder.
- Persists to settings key `focusIntent` on every keystroke (debounce 500ms).
- Reads initial value from settings on mount.
- Styled as a subtle inset field, not a full form input. Match existing app style.

### c) Drag-to-create on hour grid

On the hour grid (the list of hour rows):
- `onMouseDown` on any row: start tracking drag. Record start hour.
- `onMouseMove`: highlight rows between start and current row with a selection color
  (semi-transparent accent, e.g. `rgba(accent, 0.15)`).
- `onMouseUp`: open an inline create card anchored below the last selected row.

**Inline create card fields:**
- Intent text input (placeholder: `"What will you work on?"`)
- Duration selector: preset buttons `25m`, `50m`, `90m` + a custom input.
- `"Start"` button → calls existing focus session start IPC.
- `"Cancel"` link → dismisses.

### d) Inline edit card

Clicking an existing block: replace any modal with an inline card at the block position:
- Intent text input pre-filled.
- Duration selector.
- `"Save"` and `"Cancel"` buttons.

### e) Post-session reflection card

After a session ends, before resetting to idle state:

1. Call `ipc('focus:get-distraction-count', { sessionId })`.
2. Show a bottom sheet (absolute positioned, full-width, slides up with `translateY` animation):
   - Header: `"Session complete"`
   - Session stats row: `"<duration>"` + `"<N> distraction<s>"` (pluralize correctly).
   - A `<textarea>` with placeholder: `"How did it go? Any notes for next time?"`
   - `"Save note"` button → calls `ipc('focus:save-reflection', { sessionId, note })` then dismisses.
   - `"Skip"` link → dismisses without saving.
   - Scrim overlay behind the card (semi-transparent dark).

**Copy:**
- Header: `"Session complete"`
- Stats: `"<Xh Ym focused"` + `"<N> distraction"` / `"<N> distractions"`
- Textarea placeholder: `"How did it go? Any notes for next time?"`
- Save button: `"Save note"`
- Dismiss: `"Skip"`

### f) Distraction banner (during active session)

While a session is active, subscribe to the live app feed. If the current app is non-focus:

- Show a slim top banner (sticky, above the ring timer):
  `"On <AppName> · <elapsed on this app>"`
- After the `distractionAlertThresholdMinutes` setting elapses, change the banner accent
  to a warning color (amber) and add: `"Back to focus?"`
- Dismiss when the user returns to a focus app.
- Banner should not be jarring — subtle background, small text.

### g) Break suggestion banner

After 50 continuous minutes of `phase === 'focusing'`:
- Show a non-intrusive top banner (below the intent bar, above the ring):
  `"You've been focused for 50 min — consider a short break."`
- A `"Dismiss"` × button on the right.
- Only show once per session.

---

## Feature 4 — Settings: new toggles

Add these to `src/renderer/views/Settings.tsx`, grouped logically under existing sections.
Match the exact card/toggle style already used in the file.

### Distraction alerts section

```
Section heading: "Distraction alerts"

Toggle: "Alert me when I'm distracted"
  Description: "Get a notification when you've been on a non-focus app for too long."
  Default: on
  Settings key: distractionAlertsEnabled

Slider / number input: "Alert after"
  Range: 5–30 minutes, step 5
  Default: 10
  Unit label: "minutes"
  Only visible when toggle is on.
  On change: call ipc('distraction-alerter:set-threshold', { minutes })
```

### Notifications section

```
Section heading: "Notifications"

Toggle: "Daily recap at 6pm"
  Description: "A nudge to check where your day went."
  Default: on
  Settings key: dailySummaryEnabled

Toggle: "Morning focus nudge"
  Description: "A 9am reminder to set your focus goal — skipped if you've already started a session."
  Default: on  
  Settings key: morningNudgeEnabled
```

### Focus section (add to existing if present)

```
Toggle: "Enable Focus Assist when session starts"
  Description: "Coming soon on Windows."
  Disabled (greyed out), no interaction.
```

---

## Design rules

- Match the existing component and CSS style in each file — do not introduce new patterns.
- Use the same spacing, font sizes, and colour tokens already in use.
- Animations: keep them subtle. 200–300ms easing. No bouncy springs unless the app already uses them.
- Do not add new npm packages.
- All user-visible strings must be final copy (not placeholders). Use the copy above verbatim
  where provided; write consistent copy elsewhere.
- TypeScript must compile clean. No `any` to paper over errors.

---

## Build / verify

```bash
cd /Users/tonny/Dev-Personal/daylens-windows
npm run dev          # visual check
npm run typecheck    # must pass clean
```
