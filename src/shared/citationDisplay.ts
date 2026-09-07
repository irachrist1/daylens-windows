// Citation chips must read as titles a person would recognize — never a
// kebab-case filename with a hash suffix, and never the excerpt that rides
// the recorded statement after the colon.
import type { AIMessageCitation } from './types'

const HASH_SUFFIX_RE = /[-_][a-f0-9]{6,}$/i
const EXTENSION_RE = /\.[a-z0-9]{1,8}$/i

function basenameFromIdentity(identity: string): string {
  const path = identity.startsWith('file:') ? identity.slice('file:'.length) : identity
  const parts = path.split(/[/\\]/)
  return parts[parts.length - 1] ?? path
}

function titleFromFilename(filename: string): string {
  let name = filename.trim()
  name = name.replace(EXTENSION_RE, '')
  name = name.replace(HASH_SUFFIX_RE, '')
  name = name.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!name) return filename
  if (name === name.toLowerCase() || name === name.toUpperCase()) {
    return name
      .split(' ')
      .map((word) => (word ? `${word[0].toUpperCase()}${word.slice(1).toLowerCase()}` : word))
      .join(' ')
  }
  return name
}

/** Compact label for one packet citation in the chat sources row. */
export function citationDisplayTitle(citation: Pick<AIMessageCitation, 'identity' | 'kind' | 'statement'>): string {
  const statement = citation.statement.trim()
  if (citation.kind === 'file_excerpt' || citation.identity.startsWith('file:') || citation.identity.startsWith('transcript:')) {
    const beforeColon = statement.includes(':') ? statement.slice(0, statement.indexOf(':')).trim() : ''
    const raw = beforeColon || basenameFromIdentity(citation.identity)
    const titled = titleFromFilename(raw)
    if (titled) return titled
  }
  const firstLine = statement.split(/\n/)[0]?.trim() ?? ''
  const cut = firstLine.search(/\s[—–-]\s/)
  return cut > 12 ? firstLine.slice(0, cut) : firstLine
}
