# Architecture

Daylens Windows is an Electron app (main + preload + renderer) that tracks active window usage, browser history, and focus sessions, then exposes AI-powered insights via the Anthropic API. All data stays local — SQLite on disk, no cloud sync.

## Process layout

```
main process  (Node.js / Electron)
  ├── services/
  │   ├── tracking.ts     — polls @paymoapp/active-window every 5 s, flushes to DB
  │   ├── browser.ts      — polls Chromium browser history SQLite every 60 s
  │   ├── ai.ts           — Anthropic SDK, streaming chat with activity context
  │   ├── database.ts     — better-sqlite3 singleton, runs schema migrations
  │   └── settings.ts     — electron-store (JSON, outside the DB)
  ├── ipc/
  │   ├── db.handlers.ts      — DB read queries exposed via IPC
  │   ├── focus.handlers.ts   — focus session start/stop/query
  │   ├── ai.handlers.ts      — AI chat IPC bridge
  │   ├── settings.handlers.ts— settings get/set IPC bridge
  │   └── debug.handlers.ts   — debug panel info (tracking status, last classify)
  ├── db/
  │   ├── schema.ts       — DDL: app_sessions, focus_sessions, website_visits, ai_conversations
  │   └── queries.ts      — typed insert/select helpers (no raw SQL in handlers)
  ├── tray.ts             — system-tray icon + context menu (Show / Quit)
  └── index.ts            — entry: app lifecycle, BrowserWindow creation, IPC registration

preload (contextBridge)
  └── exposes window.api — typed IPC wrappers; no Node access from renderer

renderer  (React + Vite + Tailwind v4)
  └── views/
      ├── Today.tsx       — live tracking + today's totals
      ├── History.tsx     — per-day app usage breakdown
      ├── Apps.tsx        — all-time per-app stats
      ├── Insights.tsx    — AI chat interface
      ├── Focus.tsx       — focus session timer
      └── Settings.tsx    — API key, theme, launch-on-login
```

## IPC contract

All channels are declared as constants in `src/shared/types.ts` under the `IPC` object. Every call goes through `window.api.*` (contextBridge) — the renderer never touches `ipcRenderer` directly.

## Data model

| Table | Purpose |
|---|---|
| `app_sessions` | One row per contiguous window-focus session |
| `focus_sessions` | User-initiated focus timer records |
| `website_visits` | Per-visit rows from browser history |
| `ai_conversations` | JSON-serialised message arrays |

## Key decisions

- **`@paymoapp/active-window`** replaces `active-win` v8 (macOS-only). It is a native CJS module — synchronous `getActiveWindow()` — lazy-loaded so native binding failures are non-fatal.
- **`productName: "DaylensWindows"`** prevents `userData` path collision with the macOS Swift companion app that owns `~/Library/Application Support/Daylens/`.
- **Custom title bar** (`titleBarStyle: 'hidden'`) — renderer owns all chrome. Window controls (minimize/maximize/close) are handled via IPC (`window:minimize` etc.).
- **Hide-to-tray on close** — `win.on('close')` is cancelled unless `isQuitting` is set; real quit only via tray menu.
