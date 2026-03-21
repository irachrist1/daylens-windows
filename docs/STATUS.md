# Current Status — 2026-03-21

## What's shipped

Windows releases are published at https://github.com/irachrist1/daylens-windows/releases/latest

Core features currently shipped:
- Active window tracking (5 s poll, idle detection, session flush)
- Browser history ingestion (Chrome, Edge, Brave on Windows)
- Focus session timer
- AI insights chat (Anthropic API, streaming)
- System tray (hide-to-tray, single-instance lock)
- Settings (API key, theme, launch-on-login)
- NSIS installer via electron-builder

### Release health
- `v0.1.6-win` is a bad Windows installer build: it emits the Electron main process as ESM while the packaged runtime still expects CommonJS semantics on first launch.
- The fix is to emit the standalone main bundle as CommonJS and keep the app free of Squirrel-only startup hooks, which are not used by the NSIS installer path.

## What's not done / known gaps

### Browser tracking — Windows paths not verified in production
`services/browser.ts` has Windows paths stubbed (`windowsBrowsers()`) but they have not been tested on a real Windows machine. The macOS paths are battle-tested; Windows ones are inferred from known Chromium defaults. Worth verifying on first real-user report.

### Firefox not supported
Firefox uses a profile-based SQLite layout that differs from Chromium. Currently filtered out. Would need a profile-discovery step before the history read.

### ARM64 Windows builds not available
`@paymoapp/active-window` has no prebuilt Windows ARM64 binaries. Building from source via node-gyp fails on Python 3.12+ (`distutils` removed). Options if ARM64 is needed:
1. Patch node-gyp to use `setuptools` instead of `distutils` in CI (`pip install setuptools`)
2. Switch to an alternative active-window library that ships ARM64 binaries
3. Wait for `@paymoapp/active-window` to add ARM64 prebuild

### No auto-update
No auto-update or electron-updater wired up. Users must manually download new releases. Would need a code-signing certificate before this is worth implementing.

### No code signing
The Windows installer is unsigned — Windows Defender / SmartScreen will show a warning on first run. Users must click "More info → Run anyway". Signing requires an EV certificate (~$300/yr).

### macOS userData path workaround
Running this Electron app on macOS sets `userData` to `~/Library/Application Support/DaylensWindows` (not `Daylens`) to avoid collision with the Swift companion app. This block in `index.ts` can be removed if this app is ever Windows-only.

## Repo links

| Resource | URL |
|---|---|
| GitHub repo | https://github.com/irachrist1/daylens-windows |
| Latest release | https://github.com/irachrist1/daylens-windows/releases/latest |
| macOS app repo | https://github.com/irachrist1/daylens |
| CI workflow | `.github/workflows/release-windows.yml` |

## Version scheme

`v{major}.{minor}.{patch}-win` — always suffix `-win` to distinguish from macOS tags.

Release tags advance independently for Windows packaging fixes. The CI workflow stamps the pushed tag version into `package.json` during the Windows release build so the published installer filename and app metadata match the tag.
