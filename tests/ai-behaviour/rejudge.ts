// Re-judge a previous behaviour run from its saved results + trace files,
// without re-running the 25 subject turns. Exists because a judge-side bug
// (prompt shape, token cap, model quirk) otherwise forces re-paying for the
// whole subject run just to get verdicts.
//
// Run with:
//   cross-env ELECTRON_RUN_AS_NODE=1 electron --loader ./tests/support/ts-loader-real.mjs \
//     ./tests/ai-behaviour/rejudge.ts .ai-behaviour/results-<provider>-<stamp>.json
//
// Writes results-rejudged-<stamp>.json next to the input.

import fs from 'node:fs'
import path from 'node:path'
import { judgeAnswer } from './judge'
import { summarizeTraceForJudge, summarizeArtifactsForJudge, artifactsFromTrace } from './evidence'
import type { ScenarioRecord } from './types'
import { renderGroundTruthForJudge } from './groundTruth'

interface SavedResult {
  scenario: ScenarioRecord
  answer: string
  answerKind: string | null
  sourceKind: string | null
  durationMs: number
  judge: unknown
  artifactsEmitted: number
  artifacts?: Array<{ title: string; format: string; path: string; kind: string }>
  followUps?: string[]
  tracePath?: string
  error?: string
}

async function main(): Promise<void> {
  const resultsPath = process.argv[2]
  if (!resultsPath || !fs.existsSync(resultsPath)) {
    console.error('usage: rejudge.ts <path to results-*.json>')
    process.exit(2)
  }
  const { getApiKey } = await import('../../src/main/services/settings')
  const apiKey = await getApiKey('anthropic')
  if (!apiKey) {
    console.error('[fatal] No Anthropic API key in keytar (the judge runs on Anthropic).')
    process.exit(2)
  }

  const doc = JSON.parse(fs.readFileSync(resultsPath, 'utf8')) as {
    provider: string
    groundTruth: Parameters<typeof renderGroundTruthForJudge>[0]
    results: SavedResult[]
  }
  const groundTruthBlob = renderGroundTruthForJudge(doc.groundTruth)

  const tally = { good: 0, bad: 0, worse: 0, error: 0 }
  const rejudged: SavedResult[] = []
  for (const saved of doc.results) {
    if (saved.error) {
      tally.error += 1
      rejudged.push(saved)
      console.log(`${saved.scenario.id}: ERROR (subject turn failed: ${saved.error})`)
      continue
    }
    const traceSummary = saved.tracePath ? summarizeTraceForJudge(saved.tracePath) : undefined
    // Prefer the persisted artifact list; older results lack it, so fall back
    // to reconstructing from the trace's artifact-tool results.
    const artifacts = saved.artifacts ?? (saved.tracePath ? artifactsFromTrace(saved.tracePath) : [])
    const artifactSummary = summarizeArtifactsForJudge(artifacts)
    const evidence = [traceSummary, artifactSummary].filter(Boolean).join('\n\n') || undefined
    const verdict = await judgeAnswer(saved.scenario, saved.answer, groundTruthBlob, apiKey, evidence, saved.followUps ?? [])
    tally[verdict.grade] += 1
    rejudged.push({ ...saved, judge: verdict })
    console.log(`${saved.scenario.id}: ${verdict.grade.toUpperCase()} — ${verdict.reason}`)
  }

  console.log('\n=== Re-judge summary ===')
  console.log(`  good: ${tally.good}  bad: ${tally.bad}  worse: ${tally.worse}  error: ${tally.error}`)

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outPath = path.join(path.dirname(resultsPath), `results-rejudged-${stamp}.json`)
  fs.writeFileSync(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    rejudgedFrom: resultsPath,
    provider: doc.provider,
    tally,
    groundTruth: doc.groundTruth,
    results: rejudged,
  }, null, 2))
  console.log(`Wrote ${outPath}`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err))
  process.exit(1)
})
