/**
 * Secure credential storage via keytar (OS keychain / Windows Credential Manager).
 * Replaces electron-store for sensitive values like API keys and workspace tokens.
 */
import keytar from 'keytar'

const SERVICE = 'DaylensWindows'

// Key names stored in the OS credential vault
const KEY_WORKSPACE_ID = 'workspaceId'
const KEY_WORKSPACE_TOKEN = 'workspaceToken'
const KEY_DEVICE_ID = 'deviceId'
const KEY_RECOVERY_MNEMONIC = 'recoveryMnemonic'

// ─── Workspace ──────────────────────────────────────────────────────────────

export async function getWorkspaceId(): Promise<string | null> {
  return keytar.getPassword(SERVICE, KEY_WORKSPACE_ID)
}

export async function setWorkspaceId(id: string): Promise<void> {
  await keytar.setPassword(SERVICE, KEY_WORKSPACE_ID, id)
}

export async function getWorkspaceToken(): Promise<string | null> {
  return keytar.getPassword(SERVICE, KEY_WORKSPACE_TOKEN)
}

export async function setWorkspaceToken(token: string): Promise<void> {
  await keytar.setPassword(SERVICE, KEY_WORKSPACE_TOKEN, token)
}

// ─── Device ─────────────────────────────────────────────────────────────────

export async function getDeviceId(): Promise<string | null> {
  return keytar.getPassword(SERVICE, KEY_DEVICE_ID)
}

export async function setDeviceId(id: string): Promise<void> {
  await keytar.setPassword(SERVICE, KEY_DEVICE_ID, id)
}

// ─── Recovery ───────────────────────────────────────────────────────────────

export async function getRecoveryMnemonic(): Promise<string | null> {
  return keytar.getPassword(SERVICE, KEY_RECOVERY_MNEMONIC)
}

export async function setRecoveryMnemonic(mnemonic: string): Promise<void> {
  await keytar.setPassword(SERVICE, KEY_RECOVERY_MNEMONIC, mnemonic)
}

// ─── Teardown ───────────────────────────────────────────────────────────────

export async function clearAllCredentials(): Promise<void> {
  await Promise.all([
    keytar.deletePassword(SERVICE, KEY_WORKSPACE_ID),
    keytar.deletePassword(SERVICE, KEY_WORKSPACE_TOKEN),
    keytar.deletePassword(SERVICE, KEY_DEVICE_ID),
    keytar.deletePassword(SERVICE, KEY_RECOVERY_MNEMONIC),
  ])
}
