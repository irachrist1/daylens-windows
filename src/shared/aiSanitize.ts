// Daylens AI output sanitizer — shared between the main-process tool executor
// (sanitizeForModel) and the renderer streaming view (sanitizeForRender).
//
// The two functions share one regex corpus. sanitizeForModel strips matches
// (the model never sees them); sanitizeForRender replaces with [redacted] so
// the user knows something was filtered. Both are last-line defenses; capture-
// side hygiene strips most leak vectors before they reach either layer.

import { CREDENTIAL_PATTERNS } from './credentialPatterns'

export interface SanitizeReport {
  redactionCount: number
  patternsHit: string[]
}

function applyPatterns(input: string, replacement: string | ((name: string) => string)): { text: string; report: SanitizeReport } {
  let text = input
  let redactionCount = 0
  const patternsHit: string[] = []

  for (const { name, regex, exempt } of CREDENTIAL_PATTERNS) {
    // Reset in case any caller passed a stateful regex by accident; ours are
    // module-local so this is defensive.
    regex.lastIndex = 0
    text = text.replace(regex, (match, ...args) => {
      // For url_query the first capture group is the URL prefix we want to keep.
      const groupOne = typeof args[0] === 'string' ? args[0] : null
      if (exempt) {
        // replace() callback args: capture groups, then offset, then the whole
        // string — none of our patterns use named groups.
        const offsetIndex = args.findIndex((arg) => typeof arg === 'number')
        const offset = args[offsetIndex] as number
        const whole = args[offsetIndex + 1] as string
        if (exempt(match, offset, whole)) return match
      }
      redactionCount++
      patternsHit.push(name)
      const value = typeof replacement === 'function' ? replacement(name) : replacement
      if (name === 'url_query' && groupOne) {
        try {
          const url = new URL(match)
          const publicId = url.searchParams.get('v')
          if (publicId && /^[A-Za-z0-9_-]{6,20}$/.test(publicId)) return `${groupOne}?v=${publicId}`
        } catch {
          // Fall through to query stripping.
        }
        // For sanitizeForModel (replacement === '') we want the URL to keep
        // its host+path and lose the query. For sanitizeForRender we want
        // host+path then a redaction marker. Branch on whether the
        // replacement is empty so both behaviors fall out naturally.
        return value === '' ? groupOne : `${groupOne}${value}`
      }
      return value
    })
  }

  return { text, report: { redactionCount, patternsHit } }
}

// sanitizeForModel: strip matches entirely (the model never sees the secret).
// Returns just the cleaned text; report is available via sanitizeForModelWithReport.
export function sanitizeForModel(value: string): string {
  if (!value) return value
  return applyPatterns(value, '').text
}

// sanitizeForRender: replace each match with [redacted] so the user can see
// something was filtered out. Returns the cleaned text plus a report so the
// caller can fire an analytics event when redactionCount > 0.
export function sanitizeForRender(text: string): { text: string; report: SanitizeReport } {
  if (!text) return { text, report: { redactionCount: 0, patternsHit: [] } }
  return applyPatterns(text, '[redacted]')
}

// Older chat rows may contain the retired inline memory nudge. Memory consent
// now lives exclusively in the action widget, so hide the legacy paragraph
// without rewriting the user's stored conversation.
export function stripLegacyMemoryNudge(text: string): string {
  if (!text) return text
  return text.replace(
    /(?:\n\s*){1,2}By the way\s*[—-]\s*[^\n]*?Want me to remember that\?\s*Just say\s*["“]remember that["”]\.?\s*$/i,
    '',
  ).trimEnd()
}

// Deep walk a tool result and run sanitizeForModel on every string field.
// Plain objects, arrays, primitives, and nested combinations are all handled.
// Returns a new value; the input is left untouched so the trace harness can
// still log the pre-sanitization shape.
export function sanitizeToolResult<T>(value: T): T {
  if (value == null) return value
  if (typeof value === 'string') return sanitizeForModel(value) as unknown as T
  if (Array.isArray(value)) return value.map((item) => sanitizeToolResult(item)) as unknown as T
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = sanitizeToolResult(child)
    }
    return out as unknown as T
  }
  return value
}

// Capture-side helper for browser window titles. When a window_title contains
// a URL token, store stripped to host (or host+path for allowlisted hosts);
// drop query/fragment unconditionally. The original full URL stays in
// website_visits.url, which is captured independently from browser history.
const PATH_ALLOWLIST_HOSTS = new Set([
  'docs.google.com',
  'github.com',
  'linear.app',
  'notion.so',
  'www.notion.so',
  'slack.com',
  'app.slack.com',
])

const URL_TOKEN_REGEX = /\bhttps?:\/\/[^\s)\]'"<>]+/i

export function stripBrowserUrlFromTitle(title: string | null | undefined, isBrowserApp: boolean): string | null {
  if (!title) return title ?? null
  if (!isBrowserApp) return title
  const match = title.match(URL_TOKEN_REGEX)
  if (!match) return title
  const rawUrl = match[0]
  let stripped: string
  try {
    const parsed = new URL(rawUrl)
    const host = parsed.hostname.toLowerCase()
    const keepPath = PATH_ALLOWLIST_HOSTS.has(host)
    const path = keepPath ? parsed.pathname.replace(/\/+$/, '') : ''
    stripped = `${parsed.host}${path}`
  } catch {
    // URL parse failure: fall back to a regex-based strip of query/fragment.
    stripped = rawUrl.replace(/[?#].*$/, '')
  }
  return title.replace(rawUrl, stripped).trim() || stripped
}
