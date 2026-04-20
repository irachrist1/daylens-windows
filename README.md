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

Grab the latest build from the [releases page](https://github.com/irachrist1/daylens/releases/latest). Full instructions, platform-by-platform fixes, and a Homebrew path live in [docs/INSTALL.md](docs/INSTALL.md).

- **macOS (recommended):** `brew install --cask irachrist1/daylens/daylens`
- **macOS (manual DMG):** download, drag to Applications, then run `xattr -cr /Applications/Daylens.app` if macOS says *"Daylens is damaged"* — see [docs/INSTALL.md](docs/INSTALL.md#why-macos-shows-daylens-is-damaged) for why and for the no-Terminal "Open Anyway" path.
- **Windows:** download `Daylens-<version>-Setup.exe` and run it. On SmartScreen, click **More info → Run anyway**.
- **Linux:** AppImage, deb, rpm, and tar.gz are all published on each release.

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
- [docs/IDEAS.md](docs/IDEAS.md) for future directions
- [docs/ISSUES.md](docs/ISSUES.md) for current constraints and open problems
