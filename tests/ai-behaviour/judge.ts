// LLM judge — second Claude call that grades the assistant's answer against
// a gold_answer_shape (primary) and a rubric (secondary), with the full tool
// trace as authoritative evidence. Returns a structured verdict, never crashes
// the run on a soft fail; treats network errors as `error`.

import Anthropic from '@anthropic-ai/sdk'
import type { ScenarioRecord } from './types'

export interface JudgeVerdict {
  scenarioId: string
  grade: 'good' | 'bad' | 'worse' | 'error'
  reason: string
  citationsFound: boolean
  hallucinationDetected: boolean
  voiceOk: boolean
  matchesGoldShape: boolean
  // Q3/Q4: follow-up chips are grounded + useful, and never template a
  // meta-entity (provider/model name). True when there are no follow-ups.
  followUpsOk: boolean
  rawJudgeOutput: string
}

export const JUDGE_SYSTEM = `You are a strict QA judge for the Daylens activity-tracker AI.

You will be given:
- A user question
- A "gold_answer_shape" describing what a colleague who had been watching the user work all week would say in 2-4 sentences when asked the same question — this is the PRIMARY grading bar
- The assistant's verbatim answer
- A structured rubric of must-haves (secondary signal — useful guardrails)
- A compact summary of the relevant DB ground truth (what we know exists)
- The full tool-call trace: every tool the model called, with its INPUT and OUTPUT, in order

CRITICAL — what counts as evidence:
The TRACE is authoritative. If a number, block label, app name, page title, or domain appears in any tool OUTPUT, the model was entitled to cite it — that is NOT a hallucination, even if the ground-truth summary doesn't list it (ground truth is a compact summary and may omit things the tools returned). Treat ground truth as supplementary. A claim is a hallucination ONLY if the cited value appears in neither the trace nor ground truth.
- Tool outputs carry epoch-millisecond timestamps; each tool line is followed by a LOCAL_TIMES line rendering every epoch in that output as "YYYY-MM-DD HH:MM". A clock time or time range the answer cites is grounded if it matches LOCAL_TIMES (start and end of a range each matching counts as a grounded range).
- A tool output ending in "…(truncated …)" was cut for YOUR prompt only — the model saw the full output. Do not call a claim fabricated solely because it is not visible in a truncated output; flag it only if it CONTRADICTS visible evidence or has no plausible source anywhere in the trace.
- The CONTEXT_PACKET section (when present) was part of the model's prompt — statements quoted from it are grounded.

CRITICAL — what makes an answer good:
The bar is NOT "the answer matches the DB." The bar is: would a colleague who watched the user work this week answer it the same way? A factually correct answer that fails to reveal understanding is a FAIL. "3h in Cursor" when the truth is "3h finishing the chat refactor in Cursor" — FAIL. App totals as the headline — FAIL. The answer must name the ACTIVITY, not just the app.

Grade the answer on these axes, in priority order:

1. **Matches the gold_answer_shape** — does the answer reveal the same understanding a colleague would? Does it name the activity, connect the dots, pinpoint the moment, surface the closest signal? This is the primary bar.

2. **Activity, not app** — the answer must name what the user was DOING (refactor, debug, course reading, meeting), not just which apps were open. App totals are evidence, never the headline.

3. **Minute-level precision** — if the user asked about a moment, day, or block, time ranges and durations must match the tool output to the minute. "09:09–10:08" if that's what the tool returned. Inventing sub-block durations not in tool output is a fail.

4. **Time awareness** — future-moment questions ("today at 4pm" when it's 11:37) must acknowledge the moment hasn't happened. Pre-tracking dates must name the tracking start date and offer the closest available data. Never bare-refuse.

5. **Faithfulness vs trace** — every concrete claim (number, label, domain, person, file, time range) must appear in the tool trace or ground truth. Quoting a block label that appears in tool output verbatim is grounded, even if the label looks unusual.

6. **Voice** — banned phrases include: "great work", "you crushed it", "let's dive in", "dive into", "elevate", "seamless", "navigate the landscape", "in today's fast-paced world", "harness the power", "you've got this", "fascinating perspective". Exclamation marks fail. Motivational filler fails. Generic openers fail. Bare refusals ("I don't know", "I can't see that") fail — surface the closest captured signal instead.

7. **Follow-up suggestions** (Q3/Q4) — if follow-up chips are shown, each must be a sensible next question grounded in the answer's real content. They must NEVER template a meta-entity into a canned question — e.g. after "what model are you?", chips like "How long on Google Gemini?" or "Which files appeared in Google Gemini?" are nonsense and a FAIL. No follow-ups at all is acceptable (follow_ups_ok = true). Dumb/templated follow-ups → follow_ups_ok = false and cap the grade at "bad" (or "worse" if they reference a meta-entity as a data entity).

The rubric flags are secondary signal — useful guardrails for specific failure modes, but they do not override the gold_answer_shape. An answer can pass every rubric flag and still be a fail if it doesn't reveal understanding the way the gold shape describes.

Output STRICT JSON with this exact shape, no markdown, no code fence:

{"grade":"good"|"bad"|"worse","reason":"one sentence pointing at the worst flaw, or what made it good","citations_found":true|false,"hallucination_detected":true|false,"voice_ok":true|false,"matches_gold_shape":true|false,"follow_ups_ok":true|false}

- good = matches the gold_answer_shape, names activity not just app, hits minute precision, clean voice, cited evidence
- bad = partial: shape mostly right but vague; voice slips; app-totals leak in; paraphrased timestamps; no outright fabrication
- worse = misses the shape entirely; fabrication (value appears in neither trace nor ground truth); bare refusal when data exists; broken output; motivational filler`

export async function judgeAnswer(
  scenario: ScenarioRecord,
  assistantText: string,
  groundTruthSummary: string,
  apiKey: string,
  traceSummary?: string,
  followUps: string[] = [],
): Promise<JudgeVerdict> {
  const userPrompt = [
    `Question: ${scenario.question}`,
    '',
    'Gold answer shape (PRIMARY bar — what a colleague who watched the user work would say):',
    scenario.gold_answer_shape?.trim() || '(no gold shape provided — grade against the rubric only)',
    '',
    'Rubric flags (secondary — specific guardrails the engineer wants enforced):',
    JSON.stringify(scenario.rubric, null, 2),
    '',
    'Compact DB ground-truth summary:',
    groundTruthSummary,
    '',
    traceSummary ? 'Tool-call trace (what the model actually saw — authoritative):' : null,
    traceSummary ?? null,
    traceSummary ? '' : null,
    'Assistant answer (verbatim):',
    assistantText,
    '',
    'Follow-up suggestion chips shown after this answer (grade per axis 7):',
    followUps.length ? followUps.map((f) => `- ${f}`).join('\n') : '(none shown)',
    '',
    'Return the JSON verdict only.',
  ].filter((line): line is string => line !== null).join('\n')

  try {
    const client = new Anthropic({ apiKey })
    // claude-sonnet-4-6 rejects assistant prefill, so JSON-first is enforced
    // by instruction instead; the raised token cap stops the mid-thought
    // truncation that used to grade as "error", and one retry mops up a
    // response that still fails to parse.
    const callJudge = async (): Promise<string> => {
      const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1200,
        system: JUDGE_SYSTEM,
        messages: [
          { role: 'user', content: `${userPrompt}\n\nYour reply MUST start with "{" — the JSON verdict itself, no preamble, no reasoning before it.` },
        ],
      })
      return response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim()
    }

    const extractJson = (raw: string): string | null => {
      const match = raw.match(/\{[\s\S]*\}/)
      if (!match) return null
      try {
        JSON.parse(match[0])
        return match[0]
      } catch {
        return null
      }
    }

    let raw = await callJudge()
    let json = extractJson(raw)
    if (!json) {
      raw = await callJudge()
      json = extractJson(raw)
    }
    if (!json) {
      return {
        scenarioId: scenario.id,
        grade: 'error',
        reason: `judge returned non-JSON after retry: ${raw.slice(0, 120)}`,
        citationsFound: false,
        hallucinationDetected: false,
        voiceOk: false,
        matchesGoldShape: false,
        followUpsOk: false,
        rawJudgeOutput: raw,
      }
    }

    const parsed = JSON.parse(json) as {
      grade?: 'good' | 'bad' | 'worse'
      reason?: string
      citations_found?: boolean
      hallucination_detected?: boolean
      voice_ok?: boolean
      matches_gold_shape?: boolean
      follow_ups_ok?: boolean
    }

    return {
      scenarioId: scenario.id,
      grade: parsed.grade ?? 'error',
      reason: parsed.reason ?? '(no reason given)',
      citationsFound: Boolean(parsed.citations_found),
      hallucinationDetected: Boolean(parsed.hallucination_detected),
      voiceOk: Boolean(parsed.voice_ok),
      matchesGoldShape: Boolean(parsed.matches_gold_shape),
      // Absent → treat as ok (no follow-ups is acceptable).
      followUpsOk: parsed.follow_ups_ok ?? true,
      rawJudgeOutput: raw,
    }
  } catch (error) {
    return {
      scenarioId: scenario.id,
      grade: 'error',
      reason: error instanceof Error ? error.message : String(error),
      citationsFound: false,
      hallucinationDetected: false,
      voiceOk: false,
      matchesGoldShape: false,
      followUpsOk: false,
      rawJudgeOutput: '',
    }
  }
}

// Local helper type re-exports so the runner only needs to import one module.
export type { ScenarioRubric, ScenarioRecord } from './types'
