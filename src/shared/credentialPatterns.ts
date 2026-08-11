// Shared credential / secret regex corpus. Used by aiSanitize (model + render
// redaction) and by the sync allowlist value guards. Order matters: specific
// provider shapes run first so they take credit; generic backstops mop up.

export interface CredentialPattern {
  name: string
  regex: RegExp
  /** Return true to leave one specific match alone. Used by the generic
   *  backstops to spare document filenames — the basename of an artifact like
   *  weekly-report-for-your-manager-1a2b3c4d.md is 32+ chars of [a-z0-9-] and
   *  otherwise renders as "[redacted].md" in answers. */
  exempt?: (match: string, offset: number, whole: string) => boolean
}

// A match that reads as a human filename slug immediately followed by a
// document extension is a filename, not a secret. Scoped to the generic
// entropy backstops only — provider-shaped tokens (sk-…, ghp_…, JWTs) are
// never exempted. Deliberately NOT exempt: .json/.html (signed URLs put
// high-entropy tokens in the path right before those), any slug without at
// least two plain dictionary-word segments ("secrets-<token>.md"), and any
// slug carrying a long entropy-looking segment ("prod-api-<token>.md").
const DOC_EXTENSION_AFTER_MATCH = /^\.(?:md|markdown|xlsx|xls|csv|txt|docx|pdf)\b/i
function isDocumentFilename(match: string, offset: number, whole: string): boolean {
  if (!DOC_EXTENSION_AFTER_MATCH.test(whole.slice(offset + match.length, offset + match.length + 12))) return false
  const segments = match.split(/[-_]/)
  const wordSegments = segments.filter((segment) => /^[A-Za-z]{2,12}$/.test(segment))
  if (wordSegments.length < 2) return false
  // Any long non-word segment is entropy-shaped (hash, token), not a slug word.
  return segments.every((segment) => segment.length < 16 || /^[A-Za-z]+$/.test(segment))
}

export const CREDENTIAL_PATTERNS: CredentialPattern[] = [
  // 1. URL query strings (and fragments) on http(s) URLs. Also any bare
  // ?code=… style query when it follows a path-looking prefix.
  { name: 'url_query', regex: /(https?:\/\/[^\s?#]+)[?#][^\s)\]"'<>]*/gi },

  // 2. JWT — three base64url segments separated by dots, starting with eyJ
  // (a base64 of "{"...). Must run before generic base64 backstop.
  { name: 'jwt', regex: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },

  // 3. Provider-specific token shapes.
  { name: 'openai_key', regex: /sk-[A-Za-z0-9_-]{20,}/g },
  { name: 'slack_token', regex: /xox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'google_oauth', regex: /ya29\.[A-Za-z0-9_.-]+/g },
  { name: 'github_pat', regex: /gh[pousr]_[A-Za-z0-9]{30,}/g },
  { name: 'linear_api_key', regex: /lin_api_[A-Za-z0-9]{10,}/g },
  { name: 'aws_access_key', regex: /\bAKIA[0-9A-Z]{16}\b/g },

  // 4. OAuth callback "code=…" / "state=…" / "access_token=…" parameters
  // even when they appear bare (e.g. captured into a window title without
  // the leading URL). Catches the reproduced leak shape.
  { name: 'oauth_param', regex: /\b(?:code|state|access_token|id_token|refresh_token|token|client_secret|api_key)=[A-Za-z0-9_.\-+/=%]{8,}/gi },

  // 5. Hex blobs ≥32 chars (sha-256 hashes, AWS secrets without the prefix,
  // long capture cookies). Word-boundary anchored to avoid clipping into
  // surrounding text.
  { name: 'hex_blob', regex: /\b[0-9a-fA-F]{32,}\b/g },

  // 6. Base64-ish ≥24 chars with mixed case+digits and no whitespace.
  // Requires at least one digit and one of each case to avoid hitting plain
  // English words. The character class includes the URL-safe variants.
  { name: 'base64_blob', regex: /\b(?=[A-Za-z0-9+/=_-]*\d)(?=[A-Za-z0-9+/=_-]*[A-Z])(?=[A-Za-z0-9+/=_-]*[a-z])[A-Za-z0-9+/=_-]{24,}\b/g, exempt: isDocumentFilename },

  // 7. Generic high-entropy backstop: ≥32 chars of [A-Za-z0-9_-] with no
  // whitespace. Runs last so the more-specific patterns claim the match.
  { name: 'generic_token', regex: /\b[A-Za-z0-9_-]{32,}\b/g, exempt: isDocumentFilename },
]

export function findCredentialPattern(value: string): string | null {
  if (!value) return null
  for (const { name, regex, exempt } of CREDENTIAL_PATTERNS) {
    regex.lastIndex = 0
    if (!exempt) {
      if (regex.test(value)) {
        regex.lastIndex = 0
        return name
      }
      continue
    }
    for (const match of value.matchAll(regex)) {
      if (!exempt(match[0], match.index ?? 0, value)) return name
    }
  }
  return null
}

export function containsCredential(value: string): boolean {
  return findCredentialPattern(value) !== null
}
