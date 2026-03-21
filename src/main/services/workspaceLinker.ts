/**
 * WorkspaceLinker — handles workspace creation, BIP39 mnemonic, and browser link codes.
 * Mirrors the macOS WorkspaceLinker.swift for parity.
 */
import crypto from 'node:crypto'
import os from 'node:os'
import {
  setWorkspaceId,
  setWorkspaceToken,
  setDeviceId,
  setRecoveryMnemonic,
  getWorkspaceId,
  getWorkspaceToken,
  getDeviceId,
  getRecoveryMnemonic,
  clearAllCredentials,
} from './credentials'
import { BIP39_ENGLISH } from './bip39wordlist'

// Validate BIP39 wordlist integrity at module load time
if (BIP39_ENGLISH.length !== 2048) {
  throw new Error(`BIP39 wordlist corrupted: expected 2048 words, got ${BIP39_ENGLISH.length}`)
}

// Convex site URL — hardcoded for the Daylens backend.
// In production, replace with your deployed URL.
const CONVEX_SITE_URL = 'https://decisive-aardvark-847.convex.site'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WorkspaceResult {
  workspaceId: string
  mnemonic: string
  linkCode: string
  linkToken: string
}

export interface BrowserLinkResult {
  displayCode: string
  fullToken: string
}

export interface SyncStatus {
  isLinked: boolean
  workspaceId: string | null
  lastSyncAt: number | null
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Creates a new anonymous workspace on the Convex backend.
 * Generates a BIP39 mnemonic and derives the workspace ID.
 */
export async function createWorkspace(): Promise<WorkspaceResult> {
  const mnemonic = generateMnemonic()
  const workspaceId = deriveWorkspaceId(mnemonic)
  const recoveryKeyHash = sha256Hex(workspaceId)

  // Ensure device ID exists
  let deviceId = await getDeviceId()
  if (!deviceId) {
    deviceId = crypto.randomUUID()
    await setDeviceId(deviceId)
  }

  const body = {
    recoveryKeyHash,
    deviceId,
    displayName: os.hostname() || 'This PC',
  }

  const result = await callConvex('createWorkspace', body)
  if (!result.sessionToken) {
    throw new Error('Invalid server response — no session token')
  }

  // Store credentials
  await setWorkspaceId(workspaceId)
  await setWorkspaceToken(result.sessionToken)
  await setRecoveryMnemonic(mnemonic)

  // Create browser link code
  const browserLink = await createBrowserLinkWithToken(result.sessionToken)

  return {
    workspaceId,
    mnemonic,
    linkCode: browserLink.displayCode,
    linkToken: browserLink.fullToken,
  }
}

/**
 * Creates a new browser link code for an already-linked workspace.
 */
export async function createBrowserLink(): Promise<BrowserLinkResult> {
  const sessionToken = await getWorkspaceToken()
  if (!sessionToken) throw new Error('Not linked to a workspace')

  return createBrowserLinkWithToken(sessionToken)
}

/**
 * Disconnects the workspace — clears all credentials.
 */
export async function disconnect(): Promise<void> {
  await clearAllCredentials()
}

/**
 * Returns the current sync status.
 */
export async function getSyncStatus(lastSyncAt: number | null): Promise<SyncStatus> {
  const workspaceId = await getWorkspaceId()
  const token = await getWorkspaceToken()

  return {
    isLinked: Boolean(workspaceId && token),
    workspaceId,
    lastSyncAt,
  }
}

/**
 * Returns the stored recovery mnemonic (if any).
 */
export async function getStoredMnemonic(): Promise<string | null> {
  return getRecoveryMnemonic()
}

/**
 * Returns the Convex site URL (for the sync uploader).
 */
export function getConvexSiteUrl(): string {
  return CONVEX_SITE_URL
}

/**
 * Returns the stored session token (for Bearer auth in sync uploads).
 */
export async function getSessionToken(): Promise<string | null> {
  return getWorkspaceToken()
}

// ─── BIP39 Mnemonic ─────────────────────────────────────────────────────────

function generateMnemonic(): string {
  // 128 bits of entropy
  const entropy = crypto.randomBytes(16)

  // SHA256 checksum — first 4 bits
  const hash = crypto.createHash('sha256').update(entropy).digest()
  const checksumByte = hash[0]

  // Combine: 128 bits entropy + 4 bits checksum = 132 bits
  const bits: number[] = []
  for (const byte of entropy) {
    for (let i = 7; i >= 0; i--) {
      bits.push((byte >> i) & 1)
    }
  }
  for (let i = 7; i >= 4; i--) {
    bits.push((checksumByte >> i) & 1)
  }

  // Split into 12 groups of 11 bits
  const words: string[] = []
  for (let i = 0; i < 12; i++) {
    let index = 0
    for (let j = 0; j < 11; j++) {
      index = (index << 1) | bits[i * 11 + j]
    }
    words.push(BIP39_ENGLISH[index])
  }

  return words.join(' ')
}

// ─── Workspace ID derivation ────────────────────────────────────────────────

function deriveWorkspaceId(mnemonic: string): string {
  const normalized = normalizeMnemonic(mnemonic)
  const input = 'daylens-workspace-v1:' + normalized
  const hash = crypto.createHash('sha256').update(input).digest()
  const b32 = base32Encode(hash)
  return 'ws_' + b32.slice(0, 26).toLowerCase()
}

function normalizeMnemonic(mnemonic: string): string {
  return mnemonic
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')
}

// ─── Browser link code ──────────────────────────────────────────────────────

async function createBrowserLinkWithToken(sessionToken: string): Promise<BrowserLinkResult> {
  const fullToken = crypto.randomBytes(16).toString('hex') // 32 hex chars
  const displayCode = fullToken.slice(0, 8).toUpperCase()
  const tokenHash = sha256Hex(fullToken)

  await callConvex('createLinkCode', { tokenHash, displayCode }, sessionToken)

  return { displayCode, fullToken }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex')
}

function base32Encode(data: Buffer): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let result = ''
  let bits = 0
  let buffer = 0

  for (const byte of data) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      result += alphabet[(buffer >> bits) & 0x1f]
    }
  }

  if (bits > 0) {
    result += alphabet[(buffer << (5 - bits)) & 0x1f]
  }

  return result
}

async function callConvex(
  path: string,
  body: Record<string, unknown>,
  bearerToken?: string,
): Promise<Record<string, unknown>> {
  const url = `${CONVEX_SITE_URL}/${path}`

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (bearerToken) {
    headers['Authorization'] = `Bearer ${bearerToken}`
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    // Truncate server response to avoid leaking internal details in error messages
    const safeText = text.slice(0, 200)
    throw new Error(`Server error (HTTP ${res.status}): ${safeText}`)
  }

  return (await res.json()) as Record<string, unknown>
}
