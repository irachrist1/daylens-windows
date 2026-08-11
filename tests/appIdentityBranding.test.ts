import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeWebsiteTitleForDisplay,
  resolveCanonicalApp,
  titleLooksLikeKeyboardMash,
  websiteDisplayLabel,
} from '../src/main/lib/appIdentity.ts'
import { brandedAppIconSpec, formatDisplayAppName } from '../src/renderer/lib/apps.ts'

test('mac-specific app aliases resolve to the right canonical app identities', () => {
  assert.equal(resolveCanonicalApp('company.thebrowser.dia', 'Dia').displayName, 'Dia')
  assert.equal(resolveCanonicalApp('com.TickTick.task.mac', 'TickTick').displayName, 'TickTick')
  assert.equal(resolveCanonicalApp('com.openai.atlas', 'ChatGPT Atlas').displayName, 'ChatGPT')
  assert.equal(resolveCanonicalApp('ai.perplexity.comet', 'Comet').displayName, 'Comet')
  // Windsurf's rebranded bundle reports "Devin" as its OS name (DEV-280): the
  // bundle id is the truth and must win over the process name.
  assert.equal(resolveCanonicalApp('com.exafunction.windsurf', 'Devin').displayName, 'Windsurf')
  assert.equal(resolveCanonicalApp('com.exafunction.windsurf', '').displayName, 'Windsurf')
  assert.equal(resolveCanonicalApp('com.apple.systempreferences', 'System Settings').displayName, 'System Settings')
  assert.equal(resolveCanonicalApp('com.daylens.app.dev', 'Daylens').displayName, 'Daylens')
})

test('browser capability stays separate from the app category on every platform', () => {
  // Dia is a browser first: its default category is browsing so the
  // site-weighted block distribution decides what the time really was —
  // cataloging it aiTools collapsed every block of a Dia-centric day into one
  // category and one color.
  const dia = resolveCanonicalApp('company.thebrowser.dia', 'Dia')
  assert.equal(dia.defaultCategory, 'browsing')
  assert.equal(dia.isBrowser, true)

  const safari = resolveCanonicalApp('com.apple.Safari', 'Safari')
  assert.equal(safari.defaultCategory, 'browsing')
  assert.equal(safari.isBrowser, true)

  const zen = resolveCanonicalApp('/Applications/Zen.app/Contents/MacOS/zen', 'Zen')
  assert.equal(zen.canonicalAppId, 'zen')
  assert.equal(zen.isBrowser, true)

  const claude = resolveCanonicalApp('com.anthropic.claudefordesktop', 'Claude')
  assert.equal(claude.isBrowser, false)
})

test('catalog names collapse legacy executable-path rows to one canonical identity', () => {
  assert.equal(resolveCanonicalApp('/Applications/Warp.app/Contents/MacOS/stable', 'Warp').canonicalAppId, 'warp')
  assert.equal(resolveCanonicalApp('/Applications/Claude.app/Contents/MacOS/Claude', 'Claude').canonicalAppId, 'claude')
  assert.equal(resolveCanonicalApp('/Applications/Comet.app/Contents/MacOS/Comet', 'Comet').canonicalAppId, 'comet')
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

// DEV-239: keyboard-mash garbage typed into a search box lands verbatim in
// the captured page title and used to display as a real 14-minute "page".
// The detector is structural (consonant runs, letter/digit alternation,
// row-of-keys punctuation), never a blocklist of observed strings.
test('keyboard-mash page titles are junk; real titles survive', () => {
  // The observed garbage string (dossier row A4) and structural siblings.
  assert.equal(titleLooksLikeKeyboardMash('wwwtrttgbgggbsvcvgbjmk,l.;uk7u7i880p9o8i7u654321` - Google Search'), true)
  assert.equal(titleLooksLikeKeyboardMash('asdfghjkl qwertyuiop - Google Search'), true)
  assert.equal(titleLooksLikeKeyboardMash('xjkvbnmzxcvbnm'), true)
  assert.equal(titleLooksLikeKeyboardMash('a1b2c3d4e5f6'), true)

  // Real subjects, including hard cases the heuristics must not eat.
  assert.equal(titleLooksLikeKeyboardMash('Naomie Nishimwe - Google Search'), false)
  assert.equal(titleLooksLikeKeyboardMash('state-of-the-art performance review'), false)
  assert.equal(titleLooksLikeKeyboardMash('Schwartz Lecture Notes'), false)
  assert.equal(titleLooksLikeKeyboardMash('win32api documentation'), false)
  assert.equal(titleLooksLikeKeyboardMash('TypeScript 5.4 release notes'), false)
  assert.equal(titleLooksLikeKeyboardMash('rhythms and strengths'), false)
  assert.equal(titleLooksLikeKeyboardMash(''), false)
  assert.equal(titleLooksLikeKeyboardMash(null), false)
})

test('a mashed title falls back to the site name instead of displaying garbage', () => {
  assert.equal(
    normalizeWebsiteTitleForDisplay('google.com', 'wwwtrttgbgggbsvcvgbjmk,l.;uk7u7i880p9o8i7u654321` - Google Search'),
    null,
  )
  assert.equal(
    normalizeWebsiteTitleForDisplay('google.com', 'Naomie Nishimwe - Google Search'),
    'Naomie Nishimwe - Google Search',
  )
})

test('website labels normalize X and strip generic badge-count titles', () => {
  assert.equal(websiteDisplayLabel('x.com'), 'X (Twitter)')
  assert.equal(websiteDisplayLabel('twitter.com'), 'X (Twitter)')
  assert.equal(normalizeWebsiteTitleForDisplay('x.com', '(4) Home / X'), 'X (Twitter)')
  assert.equal(normalizeWebsiteTitleForDisplay('twitter.com', 'Twitter'), 'X (Twitter)')
  assert.equal(normalizeWebsiteTitleForDisplay('x.com', 'Notifications / X'), 'X (Twitter) notifications')
  assert.equal(normalizeWebsiteTitleForDisplay('github.com', 'Home'), 'GitHub')
})
