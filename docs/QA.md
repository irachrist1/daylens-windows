# QA Runbook

Use this before shipping changes to the Insights page, AI Workspace, tracking, timeline attribution, or release pipeline.

## Required local checks

```bash
npm run typecheck
npm run build:all
npm run benchmark:ai-workspace
npm run benchmark:ai-workspace:extended
```

## What `benchmark:ai-workspace` validates

The benchmark runner compiles a small standalone harness and executes it under Electron's Node runtime so native modules match the app runtime.

It seeds an in-memory SQLite database with evidence across:

- VS Code
- Outlook
- Excel
- Windows Terminal
- Chrome plus browser-history page titles

Then it verifies that the local AI Workspace router can answer benchmark-shaped questions such as:

- cumulative client time: `How many hours have I spent on ASYV today?`
- title evidence: `Which ASYV titles matched today?`
- by-app follow-up: `Break ASYV down by app today.`
- scoped native-app attribution: `How much ASYV time was in Outlook today?`
- exact-time lookup: `What was I doing today at 10:58 am?`

## What `benchmark:ai-workspace:extended` adds

The extended runner uses the same standalone Electron harness, but exercises broader product-shaped prompts instead of only the core benchmark.

It verifies that the local router can now handle:

- open-ended work-thread prompts like `What was I working on today?` and `What should I resume?`
- distraction questions without duplicate signals
- client and project identity questions like `Who is ASYV?` and `What do I do for ASYV?`
- client listing and comparison prompts like `List all my clients today.` and `ASYV versus Acme Corp`
- day-summary prompts like `Summarize my day.` and `How was my day?`
- generic routed questions like focus score, time allocation, top app, and app breakdown

## What this does not prove

- live provider-backed chat quality from Anthropic, OpenAI, Google, Claude CLI, or Codex CLI
- export UI behavior
- production GitHub release publishing
- real-world attribution quality on a user's existing local database

The harness is a regression guard for the evidence router behind AI Workspace chat, not a full end-to-end product certification.
