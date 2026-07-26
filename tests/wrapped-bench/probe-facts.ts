// One-off facts probe (not a test): stage the real DB, print DayWrapFacts
// surfaces for a date. Usage: --loader ts-loader-real.mjs probe-facts.ts DATE
import { stageReadOnlyCopyOfRealDb, cleanupRealDbCopy } from '../ai-behaviour/realDb'
async function main(): Promise<void> {
  const date = process.argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) ?? '2026-07-20'
  const dbCtx = await stageReadOnlyCopyOfRealDb()
  const { initDb, getDb } = await import('../../src/main/services/database')
  initDb()
  const { getTimelineDayPayload } = await import('../../src/main/services/workBlocks')
  const { buildDayWrapFacts } = await import('../../src/renderer/lib/dayWrapScenes')
  const payload = getTimelineDayPayload(getDb(), date, null)
  const facts = buildDayWrapFacts(payload)
  console.log('topLeisure:', JSON.stringify(facts.topLeisure))
  console.log('story:', JSON.stringify(facts.dayStory.map((s) => ({ part: s.part, items: s.items, aside: s.aside }))))
  console.log('appSites:', JSON.stringify(facts.appSites.map((s) => `${s.name}:${s.seconds}:${s.kind}`)))
  console.log('activities:', JSON.stringify(facts.workActivities.map((a) => `${a.name}:${a.seconds}`)))
  cleanupRealDbCopy(dbCtx)
}
main()
