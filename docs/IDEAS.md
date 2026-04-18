# Ideas

## Imported From TickTick

- `Daylens: Deepen cross-device sync/workspace validation after the launch pass`
- `Feature: Annual Distraction Cost`

## Product

- Linux distro and session validation matrix beyond the initial launch pass
- Richer MCP and editor integrations for Claude Code, Cursor, and other AI tools for daylens-electron build
- Better "what changed?" debugging workflows across repos, docs, and browser activity
- Scheduled or recurring evidence packs on top of the wired core reports/export flow
- Stronger meeting and collaboration detection

## Intelligence

- Better reconstruction of long-running multi-tool work sessions
- Smarter artifact grouping across files, tabs, apps, and repos
- More reliable pricing, estimation, and billing prompts
- Better attribution for research, study, and internal workstreams

## UX

- Cleaner onboarding proof of capture
- Better timeline drill-down and artifact inspectors
- More useful app detail surfaces
- Rich tray or menu bar popup with current session, tracked time, focus score, and a few quick actions
- More polished report templates, exports, and evidence packs on top of the current AI-surface flow

## Tray Or Menu Bar Popup

If we build this later, it should be a lightweight companion to the main app, not a second dashboard.

Goals:

- show meaningful status at a glance
- open quickly near the tray or menu bar icon
- dismiss easily when the user clicks away
- help the user answer "what am I doing right now?" and "how has today gone so far?"
- provide a few high-value quick actions without forcing a full app switch

Avoid:

- duplicating the full Timeline, Apps, or AI screens
- turning it into a dumping ground for every metric we can compute
- dense charts, heavy scrolling, or complicated navigation
- noisy badges, alerts, or animated status states that create anxiety

Good candidate content:

- current tracking state
- current work session label or best live description
- today's tracked time
- today's focus time or focus score
- the current app or top app in the active block when useful
- the most recent meaningful alert, such as distraction or idle state, when relevant
- quick actions like open Daylens, pause or resume tracking, and start or stop a focus session

Platform shape:

- macOS: prefer a menu bar extra that can open a popover-like window when the content is richer than a normal menu
- Windows and Linux: prefer a small anchored flyout on primary click and keep secondary click for a concise context menu
- keep the icon itself simple and recognizable, with status treatment only when it communicates something genuinely useful

Design principle:

- glanceability first
- quick actions second
- deeper inspection through an `Open Daylens` escape hatch
