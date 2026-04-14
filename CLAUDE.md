# Daylens — Product Contract for Claude Code Sessions

This file is the authoritative source of truth for what Daylens is, what every screen must accomplish, and what must never be shipped. Reference it at the start of any session that touches UI, data, or labels.

---

## What Daylens Is

Daylens is a **personal work intelligence app**. It watches what you do on your computer, reconstructs your work blocks, and helps you understand how your time was actually spent — across apps, projects, and focus sessions.

The product goal is: *help the user understand what they worked on, what mattered, and how their tools fit together.*

It is **not** an app analytics dashboard. It is **not** a telemetry viewer. It is **not** a productivity tracker that shows raw usage stats. Every screen should move the user toward clarity about their own work, not expose implementation internals.

---

## Screen Contracts

### Timeline (Day + Week views)

**What it must do:**
- Show a calm, scannable reconstruction of the day as a series of named work blocks
- Blocks should be named by *what was being worked on* (task or project), not by the app name or window title
- The time rail should be clean and readable — not crowded with overlapping labels
- Gaps and idle periods are secondary; they should not dominate the screen
- The overall feeling should be close to Apple Calendar: spatial, calm, trustworthy

**What it must not do:**
- Show raw file paths anywhere (block labels, app names, window titles)
- Show time labels that overlap or crowd together
- Use heavy striped patterns or bordered boxes for gaps — gaps are empty space, not content
- Poll data more frequently than every 30 seconds on today's view
- Re-render the full grid in a way that causes visible flicker

**Acceptance criteria:**
- Open today's view: blocks are named meaningfully, time rail has clean labels spaced ≥ 28px apart
- Gaps between blocks appear as quiet background space, not prominent UI elements
- App icons and names inside blocks are readable display names (not bundle paths)
- No flickering or content reset during the 30-second polling cycle

### Apps

**What it must do:**
- Organize apps by category (Development, Browsing, Communication, etc.)
- Never show "Uncategorized" for apps that have obvious, known categories
- The app detail page should answer: *what do I use this for, when do I use it, what do I do in it?*
- Session History shows meaningful block names and timestamps — not file paths
- "Common workflow" (formerly "Part of workflow") shows clean app display names
- Section headings are user-facing language, not internal/developer jargon

**What it must not do:**
- Show raw bundle IDs or file paths in any visible label
- Leave obvious apps (Ghostty, Cursor, Claude, Spotify, etc.) in "Uncategorized"
- Show implementation-sounding sections like "Appears In" or raw canonical IDs
- Display workflow labels like "vscode + google-chrome" — use display names

**Category resolution order (at query time):**
1. User override (from `category_overrides` table)
2. Stored `category` if it is not `'uncategorized'`
3. Catalog `defaultCategory` from `app-normalization.v1.json`
4. Fallback to `'uncategorized'` only if all above fail

**Acceptance criteria:**
- Apps view shows zero obvious apps in Uncategorized
- App detail page reads like a useful summary, not a telemetry dump
- Session History entries show human-readable block labels
- "Common workflow" only appears when the label is clean (no path leakage)

### AI (Insights)

**What it must do:**
- Always show starter prompts when the conversation is empty — the screen must never be dead
- When data exists: show a proactive summary paragraph + data-aware prompts ("What did I actually get done today?")
- When no data exists: show useful universal prompts ("What should I focus on today?")
- Degrade gracefully when API key is missing — show setup instructions, not a dead state
- Chat conversation must survive background refresh cycles (never wipe messages on refresh failure)
- Error messages must not double-prefix ("Error: Error: ...")

**What it must not do:**
- Show "Not enough data tracked yet. Check back after a full day." as the primary empty state
- Wipe conversation history when a background API/data refresh fails
- Expose raw error objects or stack traces in the chat

**Acceptance criteria:**
- Open AI with no API key: shows "add API key" CTA, not a blank or crashed state
- Open AI with API key, no data: shows 5 useful starter prompts under "Get started"
- Open AI with API key and data: shows summary paragraph + 5 data-aware prompts
- Send a message, wait 30s: conversation is still intact

### Settings

- Settings should feel like preferences, not configuration of a data pipeline
- Avoid exposing internal identifiers, database paths, or migration version numbers to users

---

## Anti-Patterns — Never Ship These

| Anti-pattern | Why it's wrong |
|---|---|
| Raw file paths in labels | Exposes implementation, unreadable to users |
| "Uncategorized" for obvious apps | Makes the product look broken |
| Block labels that are app names (e.g. "VSCode") | The label should be the *task*, not the tool |
| Time labels overlapping on the time rail | Visually broken, not production-grade |
| Gap bands as prominent striped boxes | Gaps are absence of work — make them quiet |
| 3-second polling on today's view | Causes visible flicker, burns CPU |
| AI screen that opens blank/dead | No-data is not a valid product state |
| Double "Error: Error: ..." messages | Error handling bug leaking into UI |
| Workflow labels with canonical IDs ("vscode + google-chrome") | Use display names, not internal IDs |
| "Appears In" as a section heading | Internal-speak — use "Session History" |
| App descriptions that sound like telemetry | Rewrite to answer "what do I use this for?" |

---

## Data Architecture (Quick Reference)

- **`app_sessions`** — raw captured sessions: `bundle_id`, `app_name`, `category`, `canonical_app_id`, `capture_source`
- **`app-normalization.v1.json`** — aliases (bundle ID → canonical ID) + catalog (canonical ID → display name + category). Loaded at runtime. Always add both Mac and Windows aliases when adding a new app.
- **`category_overrides`** — user-set category overrides, applied before catalog fallback
- **`workflow_signatures` / `workflow_occurrences`** — stored workflow patterns. Migration v12 clears these so labels regenerate with display names.
- **`schema_version`** — tracks applied migrations (currently v12)

**Category resolution in `getAppSummariesForRange`:**
```
user override → stored category (if not 'uncategorized') → catalog defaultCategory → 'uncategorized'
```

**Block label flow:**
`ruleBasedLabel` (derived from window titles/app names) → `websiteAwareLabel` → stored in `work_context_blocks.label_current` → displayed in Timeline and App detail. Sanitize any path-like strings before display.

---

## Normalization Catalog Rules

When adding apps to `shared/app-normalization.v1.json`:
1. Add both Mac bundle ID (`com.apple.X`, `com.company.AppName`) AND Windows executable (`appname.exe`) to `aliases`
2. Add the lowercase app name alone (`"appname": "canonical-id"`) to catch display-name-based matches
3. Add the `catalog` entry with a clean `displayName` and appropriate `defaultCategory`
4. Categories: `development`, `browsing`, `communication`, `writing`, `design`, `aiTools`, `email`, `research`, `productivity`, `meetings`, `entertainment`, `system`

---

## Migrations

Migrations live in `src/main/db/migrations.ts`. They are additive-only — never drop columns or tables. Current schema version: **v12**.

Migration v12 clears `workflow_occurrences` and `workflow_signatures` so workflow labels regenerate using display names instead of canonical IDs.

---

## Quality Bar

Before marking any change as done, verify:

1. Can a user quickly understand what they worked on today? (Timeline labels are meaningful)
2. Can they see where time actually went? (Categories are correct, app breakdown is clear)
3. Does each app's detail page say something useful about *their workflow*, not just "X sessions"?
4. Does the AI screen feel ready to use immediately? (Prompts visible, not a dead state)
5. Is the timeline calm and spatial? (No flickering, no crowded labels, no heavy gap boxes)
6. Are all obvious apps categorized correctly? (Zero obvious apps in Uncategorized)

If the answer to any of these is no, keep refining.
