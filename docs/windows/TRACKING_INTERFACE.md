# Tracking Interface

This document defines the behavior the Windows/Electron app must match if it wants to produce Daylens-compatible tracking data.

Important safety rule: the Windows app must keep using `DaylensWindows/` for its support directory. It must never read/write the macOS app's `~/Library/Application Support/Daylens/` directory in normal operation.

## 1. Per-session data contract

Each foreground app session must produce the same logical fields as `AppSession`:

| Field | Meaning on macOS | Windows implementation target |
|------|------------------|-------------------------------|
| `bundleID` | Stable macOS bundle identifier like `com.apple.Safari` | Stable Windows surrogate identifier. Use a canonical string built from normalized process name plus normalized executable path. Keep the field name as `bundleID` in shared contracts even though the value is Windows-specific. |
| `appName` | Localized app display name from `NSRunningApplication.localizedName` | Friendly process/app display name from the executable metadata or window/process name. |
| `date` | Local calendar day at session start | Local calendar day at session start. |
| `startTime` | Foreground activation timestamp | Foreground activation timestamp, serialized as ISO8601 with offset. |
| `endTime` | Finalized timestamp when session closes | Same. |
| `duration` | `endTime - startTime` in seconds | Same. |
| `category` | `AppCategory` value assigned from classification rules or overrides | Same 14-category enum contract. |
| `isBrowser` | True only for primary browsers | Same meaning; Chromium/Edge/Firefox-like browsers should set this true, while hybrid browser-capable apps should stay false unless they are primary browsers. |

For browser-capable foreground sessions, the Windows app also needs equivalent website-visit data matching `WebsiteVisit`:

| Field | Meaning | Windows implementation target |
|------|---------|-------------------------------|
| `domain` | Normalized host without leading `www.` | Same. |
| `fullURL` | Best-known active-tab URL | Same. |
| `pageTitle` | Active-tab title or focused window title fallback | Same. |
| `browserBundleID` | Browser app identifier | Windows surrogate identifier for the browser process/app. |
| `startTime` / `endTime` | Time span for the current site visit | Same. |
| `duration` | Seconds on the site | Same. |
| `confidence` | `medium` for accessibility/UI extraction, `high` for stronger evidence like AppleScript or browser history | Preserve the same semantics. |
| `source` | `.accessibility`, `.browserHistory`, etc. | Use equivalent source labels in Windows code, even if the implementation changes. |

## 2. Idle detection

The prompt assumption was slightly out of date: the current Daylens macOS code does not use `CGEventSourceSecondsSinceLastEventType`.

Actual current implementation:

- File: `Services/Tracking/IdleDetector.swift`
- API: IOKit `IOServiceGetMatchingServices` + `IORegistryEntryCreateCFProperties`
- Source of truth: `IOHIDSystem`'s `HIDIdleTime`
- Poll interval: 5 seconds
- Idle threshold: `Constants.idleThreshold = 120.0` seconds

Windows equivalent:

- Use Win32 `GetLastInputInfo()`.
- Poll every 5 seconds to match current behavior.
- Treat the user as idle at `>= 120` seconds of no input.

Related behavior:

- If the frontmost window is native fullscreen, Daylens suppresses idle pausing and keeps the passive session open until fullscreen ends or user activity resumes.

## 3. Browser URL extraction

Current macOS stack has three layers:

1. `AccessibilityService.browserAddressBarURL(for:)`
   - API: `AXUIElement`
   - Strategy: walk the focused window tree and look for an `AXTextField` or `AXComboBox` containing a URL-like value.
   - Confidence: `medium`

2. `AppleScriptURLProvider.activeTab(for:)`
   - API: `NSAppleScript`
   - Strategy: browser-specific AppleScript/JXA to read active-tab URL and title.
   - Confidence: `high`

3. `BrowserHistoryReader`
   - API/data source: native browser SQLite history databases
   - Strategy: poll every 60 seconds, copy locked DBs to temp files, read durable visit history, and backfill `website_visits`.
   - Confidence: `high`

Windows equivalent target:

- First pass: UI Automation API to read the address bar and focused window title.
- Second pass for Chromium browsers (Chrome, Edge, Brave, Arc-equivalent if any): Chrome DevTools Protocol when available.
- Durable backfill: browser-history readers where practical, especially Chromium-family history DBs.
- Normalize the host exactly like macOS: strip a leading `www.` before storing `domain`.

## 4. Session boundary rules

### When an app session starts

- On macOS, `ActivityTracker` starts a session when `NSWorkspace.didActivateApplicationNotification` fires, or when frontmost-app reconciliation recovers a missed activation.

Windows parity target:

- Start a session whenever the foreground app changes to a different canonical app identifier.

### When an app session ends

A session is finalized when any of these happens:

- The foreground app changes to a different app.
- The user becomes system-idle and fullscreen suppression is not active.
- The tracked app terminates.
- Tracking stops.

Important smoothing logic that must also be preserved:

- `deactivationGracePeriod = 1.5s`
  - A deactivation is held briefly before finalization.
  - If the same app immediately reactivates, the session continues instead of splitting.

- `spaceTransitionWindow = 2.0s`
  - App/Space/fullscreen transitions get a reconciliation window so temporary activation glitches do not create false sessions.

- Duplicate activations for the same frontmost app are ignored.

### Minimum duration to persist

- `Constants.minimumUsageDuration = 3.0` seconds
- Sessions shorter than 3 seconds are not written to `app_sessions`.

### Website visit finalization

- Current site visit closes when the domain changes, the frontmost app stops being browser-capable, idle pause finalizes it, or repeated extraction failures force closeout.
- `Constants.minimumWebsiteVisitDuration = 5.0` seconds
- Visits shorter than 5 seconds are not written to `website_visits`.

## 5. WorkContextGrouper parity

The Windows app should port `WorkContextGrouper.swift` directly into TypeScript. The current algorithm is rule-based and deterministic.

### The 6 grouping heuristics

1. Idle-gap segmentation
   - A gap greater than 15 minutes between adjacent sessions creates a hard block boundary before any deeper analysis happens.

2. Standalone meeting extraction
   - Any single meetings-category session lasting at least 20 minutes becomes its own work block, with labels like `Zoom Call`, `Teams Call`, or `Meeting`.

3. Long single-app streak preservation
   - If one app dominates for more than 45 minutes, Daylens preserves that run as a dedicated block even if there are brief interruptions inside it.

4. Communication interruption smoothing
   - Short communication/email interruptions are treated as part of surrounding work when they are brief enough and bracketed by the same work context on both sides.

5. Sustained category-shift splitting
   - For low-coherence mixed blocks, if a non-dominant category sustains at least 15 minutes, the block is split at that category run.

6. Medium-coherence developer-flow handling
   - Rapid dev+browsing or dev+research switching is intentionally kept together as one `Building & Testing` style block when average dwell is short; otherwise medium-coherence blocks with slower switching get split at the first slow category boundary.

### Threshold constants to keep identical

| Constant | Current value | Meaning |
|------|---------------|---------|
| `idleGapThreshold` | 15 minutes | Hard block split when session gap exceeds this. |
| `meetingThreshold` | 20 minutes | Minimum duration for a meeting session to stand alone. |
| `longSingleAppThreshold` | 45 minutes | Minimum dominant-app time for a dedicated streak block. |
| `briefInterruptionThreshold` | 3 minutes | Any interruption shorter than this can stay inside a long-app streak. |
| `sustainedCategoryThreshold` | 15 minutes | Minimum run length for a sustained different-category split. |
| `communicationInterruptionThreshold` | 5 minutes | Max duration for communication/email interruption smoothing. |
| `fastSwitchThreshold` | 5 minutes | Average dwell threshold for dev testing flows to remain merged. |
| `slowSwitchThreshold` | 15 minutes | Average dwell threshold that triggers a slow-switch split in medium-coherence blocks. |

### Confidence / labeling behavior

- High confidence block:
  - Formation reason is `.coherent`
  - Block is bounded by gaps on both sides
  - Coherence score is `> 0.75`

- Low confidence block:
  - Formation reason is `.fragmented`
  - Coherence score is `< 0.40`
  - Switch count is `>= 3`

- Everything else:
  - Confidence is `medium`

- Rule-based labels:
  - `Mixed Work` for low-coherence blocks
  - `Building & Testing` or `Development` for dev + browsing/research combinations
  - `Communication` for communication/email-dominant blocks
  - Otherwise the dominant category raw value

## 6. Other tracking constants worth mirroring

| Constant | Current value | Used in |
|------|---------------|---------|
| `Constants.sessionMergeThreshold` | 8 seconds | Merging closely adjacent intervals when computing longest focus streaks and in persistence/query normalization. |
| `Constants.browserHistoryPollInterval` | 60 seconds | Browser history durability/backfill polling. |
| Accessibility polling interval | 3 seconds | Active-tab enrichment loop in `TrackingCoordinator`. |
| Summary debounce | 2 seconds | Recompute daily summary shortly after a session finalizes. |
| Summary fallback timer | 15 seconds | Periodic summary refresh while tracking is active. |

## 7. Implementation guidance for Electron/Windows

- Keep the SQLite schema and JSON contracts identical.
- Keep classification and grouping rules deterministic so the same day produces the same summary labels on both platforms.
- Use Windows-native process and browser APIs behind an abstraction layer, but continue emitting Daylens field names (`bundleID`, `browserBundleID`, `category`, etc.).
- Treat the TypeScript port of `WorkContextGrouper` as parity-sensitive logic, not as a place to "improve" behavior independently.
