# Changelog

This changelog explains released and upcoming improvements in language meant for people using Daylens. It describes what changed and why it matters without requiring knowledge of the codebase.

## Unreleased

### One capture path

- Live capture now writes only the canonical evidence record on every platform; the parallel legacy session write is retired, so the old and new records can never drift apart again.
- Days captured before the migration still render exactly as before through the legacy compatibility reader.
- Late-night work that crosses midnight stays on the day it started, now derived from the canonical record.
- The Windows history import only fills stretches Daylens itself never observed; it can no longer shadow real captured evidence.
- Deleting activity is now backed by a structural ownership registry: every table in the database has a named deletion owner, and the test suite fails if a new table is added without one — nothing can silently escape deletion.
- Purged activity can no longer resurface through leftover document references from earlier versions of a rebuilt day.

### A more trustworthy Timeline

- Daylens now reconciles browser activity with the time the browser was actually in front, preventing background tabs from inflating website totals.
- Timeline and website breakdowns use the same underlying time ledger, so totals agree more reliably across views.
- User corrections survive more rebuild and migration paths, including corrections made before internal session identifiers change.
- Long gaps caused by sleep, lock, or missed capture end activity at the last real evidence instead of stretching work across time that was not observed.
- Timeline blocks have clearer boundaries, more specific names, and more consistent category colors.

### Better privacy and capture health

- Private and incognito windows are excluded from capture wherever the operating system and browser expose a reliable signal.
- Browser support is discovered from the application catalog and operating system instead of depending on a short hardcoded list.
- Capture health provides clearer information when permissions prevent browser evidence from being read.
- Website exclusions and foreground-time reconciliation now apply consistently to downstream summaries.
- Uninstalling actually uninstalls: removing the app on Windows and Linux clears the launch-at-login entry, and a new "Reset and uninstall" action in Settings removes the login item and asks whether to delete or keep your local data — nothing is ever deleted silently.

### Safer and more predictable AI

- Background AI work has a daily limit to prevent runaway provider costs.
- Automatic day analysis runs at controlled lifecycle points and falls back to deterministic behavior when a provider is unavailable.
- AI labels prefer specific evidence and avoid exposing raw filenames or internal-looking artifact names as activity titles.
- The assistant can only read files in visible, non-private folders of your home directory. Hidden folders, credentials such as SSH keys, system data, and anything outside your home directory are refused before any content is read, even when the assistant is asked directly.
- The assistant's read-only git access can no longer be steered into reading unrelated files or changing branches, and connected MCP servers no longer inherit the application's environment, so provider keys and tokens stay out of their reach.

### More reliable macOS updates

- macOS updates verify the downloaded release before replacing the application and provide a manual recovery path when verification is unavailable.

## 1.0.43 — AI that is easier to use

- The command palette brings chat actions and history search into one place.
- Answers can be turned into a shorter version, checklist, bullet list, or report without losing the selected answer’s meaning.
- Follow-up suggestions are based on the answer that was just given.
- The composer supports app, project, and day references, and model capabilities are easier to understand.

## 1.0.42 — More capable conversations

- Gemini conversations work again after a retired default model caused failures.
- Conversation history is searchable and supports archiving.
- Rate limits and provider errors are handled more clearly.
- Optional application, website, private-window, and pause controls were added without changing existing capture unless enabled.

## 1.0.41 — Faster AI and a clearer Timeline

- The AI tab was rebuilt to reduce unnecessary work while typing, streaming, and searching.
- Timeline refreshes are less disruptive during frequent foreground-app changes.
- Block relabeling and regeneration use a more consistent persistence path.
- Small browser fragments are combined more carefully without erasing real topic changes or gaps.

## 1.0.40 — More resilient updates

- macOS updates validate downloads, show progress, and provide clearer recovery messages when installation fails.

## 1.0.38 — First stable release

- Daylens introduced work-memory patterns, clearer active-time Timeline blocks, broader AI evidence, linked workspace support, and cross-platform release packaging.
- Windows installers returned after release-pipeline problems were resolved. Preview installers may still show SmartScreen until production signing is configured.

## 1.0.36

- Added the command palette, global shortcut, and browser-page evidence on macOS and Windows.

## 1.0.35

- Timeline grouping began respecting sustained context changes and limiting excessively long blocks.
- Apps detail shifted toward explaining what a tool was used for rather than showing session counts alone.

## 1.0.34

- Added slide-based day recaps and simplified onboarding.

## 1.0.33

- Improved follow-up suggestions and refreshed file artifacts after completed conversations.
