// The renderer cannot call shell.openExternal directly; the main process only
// opens URLs that pass this policy. Besides https links, the capture health
// page needs the macOS System Settings scheme so "Open Settings" can deep-link
// to the Privacy panes (Accessibility, Screen Recording, Full Disk Access).
const ALLOWED_PROTOCOLS = new Set(['https:', 'x-apple.systempreferences:'])

export function isAllowedExternalUrl(url: string): boolean {
  try {
    return ALLOWED_PROTOCOLS.has(new URL(url).protocol)
  } catch {
    return false
  }
}
