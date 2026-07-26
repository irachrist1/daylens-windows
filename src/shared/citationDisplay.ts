// Human titles for citations and disclosed files (DEV-244). A citation must
// read as a title a person recognizes ("Prompts are technical debt"), never a
// raw kebab-case filename with a content hash. Display-only: the stable
// identity and the full disclosed statement stay on the record and remain
// inspectable through the shared-context inspector.

const FILE_EXTENSION_RE = /\.(md|markdown|txt|pdf|docx?|xlsx?|csv|html?|json|pptx?|rtf|org|pages|numbers|key)$/i

/** A trailing token that is id noise, not a word: hex hashes ("4f2a9c"),
 *  digit runs ("20240115"), or long alphanumeric ids. */
function isNoiseToken(token: string): boolean {
  if (/^\d{4,}$/.test(token)) return true
  if (/^[0-9a-f]{6,}$/i.test(token) && /\d/.test(token)) return true
  if (token.length >= 12 && /^[a-z0-9]+$/i.test(token) && /\d/.test(token)) return true
  return false
}

/** Turn a filename-shaped string into a readable title: drop the extension,
 *  drop trailing hash or id tokens, replace kebab/underscore separators with
 *  spaces, and capitalize the first letter. A string that yields nothing
 *  readable comes back trimmed but otherwise unchanged, never empty. */
export function humanizeFileTitle(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return trimmed
  const withoutExtension = trimmed.replace(FILE_EXTENSION_RE, '')
  const tokens = withoutExtension.split(/[-_\s]+/).filter(Boolean)
  while (tokens.length > 1 && isNoiseToken(tokens[tokens.length - 1])) tokens.pop()
  const joined = tokens.join(' ').trim()
  if (!joined) return trimmed
  return joined.charAt(0).toUpperCase() + joined.slice(1)
}

/** True when a statement is a raw filename rather than prose: it either ends
 *  in a known document extension, or is a single kebab/underscore token. */
function looksLikeRawFilename(statement: string): boolean {
  const trimmed = statement.trim()
  if (!trimmed) return false
  if (FILE_EXTENSION_RE.test(trimmed)) return true
  return !/\s/.test(trimmed) && /[-_]/.test(trimmed)
}

const TRANSCRIPT_STATEMENT_RE = /^Granola transcript of "(.+?)":/

/**
 * The display title for one citation (or one disclosed packet item): a human
 * title, never a raw filename with a hash. Prose statements pass through
 * untouched; file-backed items resolve to a cleaned-up name.
 */
export function citationDisplayTitle(citation: {
  kind: string
  identity: string
  statement: string
}): string {
  const statement = citation.statement.trim()
  if (citation.kind === 'file_excerpt') {
    const transcript = statement.match(TRANSCRIPT_STATEMENT_RE)
    if (transcript) return `Transcript: ${transcript[1]}`
    if (citation.identity.startsWith('file:')) {
      const basename = citation.identity.slice('file:'.length).split('/').pop() ?? ''
      const title = humanizeFileTitle(basename)
      if (title) return title
    }
    // Excerpt statements read "name.ext: <content>" — the name is the title.
    const nameEnd = statement.indexOf(':')
    if (nameEnd > 0) return humanizeFileTitle(statement.slice(0, nameEnd))
    return humanizeFileTitle(statement)
  }
  if (looksLikeRawFilename(statement)) return humanizeFileTitle(statement)
  return statement
}
