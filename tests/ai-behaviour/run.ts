// Behavioural harness — runs real scenarios against the real Daylens
// pipeline using a read-only copy of the user's actual DB plus the Anthropic
// key from keytar. Each scenario is graded by a second Claude call and
// printed live in the terminal so you can see, scenario by scenario:
//
//   - the question
//   - the assistant's verbatim answer
//   - the router/source path taken (deterministic vs LLM)
//   - the judge's verdict and reason
//
// Final results are written to .ai-behaviour/results-<stamp>.json for diff.
//
// Run with:
//   npm run test:behaviour
//
// This must run inside Electron (ELECTRON_RUN_AS_NODE=1) so getApiKey() can
// reach keytar and so getDb() can talk to better-sqlite3.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

const HERE = path.dirname(fileURLToPath(import.meta.url))
import { stageReadOnlyCopyOfRealDb, cleanupRealDbCopy } from './realDb'
import type { ScenarioRecord } from './types'
import type { AIProviderMode } from '@shared/types'

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
}

function color(c: keyof typeof ANSI, s: string): string {
  return process.stdout.isTTY ? `${ANSI[c]}${s}${ANSI.reset}` : s
}

// Real artifacts the turn emitted, so the judge can grade "must_produce_artifact"
// scenarios against what was actually written to disk instead of guessing from
// the chat text (three scenarios were failed for "no artifact" while 1-2 files
// existed). Markdown gets a content excerpt; tabular formats get metadata.
function summarizeArtifactsForJudge(
  artifacts: Array<{ title: string; format: string; path: string; kind: string }>,
): string | undefined {
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

// Read the per-scenario trace JSON the trace recorder writes during
// sendMessage, and produce a compact text summary the judge can use as
// authoritative evidence. The judge needs to see every tool input/output
// so it does not flag real block labels as hallucinations.
function summarizeTraceForJudge(tracePath: string): string | undefined {
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
      // preserve enough that block labels, durations, and domain strings
      // are visible.
      const outputStr = JSON.stringify(event.output ?? null)
      const outputPreview = outputStr.length > 1800 ? `${outputStr.slice(0, 1800)}…(truncated)` : outputStr
      lines.push(`TOOL ${name}(${input}) → ${outputPreview}`)
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
  // Cap the whole summary so the judge call stays within token budget. The
  // per-tool outputs are already truncated above; this cap now also has to fit
  // the context-packet section, hence slightly larger than the old 12000.
  const joined = lines.join('\n')
  if (joined.length > 15000) {
    return `${joined.slice(0, 15000)}\n(trace truncated for judge)`
  }
  return joined
}

function loadScenarios(): ScenarioRecord[] {
  const yamlPath = path.join(HERE, 'scenarios.yaml')
  const doc = yaml.load(fs.readFileSync(yamlPath, 'utf8')) as { scenarios: ScenarioRecord[] }
  return doc.scenarios
}

async function main(): Promise<void> {
  console.log(color('bold', '\n=== Daylens AI behavioural harness ===\n'))

  // Wire full traces. sendMessage will write per-scenario trace JSON files
  // into this directory so the engineer can see exactly what the model saw.
  const runStamp = new Date().toISOString().replace(/[:.]/g, '-')
  const traceDir = path.join(process.cwd(), '.ai-behaviour', `traces-${runStamp}`)
  fs.mkdirSync(traceDir, { recursive: true })
  process.env.DAYLENS_AI_TRACE_DIR = traceDir
  console.log(color('dim', `[setup] trace dir: ${traceDir}`))

  // 1. Stage read-only copy of the real DB BEFORE initDb runs. setPath()
  //    must be set before any module that calls app.getPath('userData').
  const dbCtx = await stageReadOnlyCopyOfRealDb()
  console.log(color('dim', `[setup] real DB copy: ${dbCtx.copiedDbPath}`))

  // 2. Now we can import modules that touch the DB.
  const { initDb } = await import('../../src/main/services/database')
  initDb()
  console.log(color('dim', '[setup] DB initialised against the copy'))

  // 3. Load keys from keytar (Q6 — answer-quality eval program). The JUDGE
  //    always runs on Anthropic (a constant, reliable grader). The SUBJECT
  //    provider under evaluation is configurable so the same set can be run
  //    against each provider before shipping AI changes:
  //        DAYLENS_EVAL_PROVIDER=google npm run test:behaviour
  //    Defaults to anthropic for both (back-compat).
  const { getApiKey, setSettings } = await import('../../src/main/services/settings')
  const judgeApiKey = await getApiKey('anthropic')
  if (!judgeApiKey) {
    console.error(color('red', '\n[fatal] No Anthropic API key in keytar (the judge runs on Anthropic).'))
    console.error('Open Daylens → Settings → AI and save your Anthropic key, then re-run.')
    cleanupRealDbCopy(dbCtx)
    process.exit(2)
  }
  process.env.ANTHROPIC_API_KEY = judgeApiKey

  const evalProvider = (process.env.DAYLENS_EVAL_PROVIDER ?? 'anthropic') as AIProviderMode
  const isCliSubject = evalProvider === 'claude-cli' || evalProvider === 'chatgpt-cli' || evalProvider === 'gemini-cli' || evalProvider === 'codex-cli'
  const subjectApiKey = evalProvider === 'anthropic' ? judgeApiKey : await getApiKey(evalProvider)
  if (!subjectApiKey && !isCliSubject) {
    console.error(color('red', `\n[fatal] No ${evalProvider} key in keytar (DAYLENS_EVAL_PROVIDER=${evalProvider}).`))
    cleanupRealDbCopy(dbCtx)
    process.exit(2)
  }
  if (evalProvider === 'google' && subjectApiKey) {
    process.env.GOOGLE_API_KEY = subjectApiKey
    process.env.GEMINI_API_KEY = subjectApiKey
  }
  if (evalProvider === 'openai' && subjectApiKey) process.env.OPENAI_API_KEY = subjectApiKey
  console.log(color('dim', `[setup] judge=anthropic · subject=${evalProvider} (keys from keytar)`))

  // 4. Pin the selected provider to the subject. Every surface — chat,
  //    follow-ups, titles, report/export — now routes through `aiProvider`
  //    (invariant #12), so this single key covers them all.
  try {
    await setSettings({
      aiProvider: evalProvider,
      aiChatProvider: evalProvider,
    })
  } catch (e) {
    console.warn(color('yellow', `[setup] could not pin provider: ${e instanceof Error ? e.message : String(e)}`))
  }

  // 5. Gather ground truth once for the judge.
  const { gatherGroundTruth, renderGroundTruthForJudge } = await import('./groundTruth')
  const gt = gatherGroundTruth()
  const groundTruthBlob = renderGroundTruthForJudge(gt)
  console.log(color('dim', '[setup] ground truth gathered'))
  console.log(color('dim', '─── ground truth (compact) ────────────────────────────────'))
  console.log(color('dim', groundTruthBlob))
  console.log(color('dim', '────────────────────────────────────────────────────────────\n'))

  // 6. Pull the real send pipeline + the judge.
  const { sendMessage } = await import('../../src/main/jobs/aiService')
  const { judgeAnswer } = await import('./judge')

  let scenarios = loadScenarios()
  const filterArg = process.env.DAYLENS_AI_SCENARIO_FILTER || process.argv.slice(2).find((a) => !a.startsWith('-'))
  if (filterArg) {
    const wanted = new Set(filterArg.split(',').map((s) => s.trim()).filter(Boolean))
    scenarios = scenarios.filter((s) => wanted.has(s.id))
    console.log(color('yellow', `[filter] running ${scenarios.length} scenario(s): ${[...wanted].join(', ')}`))
  }
  const results: Array<{
    scenario: ScenarioRecord
    answer: string
    answerKind: string | null
    sourceKind: string | null
    durationMs: number
    judge: Awaited<ReturnType<typeof judgeAnswer>>
    artifactsEmitted: number
    tracePath?: string
    error?: string
  }> = []

  let idx = 0
  for (const scenario of scenarios) {
    idx += 1
    const header = `[${idx}/${scenarios.length}] ${scenario.id}`
    console.log(color('cyan', `\n${header}  (${scenario.family})`))
    console.log(color('bold', `  Q: ${scenario.question}`))

    const t0 = Date.now()
    try {
      const result = await sendMessage(
        { message: scenario.question, threadId: null },
        {
          traceScenarioId: scenario.id,
          // A scenario can script the answer to any askUser card the turn
          // raises; without one the production no-answer default applies.
          ...(scenario.ask_user_answer
            ? { onAgentQuestion: async () => scenario.ask_user_answer as string }
            : {}),
        },
      )
      const assistant = result.assistantMessage
      const text = assistant.content
      const durationMs = Date.now() - t0
      const answerKind = assistant.answerKind ?? null
      const sourceKind = (assistant as any).sourceKind
        ?? (result.conversationState as any)?.sourceKind
        ?? null
      const artifactsEmitted = (assistant.artifacts ?? []).length

      console.log(color('dim', `  route: kind=${answerKind} source=${sourceKind} artifacts=${artifactsEmitted} ${durationMs}ms`))
      console.log(color('yellow', `  A: ${text.replace(/\n/g, '\n     ')}`))

      const traceSummary = summarizeTraceForJudge(path.join(traceDir, `${scenario.id}.json`))
      const artifactSummary = summarizeArtifactsForJudge(assistant.artifacts ?? [])
      const evidence = [traceSummary, artifactSummary].filter(Boolean).join('\n\n') || undefined
      const followUps = (assistant.suggestedFollowUps ?? []).map((s) => s.text)
      const verdict = await judgeAnswer(scenario, text, groundTruthBlob, judgeApiKey, evidence, followUps)
      const gradeColor: keyof typeof ANSI =
        verdict.grade === 'good' ? 'green'
        : verdict.grade === 'bad' ? 'yellow'
        : verdict.grade === 'worse' ? 'red'
        : 'magenta'
      console.log(color(gradeColor, `  VERDICT: ${verdict.grade.toUpperCase()} — ${verdict.reason}`))
      console.log(color('dim', `  flags: gold_shape=${verdict.matchesGoldShape} citations=${verdict.citationsFound} hallucination=${verdict.hallucinationDetected} voice_ok=${verdict.voiceOk} followups_ok=${verdict.followUpsOk}`))

      results.push({
        scenario,
        answer: text,
        answerKind,
        sourceKind,
        durationMs,
        judge: verdict,
        artifactsEmitted,
        tracePath: path.join(traceDir, `${scenario.id}.json`),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.log(color('red', `  ERROR: ${message}`))
      results.push({
        scenario,
        answer: '',
        answerKind: null,
        sourceKind: null,
        durationMs: Date.now() - t0,
        judge: {
          scenarioId: scenario.id,
          grade: 'error',
          reason: message,
          citationsFound: false,
          hallucinationDetected: false,
          voiceOk: false,
          matchesGoldShape: false,
          followUpsOk: false,
          rawJudgeOutput: '',
        },
        artifactsEmitted: 0,
        error: message,
      })
    }
  }

  // 7. Roll-up + persist.
  const tally = { good: 0, bad: 0, worse: 0, error: 0 }
  for (const r of results) tally[r.judge.grade] += 1

  console.log(color('bold', '\n=== Summary ==='))
  console.log(`  good:  ${color('green', String(tally.good))}`)
  console.log(`  bad:   ${color('yellow', String(tally.bad))}`)
  console.log(`  worse: ${color('red', String(tally.worse))}`)
  console.log(`  error: ${color('magenta', String(tally.error))}`)

  const total = results.length || 1
  const score = {
    provider: evalProvider,
    good: tally.good,
    bad: tally.bad,
    worse: tally.worse,
    error: tally.error,
    goodPct: Math.round((tally.good / total) * 100),
  }

  const outDir = path.join(process.cwd(), '.ai-behaviour')
  fs.mkdirSync(outDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outPath = path.join(outDir, `results-${evalProvider}-${stamp}.json`)
  fs.writeFileSync(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    provider: evalProvider,
    score,
    tally,
    groundTruth: gt,
    results,
  }, null, 2))
  console.log(color('dim', `\nWrote ${outPath}`))

  // Q6: record/refresh the committed per-provider baseline when asked. The
  // baseline is the "before shipping" reference the spec calls for — diff a new
  // run against it to catch quality regressions per provider.
  if (process.env.DAYLENS_EVAL_BASELINE === '1') {
    const baselineDir = path.join(HERE, 'baselines')
    fs.mkdirSync(baselineDir, { recursive: true })
    const baselinePath = path.join(baselineDir, `${evalProvider}.json`)
    fs.writeFileSync(baselinePath, JSON.stringify({
      provider: evalProvider,
      recordedAt: new Date().toISOString(),
      score,
      perScenario: results.map((r) => ({ id: r.scenario.id, family: r.scenario.family, grade: r.judge.grade })),
    }, null, 2))
    console.log(color('dim', `Wrote baseline ${baselinePath}`))
  }

  cleanupRealDbCopy(dbCtx)

  // Non-zero exit only on errors; bad/worse are reported, not fatal — the
  // whole point of this harness is to surface them.
  if (tally.error > 0 || tally.worse > Math.ceil(results.length / 3)) {
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(color('red', `\n[fatal] ${err instanceof Error ? err.stack : String(err)}`))
  process.exit(1)
})
