// Ask-anything inside a wrap (and answering the wrap's own curious question).
//
// The user taps a slide and asks about that data point, or answers the question
// the wrap asked them; the answer comes back inline on the slide. Grounding is
// the same compact facts projection the wrap itself narrated from, plus the
// slide the user was looking at — the answer can reference exactly what the
// user can see, and nothing the app doesn't know.

import type { WrappedAskRequest, WrappedAskResult } from '@shared/types'
import { voiceDirective } from '@shared/summaryVoice'
import { userProfileDirective } from '@shared/userProfile'
import { INTERPRETATION_DIRECTIVES } from '@shared/activityDescription'
import { VOICE_SYSTEM_PROMPT } from '../ai/voiceContract'
import { getSettings } from './settings'
import { getDb } from './database'
import { getCurrentSession } from './tracking'
import { getTimelineDayPayload } from './workBlocks'
import { localDateString } from '../lib/localDate'
import { buildDayWrapFacts } from '../../renderer/lib/dayWrapScenes'
import { planDayWrapSlides, planPeriodWrapSlides } from '../../renderer/lib/wrapDeck'
import { compactDayFacts } from '../lib/wrappedNarrative'
import { resolveDayEnrichment } from './enrichmentResolve'
import { compactPeriodFacts } from '../lib/wrappedPeriodNarrative'
import { buildWrappedPeriodFacts } from './wrappedPeriodNarrative'
import { EMOJI_REGEX, EVIDENCE_HONESTY_DIRECTIVES, stripCodeFence } from '../lib/wrapNarrativeShared'
import {
  executeTextAIJob,
  type ResolvedProviderConfig,
  type AITextJobExecutionOptions,
  type ProviderTextResponse,
} from './aiOrchestration'

interface ProviderRunner {
  (
    config: ResolvedProviderConfig,
    systemPrompt: string,
    prior: Array<{ role: 'user' | 'assistant'; content: string }>,
    userMessage: string,
    options?: AITextJobExecutionOptions,
  ): Promise<ProviderTextResponse>
}

let providerRunner: ProviderRunner | null = null

export function registerWrappedQuestionProvider(runner: ProviderRunner): void {
  providerRunner = runner
}

const ASK_TIMEOUT_MS = 20_000
const MAX_QUESTION_CHARS = 500
const MAX_ANSWER_CHARS = 700

interface AskGrounding {
  factsJson: string
  /** The deck the user is looking at: kicker + true facts per slide, so the
   *  answer talks about exactly what the cards show (and their exact times). */
  deckOutline: string
}

function groundingFor(req: WrappedAskRequest): AskGrounding {
  if (req.cadence === 'day') {
    const db = getDb()
    const liveSession = req.periodKey === localDateString() ? getCurrentSession() : null
    const payload = getTimelineDayPayload(db, req.periodKey, liveSession)
    const facts = buildDayWrapFacts(payload)
    const enrichment = resolveDayEnrichment(db, req.periodKey)
    return {
      factsJson: JSON.stringify(compactDayFacts(facts, enrichment), null, 2),
      // Coverage rides into the outline so the answer can say honestly which
      // sources this day's wrap actually had.
      deckOutline: deckOutline(planDayWrapSlides(facts, {
        browser: payload.websites.length > 0,
        connectors: {
          calendar: Boolean(enrichment?.meetings),
          git: Boolean(enrichment?.shipped),
          focus: Boolean(enrichment?.focusSessions),
          notes: Boolean(enrichment?.meetingNotes),
        },
      })),
    }
  }
  const facts = buildWrappedPeriodFacts(req.cadence, req.periodKey)
  return {
    factsJson: JSON.stringify(compactPeriodFacts(facts), null, 2),
    deckOutline: deckOutline(planPeriodWrapSlides(facts)),
  }
}

function deckOutline(slides: ReturnType<typeof planDayWrapSlides>): string {
  return slides
    .filter((s) => s.kind !== 'finale')
    .map((s) => `- ${s.id} ("${s.kicker}"): ${s.factsNote}`)
    .join('\n')
}

export async function askWrappedQuestion(req: WrappedAskRequest): Promise<WrappedAskResult> {
  const question = req.question.trim().slice(0, MAX_QUESTION_CHARS)
  if (!question) return { answer: null, error: 'Empty question.' }
  if (!providerRunner) return { answer: null, error: 'No AI provider connected.' }

  let grounding: AskGrounding
  try {
    grounding = groundingFor(req)
  } catch (error) {
    console.warn('[ai] wrapped_question facts failed:', error)
    return { answer: null, error: 'Could not load the facts for that period.' }
  }

  const settings = getSettings()
  const systemPrompt = [
    VOICE_SYSTEM_PROMPT,
    'You are Daylens, talking to the user from inside their Wrapped recap. They tapped a slide and are asking about their own tracked time.',
    'Answer in one to three short sentences, in the second person, conversational, honest.',
    'Ground every claim in the facts JSON and the deck outline. Durations in the facts are pre-formatted; use them as written and never compute a new one. Never invent an app, site, project, or number.',
    'HOW TO READ TIMES. Every time in the facts is a local 12-hour clock string. "12am" is midnight, "12pm" is noon, "12:27pm" is early afternoon just after noon, never night. Copy times exactly as written; never shift an event to a different part of the day, never do clock arithmetic. If the user says a time is wrong, do not invent a corrected time; say what the tracked data shows, verbatim, and that they know their day best.',
    'If the facts cannot answer the question, say so plainly and say what Daylens does know. Never guess.',
    ...EVIDENCE_HONESTY_DIRECTIVES,
    ...INTERPRETATION_DIRECTIVES,
    'No advice or homework unless they explicitly ask for it. No grades, no focus percentages, no guilt.',
    'Never use an em dash. No emoji. No markdown. Plain text only.',
    userProfileDirective(settings),
    voiceDirective(settings.summaryVoice),
  ].filter(Boolean).join('\n\n')

  const userMessage = [
    `Facts for this ${req.cadence} (${req.periodKey}):`,
    grounding.factsJson,
    '',
    'The deck they are looking at (slide id, its heading, and its true facts):',
    grounding.deckOutline,
    '',
    `The slide they asked from: "${req.slideId}"${req.slideLine ? ` — it reads: "${req.slideLine}"` : ''}`,
    '',
    req.replyingTo
      ? `You had asked them: "${req.replyingTo}"\nThey answered: "${question}"\nRespond to their answer in context, like the friend who asked. One to three sentences.`
      : `Their question: "${question}"`,
  ].join('\n')

  try {
    const { text } = await withTimeout(
      executeTextAIJob(
        {
          jobType: 'wrapped_question',
          screen: req.cadence === 'day' ? 'timeline_day' : 'timeline_week',
          triggerSource: 'user',
          systemPrompt,
          userMessage,
        },
        providerRunner,
      ),
      ASK_TIMEOUT_MS,
      'wrapped_question timed out',
    )
    const answer = sanitizeAnswer(text)
    if (!answer) return { answer: null, error: 'The AI returned an unusable answer. Try again.' }
    return { answer, error: null }
  } catch (error) {
    console.warn('[ai] wrapped_question failed:', error)
    return { answer: null, error: error instanceof Error ? error.message : 'The question failed.' }
  }
}

function sanitizeAnswer(raw: string): string | null {
  let text = stripCodeFence(raw).trim()
  if (!text) return null
  // A model that returned JSON anyway: pull a plausible string out of it.
  if (/^\s*[{[]/.test(text)) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>
      const candidate = [parsed.answer, parsed.text, parsed.response].find((v) => typeof v === 'string')
      if (typeof candidate === 'string') text = candidate.trim()
      else return null
    } catch {
      return null
    }
  }
  text = text.replace(EMOJI_REGEX, '').replace(/[—–]/g, ', ').trim()
  if (!text) return null
  if (text.length > MAX_ANSWER_CHARS) text = `${text.slice(0, MAX_ANSWER_CHARS - 1).trimEnd()}…`
  return text
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}
