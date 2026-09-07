// Debug probe: reproduce the exact production wrapped-narrative prompt for a
// real day, call the provider directly, and print the RAW model output plus a
// per-line validation report, so we can see why lines die (fall back).
//
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron \
//     --loader ./tests/support/ts-loader-real.mjs ./tests/wrapped-bench/debug.ts YYYY-MM-DD

import Anthropic from '@anthropic-ai/sdk'
import { stageReadOnlyCopyOfRealDb, cleanupRealDbCopy } from '../ai-behaviour/realDb'

async function main(): Promise<void> {
  const date = process.argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) ?? '2026-07-07'
  const dbCtx = await stageReadOnlyCopyOfRealDb()
  const { initDb, getDb } = await import('../../src/main/services/database')
  initDb()

  const { getApiKey, getSettings } = await import('../../src/main/services/settings')
  const key = (await getApiKey('anthropic')) ?? process.env.ANTHROPIC_API_KEY!
  const settings = getSettings()

  const { getTimelineDayPayload } = await import('../../src/main/services/workBlocks')
  const { buildDayWrapFacts } = await import('../../src/renderer/lib/dayWrapScenes')
  const { planDayWrapSlides } = await import('../../src/renderer/lib/wrapDeck')
  const { buildWrappedPrompts, validateWrappedNarrativeResponse, computeFactsHash } = await import('../../src/main/lib/wrappedNarrative')
  const { voiceDirective } = await import('../../src/shared/summaryVoice')
  const { userProfileDirective } = await import('../../src/shared/userProfile')

  const payload = getTimelineDayPayload(getDb(), date, null)
  const facts = buildDayWrapFacts(payload)
  const slides = planDayWrapSlides(facts).filter((s) => s.ask)
  const { systemPrompt, userMessage } = buildWrappedPrompts(facts)
  const tuned = [systemPrompt, userProfileDirective(settings), voiceDirective(settings.summaryVoice)].filter(Boolean).join('\n\n')

  const model = process.env.WRAPPED_DEBUG_MODEL ?? 'claude-sonnet-4-6'
  console.log(`\n=== ${date} · model ${model} · ${slides.length} slides asked ===`)
  console.log(`facts.quality=${facts.quality} active=${Math.round(facts.activeSeconds / 60)}m seed=${facts.seed}`)

  const anthropic = new Anthropic({ apiKey: key })
  const t0 = Date.now()
  const resp = await anthropic.messages.create({
    model, max_tokens: 4000, system: tuned,
    messages: [{ role: 'user', content: userMessage }],
  })
  const raw = resp.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('')
  console.log(`\n[timing] provider replied in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${resp.usage.output_tokens} out tokens`)
  console.log('\n=== RAW MODEL OUTPUT ===\n' + raw)

  const factsHash = computeFactsHash(facts)
  const validated = validateWrappedNarrativeResponse(raw, facts, factsHash)

  // Diagnose WHY any raw AI line would be rejected by the runtime guard, so the
  // fix lands on the prompt (or the guard) rather than a guess.
  const shared = await import('../../src/main/lib/wrapNarrativeShared')
  const guards = await import('../../src/renderer/lib/wrapDeck') // for spec fields (already have slides)

  function diagnose(spec: typeof slides[number], line: string, opts: { min: number; max: number; allowQ: boolean }): string[] {
    const reasons: string[] = []
    if (line.length < opts.min) reasons.push(`too short (${line.length} < ${opts.min})`)
    if (line.length > opts.max) reasons.push(`too long (${line.length} > ${opts.max})`)
    if (!shared.emojiUsageAllowed(line)) reasons.push('emoji not allowed (only one earned celebration emoji at end)')
    if (!opts.allowQ && /\?/.test(line)) reasons.push('contains a question mark')
    if (/[—–]/.test(line)) reasons.push('em/en dash')
    if (shared.BANNED_PHRASES.some((p) => line.toLowerCase().includes(p))) reasons.push(`banned phrase: ${shared.BANNED_PHRASES.find((p) => line.toLowerCase().includes(p))}`)
    if (shared.HOMEWORK_GUILT_PATTERNS.some((p) => p.test(line))) reasons.push(`homework/guilt word (e.g. drift/focus-score/pick-up/carry-over)`)
    if (/\b(I'?m not sure|couldn'?t|cannot determine|no data|n\/?a)\b/i.test(line)) reasons.push('uncertainty phrase')
    // Clock grounding: which tokens in the line are not in THIS slide's facts.
    const slideTimes = shared.clockTokensIn(`${spec.kicker} ${spec.factsNote} ${spec.stat?.sublabel ?? ''} ${spec.stat?.value ?? ''}`)
    const lineTimes = shared.clockTokensIn(line)
    const ungrounded = [...lineTimes].filter((t) => !slideTimes.has(t))
    if (ungrounded.length) reasons.push(`ungrounded clock time(s): ${ungrounded.join(', ')} (slide only allows: ${[...slideTimes].join(', ') || 'none'})`)
    // Percent grounding.
    const pcts = [...line.matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map((m) => Number(m[1]))
    const allowedPct = new Set<number>()
    if (spec.split) { allowedPct.add(spec.split.aPct); allowedPct.add(spec.split.bPct) }
    const badPct = pcts.filter((p) => !allowedPct.has(p))
    if (badPct.length) reasons.push(`ungrounded percent(s): ${badPct.join(', ')}`)
    return reasons
  }

  console.log('\n=== VALIDATION RESULT ===')
  let parsed: { lines?: Record<string, string>; question?: string; reflection?: string } = {}
  try { parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? raw) } catch { /* */ }
  console.log(validated ? `source: ${validated.source}` : 'validateWrappedNarrativeResponse returned NULL (opening died → whole deck fell back)')
  for (const s of slides) {
    const kept = validated?.lines[s.id]
    const rawLine = parsed.lines?.[s.id]
    if (kept) { console.log(`  KEPT ${s.id.padEnd(16)} ${JSON.stringify(kept)}`); continue }
    const why = rawLine ? diagnose(s, rawLine, { min: 18, max: 220, allowQ: false }) : ['model sent no line for this id']
    console.log(`  DIED ${s.id.padEnd(16)} ${JSON.stringify(rawLine ?? '')}`)
    console.log(`       ↳ ${why.join(' | ') || 'unknown (passed these checks — check the lead/opening gate)'}`)
  }
  // Question + reflection.
  const qSpec = slides.find((s) => s.id === 'question') ?? { id: 'question', kicker: '', factsNote: '', stat: undefined, split: undefined } as unknown as typeof slides[number]
  const rSpec = slides.find((s) => s.id === 'reflection') ?? qSpec
  console.log(`  question raw: ${JSON.stringify(parsed.question)}`)
  if (parsed.question) console.log(`       ↳ ${diagnose(qSpec, parsed.question, { min: 12, max: 180, allowQ: true }).join(' | ') || (validated?.question ? 'KEPT' : 'died — must END with "?" and pass guards')}`)
  console.log(`  reflection raw: ${JSON.stringify(parsed.reflection)}`)
  if (parsed.reflection) console.log(`       ↳ ${diagnose(rSpec, parsed.reflection, { min: 80, max: 650, allowQ: false }).join(' | ') || (validated?.reflection ? 'KEPT' : 'died')}`)

  cleanupRealDbCopy(dbCtx)
}

main().catch((e) => { console.error(e); process.exit(1) })
