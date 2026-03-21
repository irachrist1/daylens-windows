# Activity Tracking

## App tracking (`services/tracking.ts`)

Polls every 5 seconds using `@paymoapp/active-window` (synchronous CJS, cross-platform).

**Session lifecycle:**
1. `poll()` fires — reads active window (bundleId + appName)
2. Noise filter — skips OS system processes and the app itself
3. If the active app changed, `flushCurrent()` writes the previous session to DB
4. A new in-flight `InFlightSession` starts for the new app
5. Sessions shorter than 10 s are discarded on flush

**Idle handling:** `powerMonitor.getSystemIdleTime()` — if ≥ 120 s idle, the current session is flushed timestamped at the moment idle began (not "now"), then tracking parks until activity resumes.

**Noise filters:**
- `OS_NOISE_BUNDLE_IDS` — macOS system processes by bundle ID
- `OS_NOISE_APP_NAMES` — macOS + Windows OS-level exe names
- `SELF_NOISE_SUBSTRINGS` — Electron shell, Daylens itself, dev tooling

**App classifier:** `RULES` array — `[RegExp, AppCategory][]`, first match wins. Normalises exe names (strips `.exe` / `.app`) before matching. Categories: `development`, `communication`, `browsing`, `writing`, `design`, `aiTools`, `email`, `research`, `productivity`, `meetings`, `entertainment`, `system`, `uncategorized`.

**Focus categories** (counted as "focused time"): `development`, `research`, `writing`, `aiTools`, `design`, `productivity`.

**Live session IPC:** `tracking:get-live` returns the current in-flight session so Today view can show real-time data without waiting for the next DB flush.

## Browser tracking (`services/browser.ts`)

Polls every 60 seconds. Reads Chromium browser SQLite history files directly.

**Supported browsers:**
- macOS: Chrome, Brave, Arc, Microsoft Edge
- Windows: Chrome (`chrome.exe`), Edge (`msedge.exe`), Brave (`brave.exe`)
- Firefox: skipped (non-Chromium profile layout)

**Copy-before-open:** The History file + WAL + SHM are copied to a temp location before opening. This avoids lock contention with the running browser and ensures WAL-committed data is visible.

**Timestamps:** Chrome stores visit times as microseconds since 1601-01-01. BigInt arithmetic is used throughout to avoid precision loss (values exceed `Number.MAX_SAFE_INTEGER`).

**Deduplication:** `INSERT OR IGNORE` on `(browser_bundle_id, visit_time)` — safe to re-insert rows from a previous poll window.

**Noise filter:** Visits with `0 < duration < 2s` are skipped (Chrome pre-fetches and redirects).

**Status object** (`browserStatus`): tracks last poll time, today's visit count, last error, and count of pollable browsers — exposed to the debug panel.

## Database schema

```sql
CREATE TABLE app_sessions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  bundle_id       TEXT NOT NULL,
  app_name        TEXT NOT NULL,
  start_time      INTEGER NOT NULL,   -- Unix ms
  end_time        INTEGER NOT NULL,   -- Unix ms
  duration_seconds INTEGER NOT NULL,
  category        TEXT NOT NULL,
  is_focused      INTEGER NOT NULL    -- 0/1
);

CREATE TABLE website_visits (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  domain            TEXT NOT NULL,
  page_title        TEXT,
  url               TEXT,
  visit_time        INTEGER NOT NULL,  -- Unix ms
  duration_sec      INTEGER NOT NULL,
  browser_bundle_id TEXT,
  source            TEXT,
  UNIQUE(browser_bundle_id, visit_time)
);
```
