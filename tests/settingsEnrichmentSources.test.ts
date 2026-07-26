// DEV-252 regression: the Raycast Focus (and every other enrichment) toggle
// persisted via setSettings but getSettings never read the key back from the
// store, so the toggle reverted to off on the next read (navigate away and
// back, or app restart). This exercises the REAL settings service against the
// in-memory electron-store stub. Tests run in declaration order and share the
// per-process store, so the never-written assertion comes first.
import test from 'node:test'
import assert from 'node:assert/strict'
import { getSettings, initSettings, setSettings } from '../src/main/services/settings.ts'

test('enrichmentSources defaults to an empty map when never written', async () => {
  await initSettings()
  // Unrelated writes must not invent enrichment state.
  await setSettings({ userName: 'someone' })
  const value = getSettings().enrichmentSources
  assert.ok(value !== undefined, 'enrichmentSources must be read back from the store')
  assert.equal(value?.['focus:Raycast Focus'], undefined)
})

test('enrichmentSources round-trips through setSettings and getSettings', async () => {
  await initSettings()

  await setSettings({ enrichmentSources: { 'focus:Raycast Focus': true } })
  assert.deepEqual(getSettings().enrichmentSources, { 'focus:Raycast Focus': true })

  // The renderer writes the whole merged map on each toggle; a later write
  // must be what the next read returns, not defaults.
  await setSettings({
    enrichmentSources: { 'focus:Raycast Focus': true, 'mcp:linear': true },
  })
  assert.deepEqual(getSettings().enrichmentSources, {
    'focus:Raycast Focus': true,
    'mcp:linear': true,
  })

  // Turning one toggle off persists too — off is a stored decision, not an
  // absent key.
  await setSettings({
    enrichmentSources: { 'focus:Raycast Focus': false, 'mcp:linear': true },
  })
  assert.equal(getSettings().enrichmentSources?.['focus:Raycast Focus'], false)
  assert.equal(getSettings().enrichmentSources?.['mcp:linear'], true)
})
