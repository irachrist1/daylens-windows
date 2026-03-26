# Platform Audit

Audited scope: every Swift file under `../daylens/Daylens/` as of 2026-03-26.

Category legend:

- `[SHARED-SAFE]` pure data models or logic with no macOS-only APIs in the file
- `[PLATFORM-LIGHT]` logic is portable, but the file touches Apple/macOS app APIs that need a Windows abstraction
- `[PLATFORM-HEAVY]` deeply tied to macOS app lifecycle, AppKit, Accessibility, AppleScript, SwiftUI views, or macOS-only browser/process behavior

Current counts:

- `29` `SHARED-SAFE`
- `12` `PLATFORM-LIGHT`
- `46` `PLATFORM-HEAVY`

Important safety rule: the Windows/Electron app must keep using `DaylensWindows/`. Nothing in this audit should be interpreted as permission to share `~/Library/Application Support/Daylens/`.

## App

| File | Category | macOS APIs used | Windows equivalent |
|------|----------|-----------------|-------------------|
| `App/AppDelegate.swift` | `[PLATFORM-HEAVY]` | `AppKit` (`NSStatusItem`, `NSMenu`, `NSApplication`, `NSColor`, `NSFont`, `NSImage`) | Electron main-process tray/menu code |
| `App/AppState.swift` | `[PLATFORM-LIGHT]` | `SwiftUI` app state wiring, `UserDefaults`, `ProcessInfo` | Shared renderer/main state store |
| `App/Constants.swift` | `[SHARED-SAFE]` | None beyond `Foundation` constants | Shared TypeScript constants |
| `App/DaylensApp.swift` | `[PLATFORM-HEAVY]` | `SwiftUI` `App`, `WindowGroup`, `Commands`, `NSApplicationDelegateAdaptor` | Electron bootstrap + React app shell |

## Models

| File | Category | macOS APIs used | Windows equivalent |
|------|----------|-----------------|-------------------|
| `Models/ActivityEvent.swift` | `[SHARED-SAFE]` | None beyond `Foundation`/`GRDB` | Same SQLite row / TS interface |
| `Models/AppCategory.swift` | `[SHARED-SAFE]` | None in-file; classification rules only | Same enum + classifier logic in TypeScript |
| `Models/AppSession.swift` | `[SHARED-SAFE]` | None beyond `Foundation`/`GRDB` | Same SQLite row / TS interface |
| `Models/BrowserSession.swift` | `[SHARED-SAFE]` | None beyond `Foundation`/`GRDB` | Same SQLite row / TS interface |
| `Models/DailySummary.swift` | `[SHARED-SAFE]` | None beyond `Foundation`/`GRDB` | Same SQLite row / TS interface |
| `Models/GeneratedReport.swift` | `[SHARED-SAFE]` | None beyond `Foundation`/`GRDB` | Same SQLite row / TS interface |
| `Models/TrackingState.swift` | `[SHARED-SAFE]` | None beyond `Foundation` | Same enum in TypeScript |
| `Models/UserMemory.swift` | `[SHARED-SAFE]` | None beyond `Foundation`/`GRDB` | Same SQLite row / TS interface |
| `Models/UserProfile.swift` | `[SHARED-SAFE]` | None beyond `Foundation`/`GRDB` | Same SQLite row / TS interface |
| `Models/WebsiteVisit.swift` | `[SHARED-SAFE]` | None beyond `Foundation`/`GRDB` | Same SQLite row / TS interface |
| `Models/WorkContextBlock.swift` | `[SHARED-SAFE]` | None beyond `Foundation` | Same grouped-block contract in TypeScript |

## Services

| File | Category | macOS APIs used | Windows equivalent |
|------|----------|-----------------|-------------------|
| `Services/AI/AIPromptBuilder.swift` | `[SHARED-SAFE]` | None beyond `Foundation` string building | Same prompt builder in TypeScript |
| `Services/AI/AIService.swift` | `[PLATFORM-LIGHT]` | `URLSession`, `UserDefaults`, key storage via `KeychainService` | `fetch`/HTTP client + secure settings abstraction |
| `Services/AI/BlockLabelCache.swift` | `[PLATFORM-LIGHT]` | `UserDefaults` | `electron-store` or JSON settings cache |
| `Services/AI/LocalAnalyzer.swift` | `[SHARED-SAFE]` | None beyond `Foundation` | Same fallback summarizer in TypeScript |
| `Services/FocusSessionManager.swift` | `[SHARED-SAFE]` | None beyond `Foundation`, timers, `GRDB` | Same focus-session logic in TypeScript |
| `Services/NotificationService.swift` | `[PLATFORM-LIGHT]` | `UserNotifications` (`UNUserNotificationCenter`) | Windows toast/Electron notification service |
| `Services/Permissions/PermissionManager.swift` | `[PLATFORM-HEAVY]` | `AppKit` `NSWorkspace`, Accessibility trust APIs, `ServiceManagement` `SMAppService` | Win32 permission/startup registration layer |
| `Services/Persistence/Database.swift` | `[PLATFORM-LIGHT]` | `FileManager` application-support path conventions | `app.getPath('userData')` + same SQLite schema |
| `Services/Persistence/DatabaseQueries.swift` | `[SHARED-SAFE]` | None beyond `Foundation`/`GRDB` | Same SQL/query layer in TypeScript |
| `Services/ReportGenerator.swift` | `[SHARED-SAFE]` | None beyond `Foundation` | Same markdown report generator |
| `Services/Security/KeychainService.swift` | `[PLATFORM-LIGHT]` | `Security` (`SecItemCopyMatching`, `SecItemAdd`, `SecItemUpdate`, `SecItemDelete`) | Windows Credential Manager / DPAPI wrapper |
| `Services/Sync/BIP39Wordlist.swift` | `[SHARED-SAFE]` | None beyond `Foundation` | Same embedded wordlist |
| `Services/Sync/PreferencesService.swift` | `[PLATFORM-LIGHT]` | `CryptoKit` SHA-256, `URLSession` | Node `crypto` + HTTP client |
| `Services/Sync/SnapshotExporter.swift` | `[PLATFORM-LIGHT]` | `AppKit` (`NSWorkspace`, `NSImage`), `Bundle.main` resources | Same JSON exporter with Windows icon/file abstraction |
| `Services/Sync/SyncConfiguration.swift` | `[PLATFORM-LIGHT]` | `Bundle.main` Info.plist lookup | Electron config/env abstraction |
| `Services/Sync/SyncUploader.swift` | `[SHARED-SAFE]` | None beyond `Foundation` networking/scheduling in-file | Same sync scheduler/uploader |
| `Services/Sync/WorkspaceLinker.swift` | `[PLATFORM-LIGHT]` | `Security` random bytes, `Host.current()` device naming | Node `crypto` + OS hostname/device info |
| `Services/Tracking/AccessibilityService.swift` | `[PLATFORM-HEAVY]` | `ApplicationServices` Accessibility (`AXUIElement`, `AXIsProcessTrusted`) | UI Automation / accessibility bridge |
| `Services/Tracking/ActivityTracker.swift` | `[PLATFORM-HEAVY]` | `AppKit` `NSWorkspace`, `NSRunningApplication` activation/deactivation notifications | Win32 foreground-window/process tracker |
| `Services/Tracking/Browser/AppleScriptURLProvider.swift` | `[PLATFORM-HEAVY]` | `NSAppleScript` | UI Automation + CDP bridge |
| `Services/Tracking/Browser/BrowserRegistry.swift` | `[PLATFORM-HEAVY]` | `NSWorkspace` app lookup plus macOS browser install/path assumptions | Windows browser registry/process/path detector |
| `Services/Tracking/Browser/DomainIntelligence.swift` | `[SHARED-SAFE]` | None beyond `Foundation` | Same domain classifier in TypeScript |
| `Services/Tracking/BrowserHistoryReader.swift` | `[PLATFORM-HEAVY]` | macOS browser history file locations (`~/Library/...`), Safari/Chromium profile conventions | Windows browser-history readers per browser family |
| `Services/Tracking/FocusScoreCalculator.swift` | `[SHARED-SAFE]` | None beyond `Foundation` | Same scoring logic |
| `Services/Tracking/IdleDetector.swift` | `[PLATFORM-HEAVY]` | `IOKit` (`IOServiceGetMatchingServices`, `IORegistryEntryCreateCFProperties`) | Win32 `GetLastInputInfo()` bridge |
| `Services/Tracking/SessionNormalizer.swift` | `[SHARED-SAFE]` | None beyond `Foundation`/`GRDB` | Same normalization logic |
| `Services/Tracking/TrackingCoordinator.swift` | `[PLATFORM-HEAVY]` | `AppKit` frontmost app polling, browser/accessibility orchestration, timers | Electron main-process tracking coordinator |
| `Services/Tracking/WorkContextGrouper.swift` | `[SHARED-SAFE]` | None beyond `Foundation` | Direct TypeScript port for parity |
| `Services/Update/UpdateChecker.swift` | `[PLATFORM-LIGHT]` | `Bundle.main`, `UserDefaults`, `URLSession` | Same update-check logic with Electron packaging metadata |
| `Services/Update/UpdateInstaller.swift` | `[PLATFORM-HEAVY]` | `AppKit` `NSWorkspace`, DMG/relaunch flow, macOS app-bundle install semantics | Windows installer/updater flow |

## ViewModels

| File | Category | macOS APIs used | Windows equivalent |
|------|----------|-----------------|-------------------|
| `ViewModels/AppsViewModel.swift` | `[SHARED-SAFE]` | None beyond `Foundation`/`Observation` | Same renderer view-model logic |
| `ViewModels/HistoryViewModel.swift` | `[SHARED-SAFE]` | None beyond `Foundation`/`Observation` | Same renderer view-model logic |
| `ViewModels/InsightsViewModel.swift` | `[SHARED-SAFE]` | None beyond `Foundation`/`Observation` | Same renderer view-model logic |
| `ViewModels/OnboardingViewModel.swift` | `[SHARED-SAFE]` | None beyond `Foundation`/`Observation` | Same renderer view-model logic |
| `ViewModels/ReportsViewModel.swift` | `[SHARED-SAFE]` | None beyond `Foundation`/`Observation` | Same renderer view-model logic |
| `ViewModels/SettingsViewModel.swift` | `[PLATFORM-LIGHT]` | `AppKit` `NSSavePanel`, `UniformTypeIdentifiers` | Electron save dialog + export action |
| `ViewModels/TodayViewModel.swift` | `[SHARED-SAFE]` | None beyond `Foundation`/`Observation` | Same renderer view-model logic |

## Views

| File | Category | macOS APIs used | Windows equivalent |
|------|----------|-----------------|-------------------|
| `Views/Apps/AppDetailView.swift` | `[PLATFORM-HEAVY]` | `SwiftUI` | Electron/React view |
| `Views/Apps/AppsView.swift` | `[PLATFORM-HEAVY]` | `SwiftUI` | Electron/React view |
| `Views/Components/UpdateBanner.swift` | `[PLATFORM-HEAVY]` | `SwiftUI` | Electron/React view |
| `Views/History/HistoryView.swift` | `[PLATFORM-HEAVY]` | `SwiftUI` | Electron/React view |
| `Views/Insights/ChatView.swift` | `[PLATFORM-HEAVY]` | `SwiftUI` | Electron/React view |
| `Views/Insights/InsightsView.swift` | `[PLATFORM-HEAVY]` | `SwiftUI` | Electron/React view |
| `Views/Onboarding/NotificationPermissionStep.swift` | `[PLATFORM-HEAVY]` | `SwiftUI`, `UserNotifications` | Electron/React onboarding UI |
| `Views/Onboarding/OnboardingFlow.swift` | `[PLATFORM-HEAVY]` | `SwiftUI` | Electron/React onboarding UI |
| `Views/Onboarding/PermissionStep.swift` | `[PLATFORM-HEAVY]` | `SwiftUI`, `AppKit` | Electron/React onboarding UI |
| `Views/Onboarding/ProfileSetupStep.swift` | `[PLATFORM-HEAVY]` | `SwiftUI` | Electron/React onboarding UI |
| `Views/Onboarding/ReadyStep.swift` | `[PLATFORM-HEAVY]` | `SwiftUI` | Electron/React onboarding UI |
| `Views/Onboarding/WelcomeStep.swift` | `[PLATFORM-HEAVY]` | `SwiftUI` | Electron/React onboarding UI |
| `Views/Reports/ReportsView.swift` | `[PLATFORM-HEAVY]` | `SwiftUI` | Electron/React reports UI |
| `Views/Settings/PrivacySection.swift` | `[PLATFORM-HEAVY]` | `SwiftUI` | Electron/React settings UI |
| `Views/Settings/ProfileEditSheet.swift` | `[PLATFORM-HEAVY]` | `SwiftUI` | Electron/React settings UI |
| `Views/Settings/SettingsView.swift` | `[PLATFORM-HEAVY]` | `SwiftUI` | Electron/React settings UI |
| `Views/Settings/WebCompanionSection.swift` | `[PLATFORM-HEAVY]` | `SwiftUI`, `CoreImage` QR generation | Electron/React settings UI |
| `Views/Shared/AppIconView.swift` | `[PLATFORM-HEAVY]` | `SwiftUI`, `AppKit` (`NSWorkspace`, `NSImage`) | React component + Windows icon extraction |
| `Views/Shared/CategoryBreakdownCard.swift` | `[PLATFORM-HEAVY]` | `SwiftUI` | Electron/React component |
| `Views/Shared/DateNavigator.swift` | `[PLATFORM-HEAVY]` | `SwiftUI` | Electron/React component |
| `Views/Shared/DesignSystem.swift` | `[PLATFORM-HEAVY]` | `SwiftUI`, `AppKit` color/font bridging | CSS/React design system |
| `Views/Shared/EmptyStateView.swift` | `[PLATFORM-HEAVY]` | `SwiftUI` | Electron/React component |
| `Views/Shared/UsageBar.swift` | `[PLATFORM-HEAVY]` | `SwiftUI` | Electron/React component |
| `Views/Shell/FloatingHUD.swift` | `[PLATFORM-HEAVY]` | `SwiftUI` | Electron/React shell |
| `Views/Shell/HeaderBar.swift` | `[PLATFORM-HEAVY]` | `SwiftUI` | Electron/React shell |
| `Views/Shell/InspectorPanel.swift` | `[PLATFORM-HEAVY]` | `SwiftUI` | Electron/React shell |
| `Views/Shell/MainShell.swift` | `[PLATFORM-HEAVY]` | `SwiftUI` | Electron/React shell |
| `Views/Shell/Sidebar.swift` | `[PLATFORM-HEAVY]` | `SwiftUI` | Electron/React shell |
| `Views/Timeline/BlockDetailPopover.swift` | `[PLATFORM-HEAVY]` | `SwiftUI` | Electron/React timeline UI |
| `Views/Timeline/TimelineBlock.swift` | `[PLATFORM-HEAVY]` | `SwiftUI` | Electron/React timeline UI |
| `Views/Timeline/TimelineGrid.swift` | `[PLATFORM-HEAVY]` | `SwiftUI` | Electron/React timeline UI |
| `Views/Timeline/TimelineView.swift` | `[PLATFORM-HEAVY]` | `SwiftUI` | Electron/React timeline UI |
| `Views/Today/BentoCards.swift` | `[PLATFORM-HEAVY]` | `SwiftUI` | Electron/React today dashboard UI |
| `Views/Today/TodayView.swift` | `[PLATFORM-HEAVY]` | `SwiftUI` | Electron/React today dashboard UI |
| `Views/Today/TopAppsCard.swift` | `[PLATFORM-HEAVY]` | `SwiftUI` | Electron/React today dashboard UI |

## Takeaways

- `Models/` is cleanly shared-safe, which is a good base for a cross-platform contract layer.
- `Services/Tracking/` is where almost all platform-heavy work lives.
- `Services/AI/`, `Services/Persistence/DatabaseQueries.swift`, `Services/Tracking/WorkContextGrouper.swift`, and the ViewModels are the best candidates for cross-platform parity docs and direct TypeScript ports.
- `Views/` and app bootstrap code are macOS-specific implementation details, not reusable contracts.
