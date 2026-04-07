# Daylens Windows

**"Chrome: 6 hours."** Every other productivity tracker stops there and calls it insight. It isn't.

A developer debugging a production incident in Chrome for three hours is deeply focused. That same developer scrolling Reddit during a declared focus block is off-track. Knowing someone used Chrome for six hours tells you nothing about which one happened. Daylens does not stop at app names.

**The app is not the story. What you were doing inside it is.**

Daylens uses AI to turn raw app and browser activity into a **timeline of actual work sessions** — what you were doing, not just where your cursor was. "Research for the auth migration: 2h 40m." "Off-plan browsing during your deep work block: 22m." The difference matters. We make it visible.

No account. No cloud. No categorical labels that decide YouTube is always distracting and VS Code is always productive. Your data stays on your machine, and Daylens earns trust by being right about what actually happened.

## What it does

- Builds a labeled timeline of your work day from app usage and browser history — tasks, not app totals.
- Distraction alerts that only fire when you've declared a focus intent and drifted from it — not because you opened a browser.
- Focus score that reflects session depth and intent alignment — not how much time was in "productive" app categories.
- AI chat that answers "what was I doing yesterday afternoon?" and "what kept pulling me away this week?" from your actual local history.
- Algorithmic insight cards — peak hours, context switching patterns, focus streaks, goal progress — that work without any API key.
- Focus sessions with live on-task or off-task feedback relative to your declared planned apps.
- Daily recap at 6pm and morning focus nudge at 9am (only if you haven't started a session yet).
- App detail views with session history, usage interpretation, and hour-of-day patterns.
- Supports Claude Code CLI and Codex CLI as AI backends — use your existing subscription with no API key.
- GitHub-backed automatic updates with in-app progress and release notes.

## MCP — Use Daylens with Claude Code, Cursor, and other AI agents

[daylens-mcp](https://github.com/irachrist1/daylens-mcp) is an MCP server that gives AI coding assistants direct access to your Daylens activity history. Ask your AI "what was I working on this morning?", "when am I most focused?", or "write my performance review for last quarter" — answered from your local database in seconds.

Works with Claude Code, Cursor, Windsurf, and Claude Desktop. Zero cloud. Your data never leaves your machine.

```bash
claude mcp add daylens -- npx -y daylens-mcp
```

[Full setup guide →](https://github.com/irachrist1/daylens-mcp)

---

## Development

- Read [docs/BENCHMARK.md](docs/BENCHMARK.md) before changing the insights, AI workspace, tracking, or export pipeline. It defines the product benchmark the system is expected to meet.
- `npm start` runs the Electron app in development mode.
- `npm run typecheck` checks TypeScript without emitting build output.
- `npm run build:all` builds the main, preload, and renderer bundles.
- `npm run benchmark:ai-workspace` runs the release benchmark for grounded client-time and follow-up answers.
- `npm run benchmark:ai-workspace:extended` runs the broader routed-question regression suite for summaries, distractions, identity, client listing, comparisons, and focus questions.
- `npm run dist:win` builds the NSIS installer and update metadata into `dist-release/`.
