// `daylens analyze <date> [--hint "…"] [--json]`
//
// The exact pipeline behind the app's Analyze button (REBUILD_TIMELINE_DAY):
// absence repair → deterministic merge → AI regroup → per-block relabel.
// Spends real model calls. Writes to the harness work DB only.

import type { HarnessContext } from './context'
import { c, emit } from './render'

export async function analyze(
  ctx: HarnessContext,
  date: string,
  opts: { json: boolean; hint?: string },
): Promise<void> {
  const { analyzeTimelineDay } = await import('../src/main/services/analyzeDay')
  const result = await analyzeTimelineDay(ctx.db, date, {
    userHint: opts.hint?.trim() || undefined,
    triggerSource: 'user',
    onProgress: (update) => {
      process.stderr.write(c('dim', `[analyze] ${JSON.stringify(update)}\n`))
    },
  })
  const summary = {
    changed: result.changed,
    merged: result.merged,
    mergedCount: result.mergedCount,
    relabeled: result.relabeled,
    attempted: result.attempted,
    failures: result.failures,
    blocks: result.payload.blocks.length,
  }
  emit(summary, opts.json, () => {
    console.log(c('bold', `Analyze · ${date}`))
    console.log(`  changed: ${summary.changed} · merged: ${summary.mergedCount} · relabeled: ${summary.relabeled}/${summary.attempted}`)
    if (summary.failures.length > 0) {
      console.log(c('red', `  failures: ${summary.failures.join(' | ')}`))
    }
    console.log(c('dim', `  Run \`daylens timeline ${date}\` to see the result.`))
  })
}
