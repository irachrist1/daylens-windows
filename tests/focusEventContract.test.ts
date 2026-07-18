import test from 'node:test'
import assert from 'node:assert/strict'
import {
  FOCUS_EVENT_SCHEMA_VERSION,
  SUPPORTED_FOCUS_EVENT_SCHEMA_VERSIONS,
  evidenceKindForFocusEventType,
  isFocusEventConfidence,
  isFocusEventSource,
  isFocusEventType,
  isMacFocusEventSource,
  supervisorEventCarriesContent,
  isSupportedFocusEventSchemaVersion,
  isWindowsFocusEventSource,
  provenanceForFocusEventSource,
  sourceAcceptsFocusEventType,
  validateFocusEventForInsert,
  type FocusEventInsert,
} from '../src/main/core/evidence/focusEvent.ts'

test('focus event contract identifies platform sources and schema values', () => {
  assert.equal(FOCUS_EVENT_SCHEMA_VERSION, 2)
  assert.deepEqual([...SUPPORTED_FOCUS_EVENT_SCHEMA_VERSIONS].sort(), [1, 2])
  assert.equal(isSupportedFocusEventSchemaVersion(1), true)
  assert.equal(isSupportedFocusEventSchemaVersion(2), true)
  assert.equal(isSupportedFocusEventSchemaVersion(3), false)
  assert.equal(isSupportedFocusEventSchemaVersion(0), false)
  assert.equal(isFocusEventType('window_changed'), true)
  assert.equal(isFocusEventType('capture_paused'), true)
  assert.equal(isFocusEventType('idle_started'), true)
  assert.equal(isFocusEventType('unknown_event'), false)
  assert.equal(isFocusEventConfidence('observed'), true)
  assert.equal(isFocusEventConfidence('inferred'), false)
  assert.equal(isMacFocusEventSource('nsworkspace_event'), true)
  assert.equal(isMacFocusEventSource('uia_foreground'), false)
  assert.equal(isWindowsFocusEventSource('uia_tab'), true)
  assert.equal(isWindowsFocusEventSource('apple_events_tab'), false)
  assert.equal(isFocusEventSource('nsworkspace_event'), true)
  assert.equal(isFocusEventSource('uia_tab'), true)
  assert.equal(isFocusEventSource('capture_supervisor'), true)
  assert.equal(isFocusEventSource('unknown_helper'), false)
})

test('focus event contract keeps foreground and tab events on compatible sources', () => {
  assert.equal(sourceAcceptsFocusEventType('nsworkspace_event', 'app_activated'), true)
  assert.equal(sourceAcceptsFocusEventType('nsworkspace_event', 'tab_changed'), false)
  assert.equal(sourceAcceptsFocusEventType('uia_foreground', 'window_changed'), true)
  assert.equal(sourceAcceptsFocusEventType('uia_foreground', 'tab_sampled'), false)
  assert.equal(sourceAcceptsFocusEventType('apple_events_tab', 'tab_changed'), true)
  assert.equal(sourceAcceptsFocusEventType('apple_events_tab', 'window_changed'), false)
  assert.equal(sourceAcceptsFocusEventType('uia_tab', 'tab_sampled'), true)
  assert.equal(sourceAcceptsFocusEventType('uia_tab', 'app_deactivated'), false)
})

test('machine-state and capture-state kinds belong to the capture supervisor only', () => {
  assert.equal(sourceAcceptsFocusEventType('capture_supervisor', 'idle_started'), true)
  assert.equal(sourceAcceptsFocusEventType('capture_supervisor', 'capture_failed'), true)
  assert.equal(sourceAcceptsFocusEventType('capture_supervisor', 'app_activated'), false)
  assert.equal(sourceAcceptsFocusEventType('capture_supervisor', 'tab_changed'), false)
  assert.equal(sourceAcceptsFocusEventType('nsworkspace_event', 'capture_paused'), false)
  assert.equal(sourceAcceptsFocusEventType('uia_foreground', 'idle_ended'), false)
})

test('supervisor events must not carry application names, titles, or URLs', () => {
  const clean = {
    event_type: 'capture_paused' as const,
    app_bundle_id: null,
    app_name: null,
    window_title: null,
    url: null,
    page_title: null,
  }
  assert.equal(supervisorEventCarriesContent(clean), false)
  assert.equal(supervisorEventCarriesContent({ ...clean, app_name: 'Figma' }), true)
  assert.equal(supervisorEventCarriesContent({ ...clean, url: 'https://example.com' }), true)
  assert.equal(
    supervisorEventCarriesContent({ ...clean, event_type: 'idle_started' }),
    false,
  )
  assert.equal(
    supervisorEventCarriesContent({ ...clean, event_type: 'idle_started', app_name: 'Figma' }),
    true,
  )
  assert.equal(
    supervisorEventCarriesContent({ ...clean, event_type: 'idle_ended', window_title: 'notes.md' }),
    true,
  )
  assert.equal(
    supervisorEventCarriesContent({ ...clean, event_type: 'app_activated', app_name: 'Figma' }),
    false,
  )
})

test('every focus event source declares its capture provenance', () => {
  for (const source of ['nsworkspace_event', 'apple_events_tab', 'uia_foreground', 'uia_tab', 'capture_supervisor'] as const) {
    const provenance = provenanceForFocusEventSource(source)
    assert.ok(provenance.method.length > 0, `${source} missing method`)
    assert.ok(provenance.permissionScope.length > 0, `${source} missing permission scope`)
  }
})

test('storage kinds map to canonical evidence kinds; tab events stay on the browser path', () => {
  assert.equal(evidenceKindForFocusEventType('app_activated'), 'app_activated')
  assert.equal(evidenceKindForFocusEventType('space_changed'), 'window_changed')
  assert.equal(evidenceKindForFocusEventType('lock'), 'locked')
  assert.equal(evidenceKindForFocusEventType('unlock'), 'unlocked')
  assert.equal(evidenceKindForFocusEventType('sleep'), 'sleep')
  assert.equal(evidenceKindForFocusEventType('idle_started'), 'idle_started')
  assert.equal(evidenceKindForFocusEventType('capture_recovered'), 'capture_recovered')
  assert.equal(evidenceKindForFocusEventType('tab_changed'), null)
  assert.equal(evidenceKindForFocusEventType('tab_sampled'), null)
})

function baseEvent(overrides: Partial<FocusEventInsert> = {}): FocusEventInsert {
  return {
    ts_ms: 1000,
    mono_ns: 1_000_000,
    event_type: 'app_activated',
    app_bundle_id: 'test.app',
    app_name: 'Test App',
    pid: 1,
    window_title: null,
    url: null,
    page_title: null,
    source: 'nsworkspace_event',
    confidence: 'observed',
    platform: 'darwin',
    schema_ver: FOCUS_EVENT_SCHEMA_VERSION,
    ...overrides,
  }
}

test('insert validation rejects unsupported schema versions and contract violations', () => {
  assert.equal(validateFocusEventForInsert(baseEvent()), null)
  assert.equal(validateFocusEventForInsert(baseEvent({ schema_ver: 1 })), null)
  assert.equal(validateFocusEventForInsert(baseEvent({ schema_ver: 3 })), 'unsupported_schema_version')
  assert.equal(validateFocusEventForInsert(baseEvent({ event_type: 'tab_changed' })), 'source_kind_mismatch')
  assert.equal(
    validateFocusEventForInsert(baseEvent({
      event_type: 'capture_failed',
      source: 'capture_supervisor',
      app_bundle_id: null,
      app_name: 'Leaky App',
      pid: null,
    })),
    'supervisor_content',
  )
  assert.equal(
    validateFocusEventForInsert(baseEvent({
      event_type: 'idle_started',
      source: 'capture_supervisor',
      app_bundle_id: null,
      app_name: null,
      pid: null,
      window_title: 'notes.md',
    })),
    'supervisor_content',
  )
  assert.equal(
    validateFocusEventForInsert(baseEvent({ sensitivity: 'secret' as never })),
    'invalid_sensitivity',
  )
})

test('insert validation rejects values outside the storage allowlists', () => {
  assert.equal(
    validateFocusEventForInsert(baseEvent({ event_type: 'app_actived' as never })),
    'unknown_event_type',
  )
  assert.equal(
    validateFocusEventForInsert(baseEvent({ confidence: 'certain' as never })),
    'unknown_confidence',
  )
  assert.equal(
    validateFocusEventForInsert(baseEvent({ source: 'unknown_helper' as never })),
    'unknown_source',
  )
})

test('insert validation enforces the page-content rules the storage layer checks', () => {
  assert.equal(
    validateFocusEventForInsert(baseEvent({ url: 'https://example.com' })),
    'page_content_violation',
  )
  assert.equal(
    validateFocusEventForInsert(baseEvent({
      event_type: 'tab_changed',
      source: 'apple_events_tab',
      confidence: 'unknown',
      page_title: 'Leaked title',
    })),
    'page_content_violation',
  )
  assert.equal(
    validateFocusEventForInsert(baseEvent({
      event_type: 'tab_changed',
      source: 'apple_events_tab',
      confidence: 'observed',
      url: null,
    })),
    'page_content_violation',
  )
  assert.equal(
    validateFocusEventForInsert(baseEvent({
      event_type: 'tab_changed',
      source: 'apple_events_tab',
      confidence: 'observed',
      url: 'https://example.com/docs',
      page_title: 'Docs',
    })),
    null,
  )
})
