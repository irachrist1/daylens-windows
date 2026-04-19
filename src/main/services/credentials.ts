/**
 * Secure credential storage via keytar (OS keychain / Windows Credential Manager).
 * Replaces electron-store for sensitive values like API keys and workspace tokens.
 */
import { ensureSecureStore, getSecureStore } from './secureStore'

const SERVICE = 'Daylens Desktop'
const LEGACY_SERVICES = ['Daylens', 'DaylensWindows']

// Key names stored in the OS credential vault
const KEY_WORKSPACE_ID = 'workspaceId'
const KEY_WORKSPACE_TOKEN = 'workspaceToken'
const KEY_DEVICE_ID = 'deviceId'
const KEY_RECOVERY_MNEMONIC = 'recoveryMnemonic'

// ─── Workspace ──────────────────────────────────────────────────────────────

export async function getWorkspaceId(): Promise<string | null> {
  return getCredential(KEY_WORKSPACE_ID)
}

export async function setWorkspaceId(id: string): Promise<void> {
  const keytar = ensureSecureStore('Saving the Daylens workspace ID')
  await keytar.setPassword(SERVICE, KEY_WORKSPACE_ID, id)
}

export async function getWorkspaceToken(): Promise<string | null> {
  return getCredential(KEY_WORKSPACE_TOKEN)
}

export async function setWorkspaceToken(token: string): Promise<void> {
  const keytar = ensureSecureStore('Saving the Daylens workspace token')
  await keytar.setPassword(SERVICE, KEY_WORKSPACE_TOKEN, token)
}

// ─── Device ─────────────────────────────────────────────────────────────────

export async function getDeviceId(): Promise<string | null> {
  return getCredential(KEY_DEVICE_ID)
}

export async function setDeviceId(id: string): Promise<void> {
  const keytar = ensureSecureStore('Saving the Daylens device ID')
  await keytar.setPassword(SERVICE, KEY_DEVICE_ID, id)
}

// ─── Recovery ───────────────────────────────────────────────────────────────

export async function getRecoveryMnemonic(): Promise<string | null> {
  return getCredential(KEY_RECOVERY_MNEMONIC)
}

export async function setRecoveryMnemonic(mnemonic: string): Promise<void> {
  const keytar = ensureSecureStore('Saving the Daylens recovery phrase')
  await keytar.setPassword(SERVICE, KEY_RECOVERY_MNEMONIC, mnemonic)
}

// ─── Teardown ───────────────────────────────────────────────────────────────

export async function clearAllCredentials(): Promise<void> {
  const keytar = getSecureStore()
  if (!keytar) return
  const services = [SERVICE, ...LEGACY_SERVICES]
  await Promise.all(services.flatMap((service) => [
    keytar.deletePassword(service, KEY_WORKSPACE_ID),
    keytar.deletePassword(service, KEY_WORKSPACE_TOKEN),
    keytar.deletePassword(service, KEY_DEVICE_ID),
    keytar.deletePassword(service, KEY_RECOVERY_MNEMONIC),
  ]))
}

async function getCredential(account: string): Promise<string | null> {
  const keytar = getSecureStore()
  if (!keytar) return null
  const current = await keytar.getPassword(SERVICE, account)
  if (current) return current

  for (const legacyService of LEGACY_SERVICES) {
    const legacy = await keytar.getPassword(legacyService, account)
    if (!legacy) continue
    try {
      await keytar.setPassword(SERVICE, account, legacy)
    } catch {
      // Ignore migration write failures and still return the legacy value.
    }
    return legacy
  }

  return null
}
