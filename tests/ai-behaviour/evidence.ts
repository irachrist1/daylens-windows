// Evidence summarizers for the LLM judge — shared between the live harness
// (run.ts) and re-judge passes over a previous run's saved answers + traces,
// so a judge-side bug never forces re-paying for the subject turns.

import fs from 'node:fs'

// Tool outputs carry epoch-ms numbers; the model quotes them as local clock
// times. Render every epoch-shaped number so the judge can verify a cited
// "16:01" instead of flagging it as fabricated. Mirrors the grounding
// verifier's evidenceWithFormattedTimes in chatAgent.ts.
function localTimesLine(raw: string): string | undefined {
  const times = new Set<string>()
  const numberPattern = /\b1[5-9]\d{11}\b|\b2[0-2]\d{11}\b/g
  let match: RegExpExecArray | null
  while ((match = numberPattern.exec(raw)) !== null && times.size < 120) {
    const date = new Date(Number(match[0]))
    if (Number.isNaN(date.getTime())) continue
    const hh = String(date.getHours()).padStart(2, '0')
    const mm = String(date.getMinutes()).padStart(2, '0')
    const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    times.add(`${day} ${hh}:${mm}`)
  }
  if (times.size === 0) return undefined
  return `LOCAL_TIMES (epoch numbers above, rendered): ${[...times].join(', ')}`
}

export interface ArtifactForJudge {
  title: string
  format: string
  path: string
  kind: string
}

// Real artifacts the turn emitted, so the judge can grade "must_produce_artifact"
// scenarios against what was actually written to disk instead of guessing from
// the chat text (three scenarios were failed for "no artifact" while 1-2 files
// existed). Markdown gets a content excerpt; tabular formats get metadata.
export function summarizeArtifactsForJudge(artifacts: ArtifactForJudge[]): string | undefined {
  if (artifacts.length === 0) return undefined
  const lines = ['ARTIFACTS EMITTED (real files this turn wrote — an artifact listed here WAS produced):']
  for (const artifact of artifacts) {
    lines.push(`- "${artifact.title}" (${artifact.kind}, ${artifact.format})`)
    if (artifact.format === 'markdown') {
      try {
        const content = fs.readFileSync(artifact.path, 'utf8')
        const excerpt = content.length > 1500 ? `${content.slice(0, 1500)}…(truncated)` : content
        lines.push(`  content excerpt:\n${excerpt.split('\n').map((l) => `  | ${l}`).join('\n')}`)
      } catch {
        lines.push('  (content unreadable)')
      }
    }
  }
  return lines.join('\n')
}

// Reconstruct the turn's artifacts from its trace when the live artifact list
// is gone (re-judging a saved run): the artifact-producing tools return the
// saved path and title in their tool_result output.
export function artifactsFromTrace(tracePath: string): ArtifactForJudge[] {
  let trace: { events?: Array<Record<string, unknown>> }
  try {
    trace = JSON.parse(fs.readFileSync(tracePath, 'utf8')) as { events?: Array<Record<string, unknown>> }
  } catch {
    return []
  }
  const artifacts: ArtifactForJudge[] = []
  for (const event of trace.events ?? []) {
    if (event.kind !== 'tool_result') continue
    const name = event.name as string
    if (name !== 'create_artifact' && name !== 'export_week_excel') continue
    const output = (event.output ?? {}) as Record<string, unknown>
    if (output.found !== true || typeof output.savedTo !== 'string') continue
    const input = (event.input ?? {}) as Record<string, unknown>
    const format = name === 'export_week_excel' ? 'xlsx' : String(input.format ?? 'unknown')
    artifacts.push({
      title: String(output.title ?? input.title ?? output.filename ?? 'export'),
      format,
      path: output.savedTo,
      kind: format === 'markdown' ? 'report' : 'export',
    })
  }
  return artifacts
}

// Read the per-scenario trace JSON the trace recorder writes during
// sendMessage, and produce a compact text summary the judge can use as
// authoritative evidence. The judge needs to see every tool input/output
// so it does not flag real block labels as hallucinations.
export function summarizeTraceForJudge(tracePath: string): string | undefined {
  if (!fs.existsSync(tracePath)) return undefined
  let raw: string
  try {
    raw = fs.readFileSync(tracePath, 'utf8')
  } catch {
    return undefined
  }
  let trace: { events?: Array<Record<string, unknown>> }
  try {
    trace = JSON.parse(raw) as { events?: Array<Record<string, unknown>> }
  } catch {
    return undefined
  }
  const events = trace.events ?? []
  const lines: string[] = []
  for (const event of events) {
    const kind = event.kind as string | undefined
    if (kind === 'context_packet') {
      // The rendered packet was IN the model's prompt: any fact quoted from it
      // is grounded evidence, same as a tool output.
      const rendered = ((event.rendered as string) ?? '').trim()
      const preview = rendered.length > 3500 ? `${rendered.slice(0, 3500)}…(truncated)` : rendered
      lines.push(`CONTEXT_PACKET (authoritative evidence — this was in the model's prompt; facts quoted from it are grounded):\n${preview}`)
    } else if (kind === 'tool_result') {
      const name = event.name as string
      const input = JSON.stringify(event.input ?? {})
      // Truncate output JSON to keep the judge prompt under control, but
      // preserve enough that block labels, durations, and domain strings are
      // visible. 1800 chars was far too small: a week summary is ~8k, a day
      // overview ~15k, and everything past the cut read as fabrication.
      const outputStr = JSON.stringify(event.output ?? null)
      // A chunk table's interval coverage IS the graded object — a judge that
      // can't see the tail rows grades honest rows as fabrication.
      const outputCap = outputStr.includes('"chunks"') ? 24000 : 6000
      const outputPreview = outputStr.length > outputCap ? `${outputStr.slice(0, outputCap)}…(truncated — the model saw the FULL output; claims may be grounded in the truncated part)` : outputStr
      lines.push(`TOOL ${name}(${input}) → ${outputPreview}`)
      // Rendered from the FULL output, so times the model quoted from beyond
      // the preview still verify.
      const times = localTimesLine(outputStr)
      if (times) lines.push(times)
    } else if (kind === 'router') {
      lines.push(`ROUTER matched=${event.matched} reason=${event.reason}`)
    } else if (kind === 'router_decision') {
      // The deterministic router produced this verbatim structured answer.
      // The prose-pass rewrites it into natural language. Anything quoted
      // from this block — durations, app names, block labels — is grounded.
      const sa = ((event.structuredAnswer as string) ?? '').trim()
      const preview = sa.length > 1500 ? `${sa.slice(0, 1500)}…` : sa
      lines.push(`ROUTER_DECISION routedKind=${event.routedKind} hasTimeWindow=${event.hasTimeWindow}\nSTRUCTURED_ANSWER (authoritative — treat as tool output for grounding):\n${preview}`)
    } else if (kind === 'prose_pass') {
      // Shows the prose-pass rewrite and whether it was rejected (timestamp
      // drift, empty, error) — in which case the structured answer above
      // was returned to the user verbatim.
      const out = ((event.output as string) ?? '').trim()
      const fallback = event.fallback as string | undefined
      const preview = out.length > 600 ? `${out.slice(0, 600)}…` : out
      lines.push(`PROSE_PASS${fallback ? ` fallback=${fallback}` : ''} → ${preview}`)
    } else if (kind === 'turn') {
      const text = ((event.text as string) ?? '').trim()
      if (text) {
        const preview = text.length > 300 ? `${text.slice(0, 300)}…` : text
        lines.push(`MODEL_TURN_TEXT: ${preview}`)
      }
    }
  }
  if (lines.length === 0) return undefined
  // Cap the whole summary so the judge call stays within token budget. Sized
  // for a multi-day scenario (five ~15k day overviews at 6k previews each plus
  // the packet) — an under-informed judge fails good answers as fabrication.
  const joined = lines.join('\n')
  if (joined.length > 45000) {
    return `${joined.slice(0, 45000)}\n(trace truncated for judge)`
  }
  return joined
}
