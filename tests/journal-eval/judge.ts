// Shape judge: does the story Daylens tells match the day the person lived?
// One Anthropic call per day; harsh by instruction. Only used with --judge.

import Anthropic from '@anthropic-ai/sdk'
import type { EvalDay } from './schema'
import type { ObservedDay } from './score'

export const SHAPE_JUDGE_SYSTEM = `You grade a day-summary product called Daylens. You are handed:
1. GROUND TRUTH — what the person who lived the day says actually happened (from their private journal or verifiable records). It may be partial; the person does not journal everything.
2. DAYLENS OUTPUT — the timeline blocks and narrative the product showed them.
3. DATA CAVEATS — known capture outages. Never punish Daylens for hours it provably could not observe.

Grade how well the OUTPUT captures the SHAPE of the real day, 0–10, harshly:

- 9–10: reads like a sharp colleague's recap. Right work named as the headline, interleavings acknowledged, gaps honest, arc matches.
- 7–8: right work and arc, but misses an important thread or flattens real messiness.
- 5–6: partially right; the main work is findable but the story misleads somewhere (invented smoothness, wrong emphasis, background noise promoted).
- 3–4: names surfaces instead of work, or the day's actual core is a footnote.
- 0–2: actively wrong: fabricated continuity, wrong primary activity, off-computer time narrated as work.

Automatic caps:
- A window title or tool surface ("Cursor Agents", "New chat", a chat panel) treated as THE work: cap at 4.
- Claimed continuity ("unbroken", "no detours") across a ground-truth interruption or gap: cap at 4.
- Background media (an idle tab) labeled as the activity: cap at 3.
- The day's stated core work absent from the story: cap at 5.

Output STRICT JSON, no markdown fence. Keep reasoning to AT MOST 3 sentences and violations to AT MOST 5 short items — terse and specific beats exhaustive:
{"score": <0-10>, "reasoning": "<max 3 sentences: worst failure first, then what it got right>", "violations": ["<short specific violation>", ...]}`

export interface ShapeVerdict {
  score: number
  reasoning: string
  violations: string[]
}

export async function judgeDayShape(
  apiKey: string,
  day: EvalDay,
  observed: ObservedDay,
  timelineRendering: string,
): Promise<ShapeVerdict> {
  const client = new Anthropic({ apiKey })
  const groundTruth = [
    `Date: ${day.date}`,
    `Summary: ${day.summary}`,
    day.shape?.length
      ? `Shape:\n${day.shape.map((s) => `  - ${[s.from && `from ${s.from}`, s.until && `until ${s.until}`].filter(Boolean).join(' ')}: ${s.desc}`).join('\n')}`
      : null,
    day.gaps?.length
      ? `Off-computer gaps:\n${day.gaps.map((g) => `  - ${g.from}–${g.to}${g.reason ? ` (${g.reason})` : ''}`).join('\n')}`
      : null,
    `Primary work: ${day.primaryWork.map((w) => w.name).join('; ')}`,
  ].filter(Boolean).join('\n')

  const output = [
    '=== TIMELINE (as rendered to the user) ===',
    timelineRendering,
    '',
    '=== WRAPPED NARRATIVE ===',
    observed.wrappedLead ? `Lead: ${observed.wrappedLead}` : '(no lead)',
    ...observed.wrappedLines.map((line) => `- ${line}`),
  ].join('\n')

  const response = await client.messages.create({
    model: process.env.DAYLENS_EVAL_JUDGE_MODEL ?? 'claude-sonnet-5',
    max_tokens: 2000,
    system: SHAPE_JUDGE_SYSTEM,
    messages: [{
      role: 'user',
      content: `GROUND TRUTH:\n${groundTruth}\n\nDATA CAVEATS: ${day.notes ?? 'none'}\n\nDAYLENS OUTPUT:\n${output}`,
    }],
  })
  const text = response.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('')
  const jsonStart = text.indexOf('{')
  const parsed = JSON.parse(text.slice(jsonStart)) as ShapeVerdict
  return {
    score: Math.max(0, Math.min(10, Number(parsed.score))),
    reasoning: String(parsed.reasoning ?? ''),
    violations: Array.isArray(parsed.violations) ? parsed.violations.map(String) : [],
  }
}
