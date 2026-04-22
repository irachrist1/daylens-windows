# Daylens

Daylens is a cross-platform activity tracker for your laptop. It quietly logs what you're working on so you, and the AI tools you use, can ask grounded questions about your work history.

It is built for questions like:

- "How much should I charge Client X based on how long I've been working on this for the past month?"
- "What did I do between 2-4 pm on Wednesday?"
- "Show me everything I touched for Project X. Why is it not working now if it worked yesterday?"

Think of it as Google for your workday history, and Spotify Wrapped for how you actually spend your time.

Daylens captures local evidence from the tools you use - apps, windows, browser activity, files, and reconstructed work sessions - then turns that into a timeline you can inspect directly or query through AI. It is not meant to be an app-usage vanity dashboard. It is meant to help you understand what you worked on, how long it took, what changed, and what context surrounded that work.

This repository is historically named `daylens-windows`, but the Electron desktop app in this repo is the cross-platform Daylens source of truth for macOS, Windows, and Linux. Platform-specific validation status still lives in [docs/ISSUES.md](docs/ISSUES.md), and the broader product direction includes editor-facing integrations so tools such as Claude Code, Cursor, and other MCP-style clients can pull in Daylens context while you build, debug, and investigate.

## Install

Public download routes (kept versionless so they follow the newest real asset instead of guessing):

- **[macOS download](https://daylens-web-irachrist1s-projects.vercel.app/daylens/api/download/mac)**
- **[Windows download](https://daylens-web-irachrist1s-projects.vercel.app/daylens/api/download/windows)**
- **[Linux status](https://daylens-web-irachrist1s-projects.vercel.app/daylens/linux)**  •  **[all GitHub releases](https://github.com/irachrist1/daylens/releases)**

Prefer a package manager on macOS (zero prompts, zero clicks):

```bash
brew install --cask irachrist1/daylens/daylens
```

After downloading the macOS DMG, drag Daylens into Applications, then double-click it. The first launch shows a one-time "Daylens Not Opened" prompt (the standard macOS prompt for any app not distributed through the App Store — the same prompt you'll see on ChatGPT's Codex app). Open **System Settings → Privacy & Security**, scroll to Security, and click **Open Anyway**. One-time only. The in-DMG `Start Here.txt` walks through the same steps with pictures.

Full per-platform notes, troubleshooting, and build-from-source instructions live in [docs/INSTALL.md](docs/INSTALL.md).

## Current product surfaces

- `Onboarding` for first-run tracking setup and proof of capture
- `Timeline` for reconstructed work blocks, prior days, week view, and artifact evidence
- `Apps` for app-level context, paired tools, and the work happening inside them
- `AI` for grounded summaries, daily/weekly/monthly recap experiences, follow-up questions, freeform work-history queries, and report/export generation
- `Settings` for tracking, providers, notifications, privacy, updates, and appearance

Current implementation gaps and near-term product backlog live in [docs/ISSUES.md](docs/ISSUES.md). Keep feature status there instead of duplicating it across other docs.

## Current repo status

- Local-first SQLite persistence
- Cross-platform foreground-window tracking, including Linux compositor-aware fallbacks and desktop-entry cleanup upon review
- Browser history ingestion for Chromium browsers on both platforms, plus Firefox on Windows
- Cross-platform icon resolution for apps, sites, files, and artifacts
- Grounded AI over tracked history, including backend-orchestrated chat streaming, AI-surface focus-session start / stop / review flows, deterministic daily/weekly/monthly recap cards, AI-generated report/export artifacts, and week/app summaries implemented pending verification
- Persistent AI chat threads and artifact library inside the AI surface (thread switcher, artifacts strip with preview / open / export) implemented pending verification
- Evidence-grounded focus score (coherence + deep-work density + artifact progress + demoted context-switching penalty) implemented pending verification
- Settings controls for tracking, providers, workspace linking, notifications, privacy, updates, truthful platform-specific launch / quick-access / install expectations, explicit Anthropic / OpenAI model overrides, and sparse app category overrides implemented pending verification
- macOS shell / release hardening for menu bar UX, legacy `userData` preservation, and signed package configuration implemented pending verification
- Packaged macOS, Windows, and Linux build pipelines upon review

Detailed validation status and any truthfulness caveats live in [docs/ISSUES.md](docs/ISSUES.md), including what was manually validated on macOS versus what still remains implemented pending verification on Windows and Linux.

## Development

- `npm start` runs the Electron app in development mode
- `npm run typecheck` checks TypeScript without emitting output
- `npm run build:all` builds the main, preload, and renderer bundles
- `npm run test:ai-chat` runs the AI chat, onboarding, cleanup, and prompt-caching tests
- `npm run test:entity-prompts` runs the entity-routing prompt benchmark tests
- `npm run dist:win` builds the Windows installer and update metadata into `dist-release/`
- `npm run dist:mac` builds the macOS archive and DMG into `dist-release/`
- `npm run dist:linux` builds the Linux release artifacts into `dist-release/`
- published downloads should live together on the shared GitHub release tag (`vX.Y.Z`) so Windows, macOS, and Linux assets ship from one release page

## Canonical docs

- [docs/INSTALL.md](docs/INSTALL.md) for platform install instructions and the macOS "damaged" fixes
- [docs/CLAUDE.md](docs/CLAUDE.md) for a lightweight session guide
- [docs/ABOUT.md](docs/ABOUT.md) for reusable product copy
- [docs/AGENTS.md](docs/AGENTS.md) for the product and build contract
- [docs/PRD.md](docs/PRD.md) for the remote companion product definition and phased product scope
- [docs/SRS.md](docs/SRS.md) for the remote companion system requirements and architecture plan
- [docs/REMOTE_PARITY_MATRIX.md](docs/REMOTE_PARITY_MATRIX.md) for the launch parity checklist across Timeline, Apps, AI, Settings, notifications, and Wrapped
- [docs/REMOTE_CONTRACT.md](docs/REMOTE_CONTRACT.md) for the shared remote data, sync, session, and AI continuity contract
- [docs/REMOTE_EXECUTION_PLAN.md](docs/REMOTE_EXECUTION_PLAN.md) for the milestone-by-milestone execution plan and release gates
- [docs/diagrams/README.md](docs/diagrams/README.md) for rendered Mermaid architecture diagrams that visualize the remote companion plan
- [docs/IDEAS.md](docs/IDEAS.md) for future directions
- [docs/ISSUES.md](docs/ISSUES.md) for current constraints and open problems
