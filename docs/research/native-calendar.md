# Native calendar access

Bounded research for DEV-255. This note informs implementation; it does not override [calendar events and tracked blocks](../specs/calendar-and-blocks.md) or the accepted product rule that a calendar row is scheduled context, never proof of attendance.

## Audit of `docs/research/`

This checkout had no `docs/research/` tree. The standing note that the folder held only `boop-agent` is stale here: there is no `boop-agent` research file, and no other research notes to carry forward. This file is the first research document in the folder.

## What the code did when this was written

`src/main/services/calendarSignals.ts` collected a day's timed events as `CalendarSignal`: title, 12-hour start clock, duration in minutes, attendee **count** (never names, locations, or notes). All-day events were dropped because the signal shape requires a start time and inventing midnight would misrepresent the day.

- **macOS:** `execFile` of `icalBuddy` if it was on `PATH` or in Homebrew's bin dirs. Most installs do not have that CLI. The packaged app's `PATH` often omits Homebrew even when a terminal would find it. The feature worked on one machine by accident.
- **Windows:** one PowerShell script against the running Outlook COM object and its default calendar folder. Native-ish, but Outlook-only, and it throws when Outlook is not installed.
- **Linux:** returned `null` (treated as "this install has no calendar source").
- **OAuth:** the Google/Outlook connector framework was removed on 2026-07-26. OAuth remains the recorded fallback, not a live path.

The scan-ledger contract stays: an unreachable source **throws** so the day is not remembered as empty; a source that ran and found no timed events returns `null`.

## macOS — EventKit (ship this)

Apple Calendar is the system store. Google, Outlook, Exchange, and iCloud calendars that the person already added to Calendar.app are visible through one EventKit read after one Calendar permission.

| Question | Finding |
| --- | --- |
| API | `EventKit.EKEventStore`. `calendars(for: .event)` then `predicateForEvents(withStart:end:calendars:)`. Recurring instances expand in that query. |
| Permission | One TCC Calendar grant. Pre-Sonoma: `NSCalendarsUsageDescription` + `requestAccess(to: .event)`. Sonoma+: `NSCalendarsFullAccessUsageDescription` + `requestFullAccessToEvents`. Write-only access cannot read events. |
| Prompt attribution | macOS attributes EventKit to the **responsible process**. Electron does not disclaim responsibility for children, so a helper spawned by Daylens is charged to `Daylens.app` — one prompt named Daylens, not a helper binary. The main app Info.plist must carry the usage strings. The helper should **not** disclaim responsibility. |
| Helper shape | A short-lived Swift binary, same packaging pattern as `capture-helper`. EventKit's access callback can land on the main queue; the helper must pump `RunLoop` instead of deadlocking on a semaphore. |
| What we do not use | `icalBuddy`, Calendar.app AppleScript, or reading Calendar.sqlitedb. Those are third-party, Automation-permission, or private-store paths. |
| Denied / missing helper | Throw (day stays collectable). Granting Calendar later can still enrich old days. |
| First-run latency | `requestFullAccessToEvents` blocks until the person answers the system sheet. The helper timeout must outlive that click; this is a subprocess watchdog, not a product cap. |

Packaged builds need the usage strings on `Daylens.app` via electron-builder `extendInfo`. Hardened runtime without App Sandbox does not need the sandbox calendar entitlement.

## Windows — researched, not shipped as WinRT in this change

The OS calendar API is WinRT `Windows.ApplicationModel.Appointments` (`AppointmentManager.RequestStoreAsync`, `AppointmentStoreAccessType.AllCalendarsReadOnly`). In principle it is EventKit's counterpart: one store, accounts already in the Windows Calendar app.

It is **not** reliable for today's Daylens Windows install:

- The API declares the `appointmentsSystem` capability and expects **package identity**. Unpackaged Win32 / NSIS Electron processes commonly fail with `E_APPMODEL_ERROR_NO_PACKAGE`.
- Daylens ships NSIS for ordinary Windows users. AppX/MSIX exists as a separate store path and is not the default download.
- Even with identity, the store only sees calendars the Windows Calendar app actually syncs. Many people live in classic Outlook instead.

**Current fallback (kept, marked):** Outlook COM via PowerShell, default calendar folder, same payload shape. Throws when Outlook is missing so the day stays collectable.

**OAuth fallback:** Microsoft Graph `/me/calendarView`. Needs an app registration and a sign-in. Recorded as fallback only; the connector framework is gone.

**Next native attempt, when someone sits at a Windows machine:** a small helper that calls `AppointmentManager` from an AppX-identity build, and keep Outlook COM behind it for classic Outlook. Do not guess that WinRT works from NSIS without that proof.

## Linux — no universal store

There is no EventKit equivalent.

| Desktop | Native store | Notes |
| --- | --- | --- |
| GNOME / many GTK sessions | Evolution Data Server (`libecal` / `ECal.Client` + `EDataServer.SourceRegistry`) | Real local API. Requires EDS and the calendars the session actually configured. Not present on every distro install. |
| KDE | Akonadi | Separate stack. A GNOME helper would see nothing. |
| Other | none | Headless and many tiling setups have no calendar daemon. |

Third-party CLIs (`khal`, `gcalcli`, calendar files in `~/.local`) are the same class of accident as icalBuddy. Do not depend on them.

**Current path:** `collectCalendarEvents` returns `null` on Linux — a permanent property of the install, not a transient failure.

**Fallback:** OAuth to Google or Graph, when that framework exists again. Until then Linux days have no calendar signal.

A future native Linux helper would have to detect EDS vs Akonadi vs none, and still throw when the session has no store (so a later install of Evolution can enrich old days). That is not in this change.

## Decision applied in code

1. macOS reads EventKit through `src/native/calendar-helper`. icalBuddy is not a fallback.
2. Windows keeps Outlook COM, documented as the fallback until a package-identity WinRT path is proven.
3. Linux stays empty, documented here.
4. OAuth stays fallback-only and is not reintroduced here.
5. Payload, all-day skip, and throw-vs-empty contracts do not change.
