# Daylens Windows

Daylens is a Windows Electron app that passively tracks app and website activity, turns it into productivity insights, and helps users understand how their day is actually unfolding.

## Features

- Interpreted Today, Focus, History, Apps, and Insights views that explain what tracked numbers mean instead of only listing raw data.
- Short first-run onboarding that captures display name, goals, launch-on-login preference, and an optional Anthropic API key.
- Algorithmic insight cards that work without an API key, including peak hours, context switching, focus streak, allocation, browser habit, and goal progress reads.
- Optional AI chat layered on top of local tracked data for follow-up questions and deeper analysis.
- Grouped activity feeds and grouped session history that filter out micro-session noise and surface real work blocks.
- Focus sessions paired with live "what you're working on" feedback and on-task or off-task status from the current tracked app.
- Daily summary notifications around 6 PM and weekday morning nudges when no activity has been tracked yet.
- Distraction alerts after sustained time in entertainment or social apps.
- App detail views with usage interpretation, grouped sessions, and hour-of-day mini charts.
- GitHub-backed Windows releases with `electron-updater` metadata, in-app progress, and published "what's new" notes so installed apps can update without leaving Daylens.

## Development

- `npm start` runs the Electron app in development mode.
- `npm run typecheck` checks TypeScript without emitting build output.
- `npm run build:all` builds the main, preload, and renderer bundles.
- `npm run dist:win` builds the NSIS installer and update metadata into `dist-release/`.
