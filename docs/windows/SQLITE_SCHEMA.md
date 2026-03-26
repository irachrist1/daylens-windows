# SQLite Schema Snapshot

This snapshot reflects the live Daylens macOS schema after migrations `v1_create_tables` through `v7_generated_reports`, verified read-only from:

```text
file:$HOME/Library/Application Support/Daylens/daylens.sqlite?immutable=1
```

Important safety rule: the Electron/Windows app must keep using its own support directory (`DaylensWindows/`). It must never point at `~/Library/Application Support/Daylens/`.

## Applied migrations

```text
v1_create_tables
v2_focus_sessions
v3_category_overrides
v4_focus_session_label
v5_user_profile
v6_user_memories
v7_generated_reports
```

## Tables

### `activity_events`

```sql
CREATE TABLE activity_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp DATETIME NOT NULL,
  eventType TEXT NOT NULL,
  bundleID TEXT NOT NULL,
  appName TEXT NOT NULL,
  windowTitle TEXT,
  domain TEXT,
  pageTitle TEXT,
  duration DOUBLE,
  isIdle BOOLEAN NOT NULL DEFAULT 0,
  confidence TEXT NOT NULL DEFAULT 'low',
  source TEXT NOT NULL
)
```

### `ai_conversations`

```sql
CREATE TABLE ai_conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  createdAt DATETIME NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  date DATE
)
```

### `app_sessions`

```sql
CREATE TABLE app_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date DATE NOT NULL,
  bundleID TEXT NOT NULL,
  appName TEXT NOT NULL,
  startTime DATETIME NOT NULL,
  endTime DATETIME NOT NULL,
  duration DOUBLE NOT NULL,
  category TEXT NOT NULL,
  isBrowser BOOLEAN NOT NULL DEFAULT 0
)
```

### `browser_sessions`

```sql
CREATE TABLE browser_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date DATE NOT NULL,
  browserBundleID TEXT NOT NULL,
  browserName TEXT NOT NULL,
  startTime DATETIME NOT NULL,
  endTime DATETIME NOT NULL,
  duration DOUBLE NOT NULL
)
```

### `category_overrides`

```sql
CREATE TABLE category_overrides (
  bundleID TEXT PRIMARY KEY,
  category TEXT NOT NULL
)
```

### `daily_summaries`

```sql
CREATE TABLE daily_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date DATE NOT NULL UNIQUE,
  totalActiveTime DOUBLE NOT NULL DEFAULT 0,
  totalIdleTime DOUBLE NOT NULL DEFAULT 0,
  appCount INTEGER NOT NULL DEFAULT 0,
  browserCount INTEGER NOT NULL DEFAULT 0,
  domainCount INTEGER NOT NULL DEFAULT 0,
  sessionCount INTEGER NOT NULL DEFAULT 0,
  contextSwitches INTEGER NOT NULL DEFAULT 0,
  focusScore DOUBLE NOT NULL DEFAULT 0,
  longestFocusStreak DOUBLE NOT NULL DEFAULT 0,
  topAppBundleID TEXT,
  topDomain TEXT,
  aiSummary TEXT,
  aiSummaryGeneratedAt DATETIME
)
```

### `focus_sessions`

This is the exact `sqlite_master` text after `v4_focus_session_label`; note the appended `label` column formatting.

```sql
CREATE TABLE focus_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date DATE NOT NULL,
  startTime DATETIME NOT NULL,
  endTime DATETIME,
  targetMinutes INTEGER NOT NULL,
  actualDuration DOUBLE NOT NULL DEFAULT 0,
  status TEXT NOT NULL
, "label" TEXT)
```

### `generated_reports`

```sql
CREATE TABLE "generated_reports" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "reportType" TEXT NOT NULL DEFAULT 'daily', "periodStart" DATETIME NOT NULL, "periodEnd" DATETIME NOT NULL, "markdownContent" TEXT NOT NULL DEFAULT '', "generatedByAI" BOOLEAN NOT NULL DEFAULT 0, "createdAt" DATETIME NOT NULL)
```

### `grdb_migrations`

```sql
CREATE TABLE grdb_migrations (identifier TEXT NOT NULL PRIMARY KEY)
```

### `user_memories`

```sql
CREATE TABLE "user_memories" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "fact" TEXT NOT NULL, "source" TEXT NOT NULL DEFAULT 'chat', "createdAt" DATETIME NOT NULL)
```

### `user_profiles`

```sql
CREATE TABLE "user_profiles" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "name" TEXT NOT NULL, "role" TEXT NOT NULL DEFAULT 'other', "goals" TEXT NOT NULL DEFAULT 'deep_focus', "workHoursStart" INTEGER NOT NULL DEFAULT 9, "workHoursEnd" INTEGER NOT NULL DEFAULT 18, "idealDayDescription" TEXT NOT NULL DEFAULT '', "biggestDistraction" TEXT, "createdAt" DATETIME NOT NULL, "updatedAt" DATETIME NOT NULL)
```

### `website_visits`

```sql
CREATE TABLE website_visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date DATE NOT NULL,
  domain TEXT NOT NULL,
  fullURL TEXT,
  pageTitle TEXT,
  browserBundleID TEXT NOT NULL,
  startTime DATETIME NOT NULL,
  endTime DATETIME NOT NULL,
  duration DOUBLE NOT NULL,
  confidence TEXT NOT NULL,
  source TEXT NOT NULL
)
```

### `sqlite_sequence`

This internal SQLite table exists because multiple tables use `AUTOINCREMENT`.

```sql
CREATE TABLE sqlite_sequence(name,seq)
```

## Indices

### Explicit indices

```sql
CREATE INDEX activity_events_on_bundleID ON activity_events(bundleID)
CREATE INDEX activity_events_on_timestamp ON activity_events(timestamp)
CREATE INDEX app_sessions_on_bundleID ON app_sessions(bundleID)
CREATE INDEX app_sessions_on_date ON app_sessions(date)
CREATE INDEX browser_sessions_on_date ON browser_sessions(date)
CREATE INDEX daily_summaries_on_date ON daily_summaries(date)
CREATE INDEX focus_sessions_on_date ON focus_sessions(date)
CREATE INDEX focus_sessions_on_startTime ON focus_sessions(startTime)
CREATE INDEX website_visits_on_date ON website_visits(date)
CREATE INDEX website_visits_on_domain ON website_visits(domain)
```

### Implicit auto-indices

These exist because of primary-key or unique constraints, so SQLite reports them with `sql = NULL`.

```text
sqlite_autoindex_category_overrides_1
sqlite_autoindex_daily_summaries_1
sqlite_autoindex_grdb_migrations_1
```

## GRDB / SQLite notes

- `grdb_migrations` is GRDB's bookkeeping table. The Electron app should treat it as read-only metadata.
- `sqlite_sequence` is SQLite's own `AUTOINCREMENT` bookkeeping table, not an application table.
- `foreignKeysEnabled = true` is set in GRDB configuration, but the current schema does not define foreign-key constraints.
- `DATE` and `DATETIME` columns are stored using SQLite's dynamic typing. The contract should treat them as logical dates/timestamps, not as a guarantee of a single on-disk representation.
- New v5-v7 tables (`user_profiles`, `user_memories`, `generated_reports`) currently have no secondary indices.
- Safe read-only access from Node should use immutable mode, for example `file:/.../daylens.sqlite?immutable=1`, and only against the intended database file for that platform.
