// Regression: the readability floor let a short card paint past its real
// end, covering the idle gap (and its caption) between it and the next
// block. The clock wins over the floor.
import test from 'node:test'
import assert from 'node:assert/strict'
import { assignLanes, calendarCardHeights } from '../src/renderer/lib/timelineBlockLayout.ts'

const MIN = 44

test('a long block keeps its true proportional height', () => {
  const heights = calendarCardHeights([{ top: 0, bottom: 120 }], MIN)
  assert.deepEqual(heights, [120])
})

test('a lone short block is floored for readability', () => {
  const heights = calendarCardHeights([{ top: 0, bottom: 10 }], MIN)
  assert.deepEqual(heights, [MIN])
})

test('the floor may stretch into a large idle gap but never reach the next block', () => {
  // 10px block, then nothing until the next block at 200px: plenty of room,
  // full floor applies.
  const roomy = calendarCardHeights(
    [
      { top: 0, bottom: 10 },
      { top: 200, bottom: 300 },
    ],
    MIN,
  )
  assert.deepEqual(roomy, [MIN, 100])

  // 10px block with the next block starting at 30px: the floor would bury the
  // gap and the next card — clamp to the space available, minus clearance.
  const tight = calendarCardHeights(
    [
      { top: 0, bottom: 10 },
      { top: 30, bottom: 130 },
    ],
    MIN,
  )
  assert.equal(tight[0], 28)
  assert.ok(tight[0] < 30, 'card must stop before the next block top')
})

test('a genuine true-duration overlap is drawn as-is, never silently shrunk', () => {
  const heights = calendarCardHeights(
    [
      { top: 0, bottom: 60 },
      { top: 40, bottom: 100 },
    ],
    MIN,
  )
  assert.deepEqual(heights, [60, 60])
})

test('a squeezed sliver keeps at least its true height', () => {
  // True height 20px but only 12px until the next block: truth beats both the
  // floor and the clamp.
  const heights = calendarCardHeights(
    [
      { top: 0, bottom: 20 },
      { top: 12, bottom: 80 },
    ],
    MIN,
  )
  assert.equal(heights[0], 20)
})

test('non-overlapping items each take the full width (one lane)', () => {
  const lanes = assignLanes([
    { start: 0, end: 10 },
    { start: 10, end: 20 },
    { start: 25, end: 40 },
  ])
  assert.deepEqual(lanes, [
    { lane: 0, lanes: 1 },
    { lane: 0, lanes: 1 },
    { lane: 0, lanes: 1 },
  ])
})

test('two overlapping items split into two side-by-side columns', () => {
  const lanes = assignLanes([
    { start: 0, end: 60 },
    { start: 30, end: 90 },
  ])
  assert.deepEqual(lanes, [
    { lane: 0, lanes: 2 },
    { lane: 1, lanes: 2 },
  ])
})

test('a freed column is reused so the cluster stays as narrow as possible', () => {
  // A (0–20) and B (0–50) overlap → 2 columns. C (25–40) starts after A ends,
  // so it reuses A's column; the whole cluster stays 2 wide, not 3.
  const lanes = assignLanes([
    { start: 0, end: 20 },
    { start: 0, end: 50 },
    { start: 25, end: 40 },
  ])
  assert.deepEqual(lanes, [
    { lane: 0, lanes: 2 },
    { lane: 1, lanes: 2 },
    { lane: 0, lanes: 2 },
  ])
})

test('placements are returned in input order regardless of start time', () => {
  const lanes = assignLanes([
    { start: 30, end: 90 },
    { start: 0, end: 60 },
  ])
  assert.deepEqual(lanes, [
    { lane: 1, lanes: 2 },
    { lane: 0, lanes: 2 },
  ])
})

test('a separate later cluster resets the column count', () => {
  const lanes = assignLanes([
    { start: 0, end: 60 },
    { start: 10, end: 70 },
    { start: 200, end: 260 },
  ])
  assert.deepEqual(lanes, [
    { lane: 0, lanes: 2 },
    { lane: 1, lanes: 2 },
    { lane: 0, lanes: 1 },
  ])
})
