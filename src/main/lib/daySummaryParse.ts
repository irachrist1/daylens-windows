// Reading a recap out of whatever the model actually returned.
//
// The contract asks for JSON with one "summary" key, but a model that answers
// in plain prose has still answered: degrading a perfectly good paragraph to
// the factual fallback because it lacked braces would be throwing away the
// thing the person waited for. So: JSON first, a salvaged "summary" field from
// truncated JSON second, and bare prose accepted as itself.
import type { AIDaySummaryResult } from '@shared/types'

function unwrapCodeFence(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  return fenced?.[1]?.trim() ?? raw.trim()
}

// Some providers hand back the object as a JSON string inside the JSON.
function parseMaybeNestedJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed || !/^[{[]/.test(trimmed)) return value
  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}

export function parseDaySummaryResultText(raw: string): AIDaySummaryResult | null {
  const normalized = unwrapCodeFence(raw)
  if (!normalized) return null

  try {
    const parsed = parseMaybeNestedJson(JSON.parse(normalized)) as Partial<AIDaySummaryResult>
    if (!parsed || typeof parsed !== 'object') return null
    if (typeof parsed.summary !== 'string' || !parsed.summary.trim()) return null
    return { summary: parsed.summary.trim() }
  } catch {
    if (/^\s*[{[]/.test(normalized) || /"summary"\s*:/.test(normalized)) {
      // Truncated or malformed JSON. A complete "summary" string field is
      // still a usable recap — salvage it rather than degrading to facts.
      const summaryField = normalized.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/)
      if (summaryField) {
        try {
          const summary = (JSON.parse(`"${summaryField[1]}"`) as string).trim()
          if (summary) return { summary }
        } catch { /* fall through to null */ }
      }
      return null
    }
    return { summary: normalized }
  }
}
