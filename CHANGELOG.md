# Changelog

## v1.0.16 - 2026-04-01

- **daylens-mcp:** Daylens now has an MCP server that connects Claude Code, Cursor, Windsurf, and Claude Desktop directly to your activity history. Ask your AI "what was I working on this morning?", "when am I most productive?", or "write my Q1 performance review" — answered from your local database. Install: `claude mcp add daylens -- npx -y daylens-mcp`. Full docs at [github.com/irachrist1/daylens-mcp](https://github.com/irachrist1/daylens-mcp).

## v1.0.15 - 2026-03-31

- Added provider-aware AI chat support for Anthropic, OpenAI, and Google AI Studio / Gemini.
- Added three selectable model options per provider in Settings, with provider-aware key storage and onboarding flow.
- Switched the safest Google default to `gemini-3.1-flash-lite-preview` after live testing showed it works reliably on the current account.
- Fixed Electron main-process startup after adding the new AI SDKs by externalizing websocket-related dependencies that were being bundled incorrectly.
- Fixed updater IPC noise during local macOS development by registering updater handlers even when auto-update is inactive.
- Stopped the Windows-only process monitor from trying to run `wmic` on macOS development runs.
- Tightened the AI system prompt so every provider answers as Daylens and reports the current underlying provider/model cleanly when asked.

## v1.0.14 - 2026-03-31

- Fixed the in-app updater handoff so Daylens can close into the installer cleanly instead of getting stuck after showing that an update is ready.
- Added richer updater state in-app: progress, install/failure messaging, and release highlights pulled from the published Windows release notes.
- Replaced the Settings download redirect with real in-app update actions for checking, downloading, and restarting into the installer.
- Added a pre-update backup of local `userData` before install so upgrades have a built-in recovery path if anything goes wrong.
- Updated the Windows release workflow to publish changelog-driven release notes plus a commit summary on each GitHub release page.

## v1.0.13 - 2026-03-31

- Fixed the `visit_time_us` schema migration path so fresh installs and partially upgraded databases no longer fail on startup with a duplicate-column error.
- Hardened onboarding completion so API-key persistence failures surface to the user instead of leaving first-run state half-saved.
- Updated in-app update and web-companion links to point at the canonical Windows release and web-linking destinations.
- Aligned the public web copy with the actual Windows flow: short onboarding, token-based web linking, and background tracking after setup.

## v1.2.0 - 2026-03-24

Full redesign to the Stitch Intelligent Monolith design language across every view.

- **Design system:** replaced all hardcoded dark surface hex values (`#272a32`, `#191c22`, `#32353c`, `#e1e2eb`) with CSS variables throughout — all surfaces now adapt correctly in light mode.
- **Sidebar:** 256px, `#0b0e14` background, uppercase nav labels with active blue right-border + gradient tint, gradient Focus button, user row.
- **Dashboard (Today):** 12-col bento grid with 192px SVG focus ring, 7-day sparkline trend chart, full-width stacked time distribution bar with category stat cards, Recent Sessions vertical cards, AI Insight card with goal progress bar.
- **Timeline (History):** sticky header with date nav, filter pills (All / Focus / Meetings / Communication / Browsing), vertical timeline with 48px icon circles + gradient line, active session pulsing state, glass sticky footer with summary stats.
- **Apps:** card-style app rows (56px, app icon in 40px container, category chip, mini bar); detail panel redesigned with 96px icon hero, bento grid (total usage sparkline + hourly activity chart), glass Intentionality Breakdown panel, Session History, AI banner footer.
- **Focus:** "Deep Work" page header, 72px monospace timer in primary color, context strip pill showing peak window, gradient 48px Start button, surface-low stat cards (22px 900 values), Recent Sessions with streak badge and focus quality dots.
- **Settings:** 2-col 7/5 grid layout (System Preferences); profile card with 80px avatar and member chips; icon boxes on tracking rows; App Taxonomy section; full web companion linking logic preserved and restyled.
- **Insights:** bento Week in Review with AI Summary card, Focus Intensity bar chart, 3 pattern cards, Actionable Intelligence glassmorphism panel, AI chat with pinned input bar.
- **DESIGN.md:** fully rewritten to document the Intelligent Monolith design system — color tokens, typography scale, component patterns, per-view layouts, light-mode compatibility rules.

## v1.1.2 - 2026-03-24

- Fixed AI chat not appearing when API key is set. Root cause: a single failing IPC call in Promise.all caused the catch handler to override hasApiKey to false.
- Refined visual design: added depth through surface layering, wrapped content sections in cards for visual grouping.
- Replaced colored category pills with subtle dot indicators throughout all views.
- Increased stat prominence (28px semibold in Today, 24px in Focus/Apps detail).
- Fixed focus session labeling: "Unlabeled" now shows "Focus session" as fallback.
- Sidebar: increased width, added MENU label, active nav items are now semibold.
- Light mode cards get subtle shadows; dark mode cards use brighter borders.
- History and Apps views now stretch to full available width.
- Settings cards now have proper section titles (14px semibold).

## v1.1.1 - 2026-03-24

- Restyled entire UI to match Windows 11 Fluent Design language.
- Removed SaaS dashboard patterns: gradient backgrounds, colored card borders, oversized border radius.
- Increased information density across all views with compact 36px list rows and borderless stat strips.
- Native font stack (Segoe UI Variable), warm neutral color palette, accent-as-punctuation.
- Sidebar uses 3px vertical accent bar instead of rounded pill highlights.
- Insight cards now use simple headline + body text with dividers instead of colored left borders.

## v1.1.0 - 2026-03-23

- Redesigned the Today, Focus, History, Apps, and Insights views around interpretation-first UX instead of raw activity display.
- Added algorithmic insight cards that work without an API key, plus kept AI chat as an optional enhancement.
- Added a 6 PM daily summary notification and a weekday morning tracking nudge.
- Added distraction alerts after sustained time in entertainment or social apps.
- Added context switching detection across Today and Insights.
- Grouped activity feeds and grouped session views to remove micro-session noise.
