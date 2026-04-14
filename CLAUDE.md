# Daylens — Product Contract for Claude Code Sessions

This file is the authoritative source of truth for what Daylens is, what every screen must accomplish, and what must never be shipped. Reference it at the start of any session that touches UI, data, or labels.

---

## What Daylens Is

Daylens is a **personal work intelligence app**. It passively captures what you do on your computer, reconstructs your work sessions into meaningful blocks, and lets you query your own time the way you'd query a work log — across clients, projects, apps, and focus patterns.

The product goal is: *let users answer high-value questions about their own work that they currently can't answer without manual tracking.*

It is **not** an app analytics dashboard. It is **not** a telemetry viewer. It is **not** a productivity tracker that surfaces raw usage stats. Every feature should move the user toward concrete answers about their work — not pleasant summaries, not pretty charts, not vague insights.

Daylens should be judged by whether it can answer the benchmark questions below. If it cannot, something is wrong with the data, the reconstruction, the AI prompt, or the UI.

---

## Benchmark Questions — The Real Product Test

These are the questions Daylens must be able to answer well. They are the standard against which every screen, label, data model, AI prompt, and feature decision should be evaluated.

### Client Work & Billing

- **How much time have I spent on Client X across all the apps I use?**
  _Work blocks, browser sessions, and communication sessions all need to be attributable to a client by project signal (document name, domain, Slack channel, window title). The AI and Timeline should both surface this._

- **How has my focus been over the past few weeks on Client X specifically?**
  _Not generic focus trends — focus correlated with a specific client or project. Focus sessions need to be cross-referenceable with work block content._

- **How much should I charge this client based on the work I actually did?**
  _Daylens should be able to reconstruct billable hours from tracked work blocks and sessions, broken down by day and by app if needed. This is one of the highest-value questions a freelancer has._

- **What did I work on for this client last Tuesday vs. this Tuesday?**
  _Week-over-week comparison at the client or project level, not just total screen time._

### Engineering Workflow

- **What projects have I worked on in VS Code / Cursor / Xcode while programming?**
  _Document artifacts (file names, repo paths, project names from window titles) captured during development sessions must be surfaced, not discarded. The artifact model in work blocks is the mechanism for this._

- **What are my top programming languages based on the files I've been editing?**
  _File extension inference from captured window titles and artifacts. A question like this should be answerable from the Apps → VS Code detail page or from AI._

- **What is my average debug time in Codex / Cursor?**
  _Session character analysis per app — how long sessions typically run, how many are short/interrupted vs. sustained. The app detail page should answer this, not just show "X sessions"._

- **How much of my programming time is in the editor vs. the browser vs. the terminal?**
  _Category breakdown within a development-focused work block. Timeline blocks need accurate category distribution._

- **What did I ship this week — what files, PRs, or projects did I actually touch?**
  _Artifact extraction from window titles, document refs, and page refs. Work blocks are only useful if they capture what was being worked on, not just which app was open._

### Focus & Patterns

- **When in the day am I actually in deep work vs. context-switching mode?**
  _Focus session overlap with work block category and duration. This should be visualizable on the Timeline and queryable via AI._

- **What keeps interrupting me during my coding sessions?**
  _App switches, communication intrusions, and short-duration sessions inside otherwise focused development blocks._

- **How does my focus this week compare to last week?**
  _Week-over-week comparison of focused time, number of deep sessions, and interruption count._

### Cross-App Work Reconstruction

- **What was I actually doing in that 3-hour block yesterday afternoon?**
  _A work block must surface: the primary task inferred from artifacts and window titles, the apps used, the documents opened, the sites visited, and the time distribution across sub-activities._

- **Which client or project took the most of my time this month?**
  _This requires project/client signal to propagate from artifacts and window titles into block labels and be queryable across a time range._

---

## What These Questions Demand from the Product

These benchmark questions impose specific requirements on every part of the system:

| Question type | What the system must capture |
|---|---|
| Client billing | Project signal in window titles, document names, domains, Slack channel names |
| Language breakdown | File extensions in captured artifacts during dev sessions |
| Debug time per tool | App session character (duration distribution, interruption frequency) |
| Focus by client | Focus session overlap with work block content, not just total focused time |
| Work reconstruction | Artifact refs, document refs, page refs preserved in every block — not discarded |
| Cross-app work | Workflow refs that connect blocks to a coherent project thread |

If a block label says "Development Session" and nothing else, it fails these questions. If the AI responds "I can see you used VS Code for 4 hours" and nothing else, it fails these questions.

---

## Screen Contracts

### Timeline (Day + Week views)

**What it must do:**
- Show a scannable reconstruction of the day as named work blocks
- Block labels should reflect *what was being worked on* (project, task, client) — not the app name
- Blocks must expose artifacts, documents, and pages so cross-app work is traceable
- The time rail must be clean: labels spaced ≥ 28px apart, no overlap
- Gaps and idle periods are secondary — quiet, not dominant
- The overall feel should be like Apple Calendar: spatial, calm, trustworthy

**What it must not do:**
- Show raw file paths anywhere (block labels, app names, window titles)
- Use heavy striped patterns or bordered boxes for gaps
- Poll data more frequently than every 30 seconds on today's view
- Show "Development Session" as a block label when there are document artifacts available that say more

**Acceptance criteria:**
- Block labels reference what was worked on, not just which app was active
- Time rail labels do not overlap (≥ 28px minimum spacing enforced)
- Gaps render as quiet background, not as content
- Artifact refs and document refs appear in the block popup when present
- No flickering during the 30-second polling cycle

### Apps

**What it must do:**
- Organize apps by category — never show "Uncategorized" for obvious tools
- App detail page must answer the benchmark questions for that app specifically:
  - How long are my typical sessions? (session character)
  - What am I usually doing in it? (artifact and page refs)
  - What else am I using alongside it? (paired apps, workflows)
  - When do I use it? (time-of-day pattern)
- Session History shows meaningful block names and timestamps — not file paths
- "Common workflow" shows clean display names only (no canonical IDs, no paths)

**What it must not do:**
- Show raw bundle IDs or file paths in any visible label
- Leave obvious apps (Ghostty, Cursor, Claude, Codex, Dia, Spotify, etc.) in "Uncategorized"
- Show "X sessions recorded so far" as the primary content of an app detail page
- Use section headings that sound like internal jargon ("Appears In", "Canonical App ID")

**Category resolution order (at query time):**
1. User override (from `category_overrides` table)
2. Stored `category` if it is not `'uncategorized'`
3. Catalog `defaultCategory` from `app-normalization.v1.json`
4. Fallback to `'uncategorized'` only if all above fail

**Acceptance criteria:**
- Zero obvious apps in Uncategorized
- VS Code / Cursor detail page can answer "what projects was I working on?"
- App detail shows session character (avg duration, session count) in plain language
- Session History labels are human-readable block names, not paths

### AI (Insights)

**What it must do:**
- Be able to answer every benchmark question in the section above
- Always show contextual starter prompts — screen must never open dead or empty
- When data exists: show a proactive summary + data-aware prompts tied to actual tracked context
- When no data exists: show prompts that are still useful (focus planning, workflow questions)
- Starter prompts must be grounded in what was actually tracked — not generic ("what's my day like?")
- The AI system prompt must give the model enough reconstructed context to answer billing, focus, engineering, and artifact questions
- Chat conversation must survive background refresh cycles
- Error messages must not double-prefix

**Starter prompt quality bar:**
Poor: "What's my most used app?" — this is a chart, not an insight  
Good: "How much time have I logged toward Client X this week?"  
Good: "What was I building in VS Code yesterday afternoon?"  
Good: "How does my focus this week compare to last week?"  
Good: "What files or projects did I work on today?"  

**What it must not do:**
- Open with "Not enough data tracked yet" — always show prompts
- Respond with "I can see you used Chrome for 2 hours" as a complete answer
- Wipe conversation history on background refresh failure
- Expose raw error objects or stack traces

**Acceptance criteria:**
- Ask "how much should I charge Client X this week" — AI produces a time-based answer from tracked data
- Ask "what was I debugging in Cursor yesterday" — AI surfaces session content, not just duration
- Ask "how has my focus trended this month" — AI produces a week-over-week comparison, not a single number
- Open AI with no data: 5 useful prompts visible under "Get started", not a blank state

### Settings

- Settings should feel like preferences, not configuration of a data pipeline
- Avoid exposing internal identifiers, database paths, or migration version numbers to users

---

## Anti-Patterns — Never Ship These

| Anti-pattern | Why it's wrong |
|---|---|
| Raw file paths in labels | Exposes implementation, unreadable to users |
| "Uncategorized" for obvious apps | Makes the product look broken |
| Block label = app name only (e.g. "VSCode") | The label should be the task or project, not the tool |
| Block discards its artifact and document refs | Makes client/project attribution impossible |
| AI answers "you used X for N hours" and stops | That's a chart, not an insight — answer the actual question |
| Time labels overlapping on the time rail | Visually broken, not production-grade |
| Gap bands as prominent striped boxes | Gaps are absence of work — make them quiet |
| 3-second polling on today's view | Causes visible flicker, burns CPU |
| AI screen opens blank or dead | No-data is not a valid product state |
| Double "Error: Error: ..." messages | Error handling bug leaking into UI |
| Workflow labels with canonical IDs ("vscode + google-chrome") | Use display names, not internal IDs |
| "Appears In" as a section heading | Internal-speak — use "Session History" |
| App description = telemetry dump | Rewrite to answer "what do I use this for?" |
| Generic AI prompts ("What's my most used app?") | Use benchmark-quality prompts — specific, operational, tied to real questions |

---

## Data Architecture (Quick Reference)

- **`app_sessions`** — raw captured sessions: `bundle_id`, `app_name`, `category`, `canonical_app_id`, `capture_source`
- **`work_context_blocks`** — reconstructed work blocks with label, category distribution, artifact refs, page refs, workflow refs
- **`app-normalization.v1.json`** — aliases (bundle ID → canonical ID) + catalog (canonical ID → display name + category). Loaded at runtime. Always add both Mac and Windows aliases.
- **`category_overrides`** — user-set category overrides, applied before catalog fallback
- **`workflow_signatures` / `workflow_occurrences`** — stored workflow patterns. Migration v12 clears these so labels regenerate with display names.
- **`schema_version`** — tracks applied migrations (currently v12)

**Category resolution in `getAppSummariesForRange`:**
```
user override → stored category (if not 'uncategorized') → catalog defaultCategory → 'uncategorized'
```

**Block label flow:**
`ruleBasedLabel` (derived from window titles/app names) → `websiteAwareLabel` → stored in `work_context_blocks.label_current` → displayed in Timeline and App detail. Sanitize path-like strings before display.

**Artifact flow (critical for benchmark questions):**
Window titles and document names → `topArtifacts` in work block → `blockAppearances` in app detail → AI system prompt context. If artifacts are discarded anywhere in this chain, client/project attribution breaks.

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

Before marking any change as done, verify against the benchmark questions. The test is not "does it look clean" — the test is "can it answer a real question."

**Tier 1 — Must pass before any release:**
1. Can a user ask "how much time did I spend on Client X this week" and get a number? _(AI + artifact attribution)_
2. Can a user open VS Code detail and see what projects they were working on? _(artifact refs in app detail)_
3. Are all obvious apps correctly categorized? _(zero obvious apps in Uncategorized)_
4. Do block labels reflect task/project, not just app name? _(block reconstruction quality)_
5. Does the AI screen open with useful, data-grounded prompts — never a dead state? _(starter prompts always visible)_

**Tier 2 — Should pass for a quality release:**
6. Can a user estimate billable hours for a client from their Timeline + AI? _(time reconstruction accuracy)_
7. Can a user ask "what was I debugging in Cursor yesterday" and get a meaningful answer? _(session character + artifact context in AI prompt)_
8. Is the Timeline timeline calm, spatial, and readable? _(no overlapping labels, no heavy gap boxes, no flickering)_
9. Does app detail say something useful beyond session count and duration? _(character, artifacts, patterns)_
10. Can a user compare their focus trend week-over-week from AI? _(focus session data in AI context)_

If Tier 1 fails, stop and fix it. If Tier 2 fails, it's a known gap — document it, don't ship it as if it works.
