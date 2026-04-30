import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeWebsiteTitleForDisplay, resolveCanonicalApp, websiteDisplayLabel } from '../src/main/lib/appIdentity.ts'
import { brandedAppIconSpec, formatDisplayAppName } from '../src/renderer/lib/apps.ts'

test('mac-specific app aliases resolve to the right canonical app identities', () => {
  assert.equal(resolveCanonicalApp('company.thebrowser.dia', 'Dia').displayName, 'Dia')
  assert.equal(resolveCanonicalApp('com.TickTick.task.mac', 'TickTick').displayName, 'TickTick')
  assert.equal(resolveCanonicalApp('com.openai.atlas', 'ChatGPT Atlas').displayName, 'ChatGPT')
  assert.equal(resolveCanonicalApp('ai.perplexity.comet', 'Comet').displayName, 'Comet')
  assert.equal(resolveCanonicalApp('com.apple.systempreferences', 'System Settings').displayName, 'System Settings')
  assert.equal(resolveCanonicalApp('com.daylens.app.dev', 'Daylens').displayName, 'Daylens')
})

test('Microsoft 365 app aliases resolve consistently across raw names and executables', () => {
  assert.equal(resolveCanonicalApp('excel.exe', 'EXCEL.EXE').displayName, 'Microsoft Excel')
  assert.equal(resolveCanonicalApp('', 'Microsoft Word').displayName, 'Microsoft Word')
  assert.equal(resolveCanonicalApp('powerpnt.exe', 'PowerPoint').displayName, 'Microsoft PowerPoint')
  assert.equal(resolveCanonicalApp('', 'Microsoft Outlook').displayName, 'Microsoft Outlook')
  assert.equal(resolveCanonicalApp('ms-teams.exe', 'Teams').displayName, 'Microsoft Teams')
})

test('renderer display aliases stay human on mac-focused app names', () => {
  assert.equal(formatDisplayAppName('ChatGPT Atlas'), 'ChatGPT')
  assert.equal(formatDisplayAppName('System Settings'), 'System Settings')
  assert.equal(formatDisplayAppName('TickTick'), 'TickTick')
  assert.equal(formatDisplayAppName('DaylensWindows'), 'Daylens')
})

test('camelcase product brands keep their marketed display names', () => {
  assert.equal(formatDisplayAppName('whatsApp'), 'WhatsApp')
  assert.equal(formatDisplayAppName('chatGPT'), 'ChatGPT')
  assert.equal(formatDisplayAppName('gitHub'), 'GitHub')
  assert.equal(formatDisplayAppName('oneDrive'), 'OneDrive')
  assert.equal(formatDisplayAppName('linkedIn'), 'LinkedIn')
  assert.equal(formatDisplayAppName('faceTime'), 'FaceTime')

  assert.equal(resolveCanonicalApp('', 'whatsApp').displayName, 'WhatsApp')
  assert.equal(resolveCanonicalApp('', 'chatGPT').displayName, 'ChatGPT')
  assert.equal(resolveCanonicalApp('', 'gitHub').displayName, 'GitHub')
  assert.equal(resolveCanonicalApp('', 'oneDrive').displayName, 'OneDrive')
  assert.equal(resolveCanonicalApp('', 'linkedIn').displayName, 'LinkedIn')
  assert.equal(resolveCanonicalApp('', 'faceTime').displayName, 'FaceTime')
})

test('renderer has branded Microsoft 365 fallback icon specs', () => {
  assert.deepEqual(brandedAppIconSpec('Microsoft Excel', 'excel'), {
    label: 'X',
    background: '#1f8f4d',
    foreground: '#ffffff',
  })
  assert.equal(brandedAppIconSpec('WINWORD.EXE')?.label, 'W')
  assert.equal(brandedAppIconSpec('Microsoft PowerPoint')?.label, 'P')
  assert.equal(brandedAppIconSpec('Microsoft Outlook')?.label, 'O')
  assert.equal(brandedAppIconSpec('Microsoft Teams')?.label, 'T')
})

test('website labels normalize X and strip generic badge-count titles', () => {
  assert.equal(websiteDisplayLabel('x.com'), 'X (Twitter)')
  assert.equal(websiteDisplayLabel('twitter.com'), 'X (Twitter)')
  assert.equal(normalizeWebsiteTitleForDisplay('x.com', '(4) Home / X'), 'X (Twitter)')
  assert.equal(normalizeWebsiteTitleForDisplay('twitter.com', 'Twitter'), 'X (Twitter)')
  assert.equal(normalizeWebsiteTitleForDisplay('x.com', 'Notifications / X'), 'X (Twitter) notifications')
  assert.equal(normalizeWebsiteTitleForDisplay('github.com', 'Home'), 'GitHub')
})
