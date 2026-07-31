// The contract around the day recap (DEV-292).
//
// The prose itself cannot be unit-tested for quality — that is what the recap
// lab and the eval family are for. What can be locked down is everything
// around it: that the job is given enough time to finish, that the response
// shape carries only what something renders, and that a failure still says so.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { JOB_DEFINITIONS } from '../src/main/services/aiOrchestration.ts'
import { parseDaySummaryResultText } from '../src/main/lib/daySummaryParse.ts'
import { RECAP_VARIANTS, SHIPPED_RECAP_VARIANT_ID, shippedRecapVariant } from '../src/main/ai/recapVariants.ts'

// Measured through the recap lab against real days: 24-52s on the API, 33-77s
// through the Claude CLI. The floor is double the worst observed run, because
// the worst observed run is not the worst possible day.
const MEASURED_RECAP_FLOOR_MS = 150_000

test('the recap job is given enough time to finish on a real day', () => {
  const definition = JOB_DEFINITIONS.day_summary
  assert.ok(
    definition.timeoutMs >= MEASURED_RECAP_FLOOR_MS,
    `day_summary budget is ${definition.timeoutMs}ms; below the measured floor of ${MEASURED_RECAP_FLOOR_MS}ms the recap silently serves the factual fallback`,
  )
})

test('the recap actually holds itself to that budget', async () => {
  // executeTextAIJob does NOT enforce a job's declared timeoutMs — the caller
  // must impose the belt. Deleting that belt leaves the recap able to hang
  // forever while the definitions table still reads like it is bounded, which
  // no other test would notice.
  const source = await readFile(new URL('../src/main/jobs/aiService.ts', import.meta.url), 'utf8')
  const recapCall = source.slice(source.indexOf('export async function generateDaySummary'))
  const body = recapCall.slice(0, recapCall.indexOf('\nfunction ', 1))
  assert.match(body, /withTimeout\(/, 'the recap call has no timeout belt: a hung provider would hang the panel')
  assert.match(
    body,
    /jobTimeoutMs\('day_summary'\)/,
    'the belt must read the budget from the job definition, not repeat a literal that can drift',
  )
})

test('the recap gets more room than the wrapped narrative, because it is slower in practice', () => {
  // These were aligned on the assumption that a day's recap and a day's deck
  // cost about the same. Measuring killed that: on a CLI provider the recap
  // pays process start plus an agent loop per call, and ran past every
  // wrapped-narrative budget. Kept as an assertion so re-aligning them is a
  // decision someone makes, not something that happens quietly.
  assert.ok(
    JOB_DEFINITIONS.day_summary.timeoutMs > JOB_DEFINITIONS.wrapped_narrative.timeoutMs,
    'the recap budget fell back to the wrapped narrative’s; it was measured slower than that',
  )
})

test('a recap result carries only the summary — nothing generates output no surface renders', () => {
  const parsed = parseDaySummaryResultText(JSON.stringify({
    summary: 'Most of the morning went to the capture relay rewrite.',
    questionSuggestions: ['What did I get done?', 'Which files mattered?', 'Summarize this'],
  }))
  assert.ok(parsed)
  assert.equal(parsed.summary, 'Most of the morning went to the capture relay rewrite.')
  assert.deepEqual(
    Object.keys(parsed).sort(),
    ['summary'],
    'a model that still volunteers suggestions must not put them back on the result',
  )
})

test('a recap answered as plain prose is kept, not degraded to the fallback', () => {
  const prose = 'You spent most of the afternoon on the recap lab, with a short stretch in your browser.'
  assert.deepEqual(parseDaySummaryResultText(prose), { summary: prose })
})

test('a truncated reply still yields the recap when the summary field survived', () => {
  const truncated = '{"summary": "The day was mostly the timeline rewrite.", "extra": '
  assert.deepEqual(parseDaySummaryResultText(truncated), { summary: 'The day was mostly the timeline rewrite.' })
})

test('an unusable reply produces no recap, so the caller can degrade honestly', () => {
  assert.equal(parseDaySummaryResultText(''), null)
  assert.equal(parseDaySummaryResultText('{"summary": ""}'), null)
  assert.equal(parseDaySummaryResultText('{"notASummary": "hello"}'), null)
})

test('a provider failure reaches the panel as a sentence, not as tagged internals', async () => {
  const { degradedRecapReason } = await import('../src/main/jobs/aiService.ts')
  const tagged = new Error(
    'Anthropic Claude\'s credit balance is too low. Top it up with the provider, or switch providers in Settings → AI. ⟦dlerr:{"code":"credit_exhausted"}⟧',
  )
  const result = degradedRecapReason(tagged)
  assert.ok(!result.degradedReason?.includes('dlerr'), `the error sentinel reached the panel: ${result.degradedReason}`)
  assert.ok(!result.degradedReason?.includes('⟦'), 'the sentinel brackets reached the panel')
  assert.match(result.degradedReason ?? '', /credit balance is too low/)
  assert.match(result.degradedReason ?? '', /\.$/, 'the reason is punctuated so it reads as a sentence in the banner')
})

test('a wall only the person can clear is not dressed up as something a retry fixes', async () => {
  const { degradedRecapReason } = await import('../src/main/jobs/aiService.ts')
  const hardWall = degradedRecapReason(new Error('Out of credit. ⟦dlerr:{"code":"credit_exhausted"}⟧'))
  assert.equal(hardWall.degradedNeedsAction, true, 'exhausted credit needs the person to act, not another click')

  const transient = degradedRecapReason(new Error('Rate limited, try shortly. ⟦dlerr:{"code":"transient_rate_limit"}⟧'))
  assert.equal(transient.degradedNeedsAction, undefined, 'a transient failure IS worth retrying')

  const timeout = degradedRecapReason(new Error('Day summary timed out'))
  assert.equal(timeout.degradedNeedsAction, undefined)
  assert.equal(timeout.degradedReason, 'Day summary timed out.')
})

test('an unreadable failure still degrades without inventing a reason', async () => {
  const { degradedRecapReason } = await import('../src/main/jobs/aiService.ts')
  assert.deepEqual(degradedRecapReason(new Error('')), {})
  assert.deepEqual(degradedRecapReason(undefined), {})
})

test('every recap variant is shippable: distinct id, a description, and real directives', () => {
  const ids = RECAP_VARIANTS.map((variant) => variant.id)
  assert.equal(new Set(ids).size, ids.length, `duplicate variant ids: ${ids.join(', ')}`)
  for (const variant of RECAP_VARIANTS) {
    assert.ok(variant.description.trim(), `${variant.id} has no description — the lab prints it to explain the choice`)
    assert.ok(variant.directives.length >= 3, `${variant.id} has too few directives to be a real candidate`)
    const message = variant.userMessage('2026-07-29', '{"blocks":[]}')
    assert.match(message, /2026-07-29/, `${variant.id} drops the date from its user message`)
    assert.match(message, /"blocks"/, `${variant.id} drops the day evidence from its user message`)
  }
})

test('every variant carries the one naming rule, and carries it as the only one', () => {
  // A recap gets read on a shared screen. Naming a porn site in it makes the
  // feature unusable exactly where it is most useful — but the time is still
  // accounted for, and nothing ELSE personal gets the same treatment: health,
  // money, job hunting are named as plainly as work.
  for (const variant of RECAP_VARIANTS) {
    const directives = variant.directives.join('\n')
    assert.match(directives, /Adult or pornographic sites/, `${variant.id} can name a porn site in a recap`)
    assert.match(directives, /Account for the time/, `${variant.id} may drop the time instead of describing it`)
    assert.ok(
      !/\b(health|medical|therapy|job hunt|finances?)\b/i.test(directives),
      `${variant.id} extends the naming rule past adult content, which would hide real parts of the day`,
    )
  }
})

test('the shipped variant names something that exists', () => {
  assert.equal(shippedRecapVariant().id, SHIPPED_RECAP_VARIANT_ID)
})

test('no variant asks for output nothing renders', () => {
  for (const variant of RECAP_VARIANTS) {
    const prompt = [...variant.directives, variant.userMessage('2026-07-29', '{}')].join('\n')
    assert.ok(
      !/questionSuggestions|next-query chip/i.test(prompt),
      `${variant.id} still asks for the suggested questions no surface displays`,
    )
  }
})
