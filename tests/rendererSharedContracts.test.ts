import test from 'node:test'
import assert from 'node:assert/strict'
import { activityCategoryLabel, EDITABLE_BLOCK_CATEGORY_OPTIONS } from '../src/shared/activityCategories.ts'
import { appDetailRangeKey, appNarrativeScopeKey, isThinAppNarrative, parseSurfaceSummaryResult, THIN_APP_NARRATIVE_SUMMARY } from '../src/shared/appNarrativeContract.ts'

test('shared activity categories keep UI identity separate from prompt prose', () => {
  assert.equal(activityCategoryLabel('aiTools'), 'AI Tools')
  assert.equal(activityCategoryLabel('uncategorized'), 'Uncategorized')
  assert.equal(activityCategoryLabel('uncategorized', { uncategorized: 'Uncategorized' }), 'Uncategorized')
  assert.equal(EDITABLE_BLOCK_CATEGORY_OPTIONS.some(({ value }) => value === 'system'), false)
})

test('app narrative keys and thin status use one shared contract', () => {
  const rangeKey = appDetailRangeKey('2026-07-10', 'ignored')
  assert.equal(rangeKey, '1d:2026-07-10')
  assert.equal(appNarrativeScopeKey('com.example.app', rangeKey), 'app:com.example.app:1d:2026-07-10')
  assert.equal(isThinAppNarrative(THIN_APP_NARRATIVE_SUMMARY), true)
  assert.equal(isThinAppNarrative('A real narrative about two artifacts.'), false)
  assert.equal(parseSurfaceSummaryResult('{"title":"Dia","summary":"{bad"}', 'Dia'), null)
  assert.equal(parseSurfaceSummaryResult('{"title":"Dia","summary":"You read Linear and GitHub."}', 'Dia')?.summary, 'You read Linear and GitHub.')
})

