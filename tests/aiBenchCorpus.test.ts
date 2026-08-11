// Structural guard for the ai-bench corpus. corpus.yaml and goldenAnswers.yaml
// are the pinned question/expectation seed for chat-answer evals; no runner
// consumes them yet, so without this test they could silently rot — typo'd
// fixture names, golden assertion_ids pointing at deleted corpus entries,
// misspelled expectation keys. This test parses both files and enforces the
// schema documented in each file's header, so the seed stays loadable the day
// a runner is wired up.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { FIXTURES } from './ai-bench/fixtures'

const BENCH_DIR = path.join(__dirname, 'ai-bench')

const CORPUS_ENTRY_KEYS = new Set(['id', 'question', 'fixture', 'mode', 'provider', 'note', 'expect'])
const EXPECT_KEYS = new Set([
  'router_kind',
  'must_include',
  'must_not_include',
  'min_length',
  'must_cite_block',
  'live_must_include',
  'live_must_not_include',
  'live_min_length',
])
const ROUTER_KINDS = new Set(['answer', 'weeklyBrief', 'any', null])
const GOLDEN_KEYS = new Set([
  'id',
  'question',
  'expected_shape',
  'minimum_entities_cited',
  'must_cite_block',
  'assertion_ids',
])

function loadYaml(filename: string): unknown {
  return yaml.load(fs.readFileSync(path.join(BENCH_DIR, filename), 'utf8'))
}

function assertStringArray(value: unknown, label: string): void {
  assert.ok(Array.isArray(value), `${label} must be an array`)
  for (const item of value as unknown[]) {
    assert.equal(typeof item, 'string', `${label} entries must be strings`)
    assert.ok((item as string).length > 0, `${label} entries must be non-empty`)
  }
}

interface CorpusEntry {
  id: string
  question: string
  fixture: string
  mode: string
  expect: Record<string, unknown>
  [key: string]: unknown
}

function corpusEntries(): CorpusEntry[] {
  const doc = loadYaml('corpus.yaml') as { questions?: unknown }
  assert.ok(Array.isArray(doc.questions) && doc.questions.length > 0, 'corpus.yaml must have a non-empty questions list')
  return doc.questions as CorpusEntry[]
}

test('corpus.yaml entries match the documented schema', () => {
  const seenIds = new Set<string>()
  for (const entry of corpusEntries()) {
    assert.equal(typeof entry.id, 'string', 'every corpus entry needs a string id')
    assert.ok(!seenIds.has(entry.id), `duplicate corpus id: ${entry.id}`)
    seenIds.add(entry.id)

    const where = `corpus entry ${entry.id}`
    for (const key of Object.keys(entry)) {
      assert.ok(CORPUS_ENTRY_KEYS.has(key), `${where}: unknown key "${key}"`)
    }
    assert.ok(typeof entry.question === 'string' && entry.question.length > 0, `${where}: question required`)
    assert.ok(['router', 'both'].includes(entry.mode), `${where}: mode must be router|both, got "${entry.mode}"`)
    assert.ok(entry.expect && typeof entry.expect === 'object', `${where}: expect block required`)

    for (const [key, value] of Object.entries(entry.expect)) {
      assert.ok(EXPECT_KEYS.has(key), `${where}: unknown expect key "${key}"`)
      if (key === 'router_kind') {
        assert.ok(ROUTER_KINDS.has(value as string | null), `${where}: bad router_kind "${String(value)}"`)
      } else if (key === 'must_cite_block') {
        assert.equal(typeof value, 'boolean', `${where}: must_cite_block must be boolean`)
      } else if (key === 'min_length' || key === 'live_min_length') {
        assert.ok(typeof value === 'number' && value > 0, `${where}: ${key} must be a positive number`)
      } else {
        assertStringArray(value, `${where}: ${key}`)
      }
    }
  }
})

test('every corpus fixture name resolves to a real fixture', () => {
  for (const entry of corpusEntries()) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(FIXTURES, entry.fixture),
      `corpus entry ${entry.id} names unknown fixture "${entry.fixture}" — not in tests/ai-bench/fixtures.ts`,
    )
  }
})

test('goldenAnswers.yaml goldens are well-formed and point at real corpus ids', () => {
  const corpusIds = new Set(corpusEntries().map((entry) => entry.id))
  const doc = loadYaml('goldenAnswers.yaml') as { goldens?: unknown }
  assert.ok(Array.isArray(doc.goldens) && doc.goldens.length > 0, 'goldenAnswers.yaml must have a non-empty goldens list')

  const seenIds = new Set<string>()
  for (const golden of doc.goldens as Array<Record<string, unknown>>) {
    assert.equal(typeof golden.id, 'string', 'every golden needs a string id')
    const where = `golden ${golden.id as string}`
    assert.ok(!seenIds.has(golden.id as string), `duplicate golden id: ${golden.id as string}`)
    seenIds.add(golden.id as string)

    for (const key of Object.keys(golden)) {
      assert.ok(GOLDEN_KEYS.has(key), `${where}: unknown key "${key}"`)
    }
    assert.ok(typeof golden.question === 'string' && golden.question.length > 0, `${where}: question required`)
    assert.ok(typeof golden.expected_shape === 'string' && golden.expected_shape.length > 0, `${where}: expected_shape required`)
    assert.ok(
      Number.isInteger(golden.minimum_entities_cited) && (golden.minimum_entities_cited as number) >= 0,
      `${where}: minimum_entities_cited must be a non-negative integer`,
    )
    assert.equal(typeof golden.must_cite_block, 'boolean', `${where}: must_cite_block must be boolean`)

    // assertion_ids is optional — a golden without one is descriptive-only,
    // not yet machine-encoded in the corpus. When present, every id must
    // resolve so goldens can't point at deleted corpus entries.
    if (golden.assertion_ids !== undefined) {
      assertStringArray(golden.assertion_ids, `${where}: assertion_ids`)
      assert.ok((golden.assertion_ids as string[]).length > 0, `${where}: assertion_ids must be non-empty when present`)
      for (const assertionId of golden.assertion_ids as string[]) {
        assert.ok(corpusIds.has(assertionId), `${where}: assertion_id "${assertionId}" not found in corpus.yaml`)
      }
    }
  }
})
