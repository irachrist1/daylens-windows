import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveCanonicalApp } from '../src/main/lib/appIdentity.ts'
import { formatDisplayAppName } from '../src/renderer/lib/apps.ts'

test('mac-specific app aliases resolve to the right canonical app identities', () => {
  assert.equal(resolveCanonicalApp('company.thebrowser.dia', 'Dia').displayName, 'Dia')
  assert.equal(resolveCanonicalApp('com.TickTick.task.mac', 'TickTick').displayName, 'TickTick')
  assert.equal(resolveCanonicalApp('com.openai.atlas', 'ChatGPT Atlas').displayName, 'ChatGPT')
  assert.equal(resolveCanonicalApp('ai.perplexity.comet', 'Comet').displayName, 'Comet')
  assert.equal(resolveCanonicalApp('com.apple.systempreferences', 'System Settings').displayName, 'System Settings')
  assert.equal(resolveCanonicalApp('com.daylens.app.dev', 'Daylens').displayName, 'Daylens')
})

test('renderer display aliases stay human on mac-focused app names', () => {
  assert.equal(formatDisplayAppName('ChatGPT Atlas'), 'ChatGPT')
  assert.equal(formatDisplayAppName('System Settings'), 'System Settings')
  assert.equal(formatDisplayAppName('TickTick'), 'TickTick')
  assert.equal(formatDisplayAppName('DaylensWindows'), 'Daylens')
})
