export interface PlatformExpectationCopy {
  title: string
  body: string
}

export function getWorkspaceDeviceLabel(hostname?: string | null): string {
  const trimmed = (hostname ?? '').trim()
  return trimmed.length > 0 ? trimmed : 'This device'
}

export function getLaunchOnLoginDescription(platform: NodeJS.Platform | null | undefined): string {
  switch (platform) {
    case 'linux':
      return 'Start Daylens when you sign in so tracking survives restarts. Packaged Linux installs also write an autostart entry for this device.'
    case 'win32':
      return 'Start Daylens when Windows signs in so tracking survives restarts.'
    case 'darwin':
      return 'Start Daylens when you sign in so tracking survives restarts.'
    default:
      return 'Start Daylens on login so tracking survives restarts.'
  }
}

export function getQuickAccessExpectation(platform: NodeJS.Platform | null | undefined): PlatformExpectationCopy {
  switch (platform) {
    case 'darwin':
      return {
        title: 'Quick access',
        body: 'After setup, closing the window keeps Daylens tracking quietly and you can reopen it from the menu bar.',
      }
    case 'win32':
      return {
        title: 'Quick access',
        body: 'After setup, closing the window keeps Daylens tracking quietly and you can reopen it from the system tray in the taskbar notification area.',
      }
    case 'linux':
      return {
        title: 'Quick access',
        body: 'After setup, Daylens keeps tracking quietly and uses the system tray when the desktop supports tray or AppIndicator icons. Some Linux desktops, especially GNOME sessions without AppIndicator support, may hide the tray entry, so reopen Daylens from the app launcher when the icon is unavailable.',
      }
    default:
      return {
        title: 'Quick access',
        body: 'After setup, Daylens keeps tracking quietly when the main window is closed and stays available through the desktop shell.',
      }
  }
}

export function getInstallUpdateExpectation(platform: NodeJS.Platform | null | undefined): PlatformExpectationCopy {
  switch (platform) {
    case 'darwin':
      return {
        title: 'Install and updates',
        body: 'Install from the DMG by moving Daylens into Applications. Built-in updates are intended for signed release builds, so local ad-hoc packages are not treated as end-to-end updater proof.',
      }
    case 'win32':
      return {
        title: 'Install and updates',
        body: 'Install with the Windows Setup .exe. Packaged installs can download updates in place, but unsigned releases may still trigger SmartScreen until Daylens ships with a trusted code-signing certificate and reputation.',
      }
    case 'linux':
      return {
        title: 'Install and updates',
        body: 'AppImage installs can update in place. DEB and RPM installs can hand downloaded packages off to the system package manager. Tar.gz builds stay manual, and quick-access tray behavior still depends on desktop-shell support.',
      }
    default:
      return {
        title: 'Install and updates',
        body: 'Use the packaged desktop build for your platform so Daylens can keep tracking quietly and surface the clearest update path.',
      }
  }
}
