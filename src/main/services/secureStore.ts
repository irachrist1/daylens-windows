import fs from 'node:fs'
import path from 'node:path'

type KeytarModule = typeof import('keytar')

export interface SecureStoreDiagnostics {
  available: boolean
  backend: 'keytar' | 'unavailable'
  loadError: string | null
  hint: string | null
}

export interface LinuxSessionBusInfo {
  address: string | null
  inferred: boolean
}

let keytarModule: KeytarModule | null = null
let keytarLoadAttempted = false
let keytarLoadError: string | null = null

function formatError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

export function getLinuxSessionBusInfo(): LinuxSessionBusInfo {
  const explicitAddress = process.env.DBUS_SESSION_BUS_ADDRESS?.trim() || null
  if (explicitAddress) {
    return {
      address: explicitAddress,
      inferred: false,
    }
  }

  if (process.platform !== 'linux') {
    return {
      address: null,
      inferred: false,
    }
  }

  const runtimeDir = process.env.XDG_RUNTIME_DIR?.trim()
  if (!runtimeDir) {
    return {
      address: null,
      inferred: false,
    }
  }

  const busSocket = path.join(runtimeDir, 'bus')
  try {
    if (fs.statSync(busSocket).isSocket()) {
      return {
        address: `unix:path=${busSocket}`,
        inferred: true,
      }
    }
  } catch {
    // No inferred session bus available.
  }

  return {
    address: null,
    inferred: false,
  }
}

function ensureLinuxSessionBusAddress(): void {
  if (process.platform !== 'linux' || process.env.DBUS_SESSION_BUS_ADDRESS?.trim()) return

  const sessionBus = getLinuxSessionBusInfo()
  if (sessionBus.inferred && sessionBus.address) {
    process.env.DBUS_SESSION_BUS_ADDRESS = sessionBus.address
  }
}

function linuxSecretServiceHint(): string {
  const sessionBus = getLinuxSessionBusInfo()
  const sessionBusHint = sessionBus.address
    ? null
    : 'No D-Bus session bus was detected for this process.'
  return [
    sessionBusHint,
    'Install libsecret and make sure a Secret Service provider such as gnome-keyring or KeePassXC is running in your desktop session.',
  ].filter(Boolean).join(' ')
}

export function getSecureStore(): KeytarModule | null {
  if (keytarLoadAttempted) return keytarModule

  keytarLoadAttempted = true
  try {
    ensureLinuxSessionBusAddress()
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    keytarModule = require('keytar') as KeytarModule
    keytarLoadError = null
  } catch (error) {
    keytarModule = null
    keytarLoadError = formatError(error)
  }

  return keytarModule
}

export function getSecureStoreDiagnostics(): SecureStoreDiagnostics {
  const available = Boolean(getSecureStore())
  return {
    available,
    backend: available ? 'keytar' : 'unavailable',
    loadError: available ? null : keytarLoadError,
    hint: available
      ? null
      : process.platform === 'linux'
        ? linuxSecretServiceHint()
        : 'The operating system credential store is unavailable.',
  }
}

export function ensureSecureStore(operation: string): KeytarModule {
  const store = getSecureStore()
  if (store) return store

  const diagnostics = getSecureStoreDiagnostics()
  const details = [diagnostics.loadError, diagnostics.hint].filter(Boolean).join(' ')
  throw new Error(
    details
      ? `${operation} is unavailable because secure credential storage could not be loaded. ${details}`
      : `${operation} is unavailable because secure credential storage could not be loaded.`,
  )
}
