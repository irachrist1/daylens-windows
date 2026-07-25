// `daylens wrapped <date> [--regen] [--facts] [--json]`
//
// The same pipeline the Wrapped overlay uses: DayTimelinePayload →
// buildDayWrapFacts → getWrappedNarrative, rendered against the deterministic
// slide plan (planDayWrapSlides) exactly like the deck component does.
// Importing jobs/aiService registers the real provider runner (module side
// effect, same as production startup), so --regen spends a real model call
// exactly like clicking Regenerate in the app.

import type { HarnessContext } from './context'
import { c, emit } from './render'

export async function wrapped(
  ctx: HarnessContext,
  date: string,
  opts: { json: boolean; regen: boolean; facts: boolean },
): Promise<void> {
  const { getTimelineDayPayload } = await import('../src/main/services/workBlocks')
  const payload = getTimelineDayPayload(ctx.db, date, null, { materialize: false })
  const { buildDayWrapFacts } = await import('../src/renderer/lib/dayWrapScenes')
  const facts = buildDayWrapFacts(payload)

  if (opts.facts) {
    emit(facts, true, () => {})
    return
  }

  // Side effect: registers wrapped narrative providers, same as app startup.
  await import('../src/main/jobs/aiService')
  const { getWrappedNarrative } = await import('../src/main/services/wrappedNarrative')
  const narrative = await getWrappedNarrative(payload, {
    triggerSource: 'user',
    force: opts.regen,
    onStale: opts.regen ? 'regenerate' : 'reconcile',
  })

  const { planDayWrapSlides } = await import('../src/renderer/lib/wrapDeck')
  const slides = planDayWrapSlides(facts)

  emit({ narrative, slides }, opts.json, () => {
    console.log(c('bold', `Wrapped · ${date}`))
    console.log(c('dim', `source: ${narrative.source}`))
    console.log('')
    console.log(c('magenta', narrative.lead))
    console.log('')
    for (const slide of slides) {
      const line = narrative.lines[slide.id] ?? null
      console.log(c('cyan', `── ${slide.id} ${'─'.repeat(Math.max(1, 44 - slide.id.length))}`))
      if (slide.kicker) console.log(c('gray', slide.kicker))
      console.log(line ?? c('dim', `(fallback) ${slide.fallbackLine}`))
      console.log('')
    }
    if (narrative.question) console.log(`${c('bold', 'Question:')} ${narrative.question}`)
    if (narrative.reflection) console.log(`${c('bold', 'Reflection:')} ${narrative.reflection}`)
  })
}
