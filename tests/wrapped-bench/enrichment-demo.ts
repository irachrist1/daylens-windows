// Enrichment demo — shows the ACTUAL slide generation for one real day, with
// git/calendar enrichment flowing into the prompt. Not a test, not the
// benchmark: it generates ONE real deck and prints it so a human can read the
// actual lines and confirm enrichment is being narrated.
//
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron \
//     --loader ./tests/support/ts-loader-real.mjs ./tests/wrapped-bench/enrichment-demo.ts [YYYY-MM-DD]

import { setupBench } from './harness'

async function main(): Promise<void> {
  const date = process.argv.slice(2).find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) ?? '2026-07-09'
  const ctx = await setupBench()

  const { getDb } = await import('../../src/main/services/database')
  const { collectExternalSignals } = await import('../../src/main/services/externalSignals')
  const { resolveDayEnrichment } = await import('../../src/main/services/enrichmentResolve')
  const { getTimelineDayPayload } = await import('../../src/main/services/workBlocks')
  const { buildDayWrapFacts } = await import('../../src/renderer/lib/dayWrapScenes')
  const { compactDayFacts } = await import('../../src/main/lib/wrappedNarrative')
  const { getWrappedNarrative } = await import('../../src/main/services/wrappedNarrative')

  try {
    console.log(`\n=== Wrapped enrichment demo · ${date} ===\n`)

    // 1. Collect fresh external signals (git scans repos on disk; calendar via
    //    EventKit / Outlook). Force so we re-read even if a stale row exists.
    process.stdout.write('[1] collecting external signals (git + calendar + focus)…\n')
    const fired = await collectExternalSignals(date, { force: true })
    console.log(`    connectors that produced a signal: [${fired.join(', ') || 'none'}]`)

    // 2. Resolve what the wrap WRITER will see.
    const enrichment = resolveDayEnrichment(getDb(), date)
    console.log('\n[2] resolved enrichment (what the prompt receives):')
    console.log(JSON.stringify(enrichment, null, 2))

    // 3. Show the enrichment block inside the compact facts JSON the model gets.
    const payload = getTimelineDayPayload(getDb(), date, null)
    const facts = buildDayWrapFacts(payload)
    const compact = compactDayFacts(facts, enrichment) as Record<string, unknown>
    console.log('\n[3] enrichment keys present in compact facts:', {
      shipped: 'shipped' in compact,
      meetings: 'meetings' in compact,
      focusSessions: 'focusSessions' in compact,
    })

    // 4. Generate the real deck through the production path and print each line.
    process.stdout.write('\n[4] generating the real deck (one provider call)…\n')
    const narrative = await getWrappedNarrative(payload, { force: true, triggerSource: 'user' })
    console.log(`    source: ${narrative.source}\n`)
    console.log('--- LEAD ---')
    console.log(`  ${narrative.lead}\n`)
    console.log('--- SLIDE LINES ---')
    for (const [id, line] of Object.entries(narrative.lines ?? {})) {
      if (line) console.log(`  [${id}]\n    ${line}\n`)
    }
    console.log('--- QUESTION ---')
    console.log(`  ${narrative.question ?? '(none)'}\n`)
    console.log('--- REFLECTION ---')
    console.log(`  ${narrative.reflection ?? '(none)'}\n`)
  } finally {
    ctx.cleanup()
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
