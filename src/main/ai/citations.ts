// Citation verification — checks that named entities in a final answer
// actually appear in the tool-result evidence collected during the call.
// The extractor is intentionally narrow: false positives turn into spurious
// "I can't see evidence for X" fallbacks that ruin otherwise correct
// answers. We only flag entities that look like real, specific identifiers
// (filenames, CamelCase tokens, quoted strings, or multi-word proper
// nouns) — not every capitalized English word.

const ENTITY_STOPWORDS = new Set([
  // Acronyms and brand
  'AI', 'API', 'CSV', 'JSON', 'HTML', 'PDF', 'URL', 'USB', 'CPU', 'GPU',
  'Daylens',
  // Pronouns / demonstratives / generic capitals that appear at sentence start
  'I', 'You', 'We', 'They', 'He', 'She', 'It',
  'Your', 'My', 'Our', 'Their', 'His', 'Her', 'Its',
  'This', 'That', 'These', 'Those', 'There', 'Here', 'Either', 'Neither',
  'Other', 'Another', 'Some', 'Many', 'Most', 'Few', 'All', 'Any', 'Each',
  // Common sentence connectors / leaders
  'When', 'Where', 'What', 'Why', 'Who', 'Which', 'How',
  'And', 'But', 'So', 'Or', 'Nor', 'Yet', 'For',
  'From', 'Into', 'About', 'Through', 'Across', 'Between', 'Before',
  'After', 'While', 'Among', 'Above', 'Below', 'Beside', 'Within',
  'Now', 'Then', 'Today', 'Yesterday', 'Tomorrow',
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
  // Sentence-start fillers we have seen leak through
  'Across', 'Looking', 'Based', 'Given', 'Note', 'Total',
])

export interface CitationVerificationResult {
  ok: boolean
  missingEntities: string[]
  checkedEntities: string[]
}

function isStopword(entity: string): boolean {
  if (ENTITY_STOPWORDS.has(entity)) return true
  // Multi-word: stop if any part is a stopword.
  if (entity.includes(' ')) {
    return entity.split(/\s+/).every((part) => ENTITY_STOPWORDS.has(part))
  }
  return false
}

function looksLikeRealIdentifier(entity: string): boolean {
  // Filename or path-like: x.ts, schema.sql, src/main.
  if (/[A-Za-z0-9][\w-]*\.[A-Za-z0-9]{2,8}$/.test(entity)) return true
  // CamelCase or contains an uppercase letter in the middle (mid-word capital).
  if (/[a-z][A-Z]/.test(entity)) return true
  // Multi-word proper noun (two+ words, each capitalised) is specific enough.
  if (/^[A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9]+)+$/.test(entity)) return true
  // Contains a digit (likely an identifier like S00504 or P00027 — which the
  // verifier wants to keep checking).
  if (/\d/.test(entity)) return true
  // Hyphenated identifier (Rw-andersen, gpt-4-turbo).
  if (/[A-Za-z]-[A-Za-z]/.test(entity)) return true
  // Single-word capitalised but ≥ 5 chars — could be an app/brand name. Still
  // require at least one consonant-vowel mix to skip "AAAAH"-style noise.
  if (entity.length >= 5 && /[A-Z]/.test(entity[0]) && /[a-z]/.test(entity)) return true
  return false
}

// Quotes the model puts around its OWN prose for emphasis ("watching", "top
// apps", "merged, plus") are not citations, and flagging them costs a whole
// grounding retry: the model re-runs its tool sweep and rewrites a correct
// answer into defensive prose. Real citations (page titles, block labels,
// commit subjects, filenames, identifiers) carry a capital or a digit
// somewhere; an all-lowercase, digitless phrase does not.
function isScareQuote(entity: string): boolean {
  return !/[A-Z]/.test(entity) && !/\d/.test(entity)
}

function normalizeEntity(entity: string): string {
  return entity
    .trim()
    .replace(/^[^\w"']+/g, '')
    .replace(/[^\w]+$/g, '')
}

export function extractNamedEntities(text: string): string[] {
  const entities = new Set<string>()

  // Quoted strings — ONLY double quotes. Apostrophes inside contractions
  // (can't, you're) would otherwise produce bogus matches like "t see any
  // evidence for...". These are the model's explicit citations and the
  // strongest signal for hallucination checking.
  const quoted = text.match(/"([^"\n]{3,80})"/g) ?? []
  for (const raw of quoted) {
    const entity = normalizeEntity(raw.slice(1, -1))
    if (entity.length < 3 || isStopword(entity)) continue
    if (isScareQuote(entity)) continue
    entities.add(entity)
  }

  // Filename-like tokens (extension required). Also a strong signal.
  const filenameLike = text.match(/\b[A-Za-z0-9][\w-]{1,80}\.[A-Za-z0-9]{2,8}\b/g) ?? []
  for (const raw of filenameLike) {
    const entity = normalizeEntity(raw)
    if (entity.length < 3) continue
    if (isStopword(entity)) continue
    // Skip domain-only mentions in prose. We only want filenames/paths the
    // model presents as specific artifacts the user worked on, not generic
    // domain references in evidence-tagging prose.
    if (/^(www\.)?[A-Za-z0-9-]+\.(com|org|net|io|ai|dev|app|so|co|edu)$/i.test(entity)) continue
    entities.add(entity)
  }

  // NOTE: We deliberately do NOT scan for capitalised single-word entities
  // anymore. Anthropic answers are conversational ("Dia browser", "Apple
  // Music", "Microsoft Teams") and lowercase-fuzzy-matching against tool
  // result JSON produces too many false positives. Quoted strings and
  // filename-shaped tokens are the only entity types where a missing match
  // is a real hallucination signal.
  // looksLikeRealIdentifier is retained for future use and tests.
  void looksLikeRealIdentifier

  return [...entities]
}

export function verifyCitedEntities(answer: string, toolResults: string[]): CitationVerificationResult {
  const checkedEntities = extractNamedEntities(answer)
  if (checkedEntities.length === 0 || toolResults.length === 0) {
    return { ok: true, missingEntities: [], checkedEntities }
  }

  const evidence = toolResults.join('\n').toLowerCase()
  const missingEntities = checkedEntities.filter((entity) => !evidence.includes(entity.toLowerCase()))
  return {
    ok: missingEntities.length === 0,
    missingEntities,
    checkedEntities,
  }
}

/**
 * Verify that every HH:MM clock time in the final answer also appears in
 * the tool results. The model is told to cite block start/end times
 * verbatim from tool output (D3, minute precision). If an answer mentions
 * "09:49" but the tool only returned "09:09", that's a paraphrase
 * hallucination — the user notices because the timeline shows a
 * different time. This catches that class of error cheaply.
 *
 * Returns the list of suspect timestamps, or empty when everything cited
 * appears in tool output. Tolerates "09:09–10:08" style ranges (each end
 * is checked independently). Skips standalone "today", "yesterday",
 * "this week" etc. — those don't contain HH:MM.
 */
export interface TimestampVerificationResult {
  ok: boolean
  suspect: string[]
}

export function verifyTimestamps(answer: string, toolResults: string[]): TimestampVerificationResult {
  // Match HH:MM in 24h or 12h with am/pm. Capture both shapes so we can
  // compare against tool output (which always emits 24h HH:MM).
  const pattern = /\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/gi
  const found = new Map<string, string[]>()
  let match: RegExpExecArray | null
  while ((match = pattern.exec(answer)) !== null) {
    let hour = Number(match[1])
    const minute = Number(match[2])
    const meridiem = match[3]?.toLowerCase()
    if (meridiem === 'pm' && hour < 12) hour += 12
    if (meridiem === 'am' && hour === 12) hour = 0
    if (hour > 23 || minute > 59) continue
    const primary = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
    const candidates = [primary]
    if (!meridiem && hour <= 12) {
      const alternateHour = hour === 12 ? 0 : hour + 12
      candidates.push(`${String(alternateHour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`)
    }
    found.set(primary, candidates)
  }
  if (found.size === 0 || toolResults.length === 0) {
    return { ok: true, suspect: [] }
  }
  const evidence = toolResults.join('\n')
  const suspect: string[] = []
  for (const [ts, candidates] of found) {
    if (!candidates.some((candidate) => evidence.includes(candidate))) suspect.push(ts)
  }
  return { ok: suspect.length === 0, suspect }
}

export function citationFallback(missingEntities: string[], toolResults: string[]): string {
  // Instead of a bare refusal, strip the unverified entities and surface what
  // the evidence DOES show. If we can extract a useful signal from tool results,
  // use that. Otherwise soften with "your captured data shows X but not Y."
  const missing = missingEntities.slice(0, 3)

  // Try to extract the most relevant evidence snippet from tool results
  const evidenceSnippets: string[] = []
  for (const result of toolResults) {
    try {
      const parsed = JSON.parse(result)
      // Look for app names, domains, or labels in the tool result
      if (parsed.topApps && Array.isArray(parsed.topApps)) {
        const apps = parsed.topApps.slice(0, 3).map((a: { appName?: string; app?: string }) => a.appName ?? a.app).filter(Boolean)
        if (apps.length > 0) evidenceSnippets.push(`apps: ${apps.join(', ')}`)
      }
      if (parsed.label || parsed.blockLabel) {
        evidenceSnippets.push(`block: ${parsed.label ?? parsed.blockLabel}`)
      }
      if (parsed.topDomains && Array.isArray(parsed.topDomains)) {
        const domains = parsed.topDomains.slice(0, 2).map((d: { domain?: string }) => d.domain).filter(Boolean)
        if (domains.length > 0) evidenceSnippets.push(`sites: ${domains.join(', ')}`)
      }
    } catch {
      // Not JSON — skip
    }
  }

  if (evidenceSnippets.length > 0) {
    const evidenceSummary = evidenceSnippets.slice(0, 2).join('; ')
    if (missing.length > 0) {
      return `Your captured data shows ${evidenceSummary} for that time range, but not ${missing.join(' or ')}. That's the closest signal Daylens has.`
    }
    return `Here's what Daylens captured: ${evidenceSummary}.`
  }

  if (missing.length > 0) {
    return `Daylens doesn't have a record of ${missing.join(' or ')} in the captured activity. The closest signals are app foreground time and window titles for that period.`
  }
  return `Here's what Daylens can see for that time range based on app sessions, website visits, and window titles.`
}
