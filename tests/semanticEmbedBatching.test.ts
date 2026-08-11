// The embed sub-batch planner exists because ONNX pads every text in a call
// to the longest one: a batch of short window titles plus one 1,500-char URL
// allocates attention buffers in the gigabytes (observed: a multi-hour
// allocation stall). Grouping by length bounds every call's cost while
// leaving the vectors untouched — padding is attention-masked.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  loadSemanticEmbedder,
  planEmbedSubBatches,
  semanticModelAssetStatus,
  SEMANTIC_EMBEDDING_DIMS,
} from '../src/main/services/semanticEmbedder.ts'

test('short texts stay in one sub-batch', () => {
  const plan = planEmbedSubBatches([15, 22, 34, 107, 26, 45])
  assert.equal(plan.length, 1)
  assert.deepEqual([...plan[0]].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5])
})

test('a long text is isolated from short ones instead of inflating their padding', () => {
  const lengths = [15, 22, 1591, 26, 34, 1408, 45]
  const plan = planEmbedSubBatches(lengths)
  // Every input appears exactly once.
  const flat = plan.flat().sort((a, b) => a - b)
  assert.deepEqual(flat, [0, 1, 2, 3, 4, 5, 6])
  // No sub-batch mixes a >512-char text with the short-title cluster.
  for (const subBatch of plan) {
    const max = Math.max(...subBatch.map((i) => lengths[i]))
    const cost = subBatch.length * Math.min(max, 512) ** 2
    assert.ok(cost <= 1_000_000, `sub-batch cost ${cost} exceeds the bound`)
  }
})

test('the cost bound holds for a full backfill batch of long texts', () => {
  const lengths = Array.from({ length: 32 }, () => 2_000)
  const plan = planEmbedSubBatches(lengths)
  assert.deepEqual(plan.flat().sort((a, b) => a - b), Array.from({ length: 32 }, (_, i) => i))
  for (const subBatch of plan) {
    assert.ok(subBatch.length * 512 ** 2 <= 1_000_000)
  }
})

test('empty input plans to no sub-batches', () => {
  assert.deepEqual(planEmbedSubBatches([]), [])
})

// Real-model equivalence: sub-batched embedding must return each vector at
// its original index. Exact bit-equality is not the invariant — the int8
// quantized model's outputs already shift ~1% with batch composition (true
// before sub-batching too) — but each position's vector must be by far the
// closest match to the same text embedded alone, proving the reordering maps
// results back correctly. Runs only where the pinned model artifact is
// present (a downloaded asset, not a committed one), so the hermetic suite
// stays hermetic.
test('sub-batched vectors come back at their original indices', async (t) => {
  if (!semanticModelAssetStatus().present) {
    t.skip('pinned semantic model artifact not present')
    return
  }
  const loaded = await loadSemanticEmbedder()
  assert.ok(loaded.ok, loaded.ok ? undefined : loaded.detail)
  if (!loaded.ok) return

  const texts = [
    'Warp — daylens — session',
    `Safari — ${'https://accounts.example.com/signin?'.padEnd(1_500, 'x')}`,
    'Obsidian — The One Thing',
  ]
  const together = await loaded.embedder.embed(texts)
  assert.equal(together.length, texts.length)
  const alone = await Promise.all(texts.map(async (text) => (await loaded.embedder.embed([text]))[0]))

  const cosine = (a: Float32Array, b: Float32Array): number => {
    let dot = 0
    for (let d = 0; d < SEMANTIC_EMBEDDING_DIMS; d += 1) dot += a[d] * b[d]
    return dot
  }
  for (const [index] of texts.entries()) {
    assert.equal(together[index]?.length, SEMANTIC_EMBEDDING_DIMS)
    const own = cosine(together[index], alone[index])
    assert.ok(own > 0.97, `vector ${index} drifted from its own text (cosine ${own.toFixed(4)})`)
    for (const [other] of texts.entries()) {
      if (other === index) continue
      const cross = cosine(together[index], alone[other])
      assert.ok(
        own > cross,
        `vector ${index} is closer to text ${other} (${cross.toFixed(4)}) than its own (${own.toFixed(4)}) — index mapping broken`,
      )
    }
  }
})
