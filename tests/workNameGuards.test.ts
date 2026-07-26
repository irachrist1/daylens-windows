import test from 'node:test'
import assert from 'node:assert/strict'
import {
  cleanWorkSubject,
  isDisqualifiedWorkSubject,
  isSurfaceName,
  isToolBrandName,
  looksLikeCommandLine,
  looksLikeInhumanTitle,
  looksLikeJoinedTabTitle,
  looksLikeRepoPathTitle,
  workNameGuardLabelViolation,
} from '../src/shared/workNameGuards.ts'

// Every rejected string below LEAKED into a real period wrap as a thread
// subject or stretch label.

test('tool brands are never work subjects, decorated or not', () => {
  assert.ok(isToolBrandName('Claude Code'))
  assert.ok(isToolBrandName('✳ Claude Code'))
  assert.ok(isToolBrandName('claude'))
  assert.ok(isToolBrandName('OpenCode'))
  assert.ok(!isToolBrandName('Claude Platform caching docs'))
})

test('terminal commands are never work subjects', () => {
  assert.ok(looksLikeCommandLine('npx @agent-native/core@latest skills add visual-plans'))
  assert.ok(looksLikeCommandLine('git rebase -i main'))
  assert.ok(looksLikeCommandLine('npm run dev'))
  assert.ok(!looksLikeCommandLine('Redesigning the SPCS website'))
  assert.ok(!looksLikeCommandLine('Q3 proposal'))
})

// The v2 predicate flagged ANY sentence starting with a binary's name and the
// startup repair then deleted the label rows unrecoverably. A command is an
// invocation shape, not a leading word.
test('prose that merely starts with a binary name is a work name, not a command', () => {
  const prose = [
    'Git workflow cleanup',
    'Make the onboarding deck',
    'Go over the quarterly budget',
    'Docker image size investigation',
    'Node upgrade planning for the API',
    'Go to market messaging draft',
  ]
  for (const label of prose) {
    assert.ok(!looksLikeCommandLine(label), `flagged prose as a command: "${label}"`)
  }
  // …while real invocations after a CLI verb are still flagged: flags,
  // paths/repo refs, shell syntax, and bare lowercase argument runs.
  const commands = [
    'npx @agent-native/core@latest skills add',
    'git checkout feature/evidence-seams',
    'npm install --save-dev vitest',
    'cargo build --release',
    'kubectl get pods -n daylens',
    'git rebase main',
    'brew install sqlite',
    'make VERBOSE=1',
  ]
  for (const label of commands) {
    assert.ok(looksLikeCommandLine(label), `missed a real command: "${label}"`)
  }
})

test('joined tab titles are never work subjects', () => {
  assert.ok(looksLikeJoinedTabTitle('Branch · Branch · Space Visualization Prep'))
  assert.ok(looksLikeJoinedTabTitle('OC | Apply founder design'))
  assert.ok(!looksLikeJoinedTabTitle('Machine Learning Pipeline'))
})

test('the combined gate rejects all real leaks and passes real work', () => {
  const leaks = [
    '✳ Claude Code', 'Claude', 'npx @agent-native/core@latest skills add visual-plans',
    'Branch · Branch · Space Visualization Prep', '',
  ]
  for (const leak of leaks) assert.ok(isDisqualifiedWorkSubject(leak), `should reject: "${leak}"`)
  const real = ['Redesigning SPCS Group website', 'CCI cafeteria pitch', 'Prompt cache hit rate drop investigation']
  for (const subject of real) assert.ok(!isDisqualifiedWorkSubject(subject), `should pass: "${subject}"`)
})

test('cleanWorkSubject strips decorations but keeps the real subject', () => {
  assert.equal(cleanWorkSubject('⠂ Review article skills for Codex and Cursor integration'), 'Review article skills for Codex and Cursor integration')
  assert.equal(cleanWorkSubject('✳ Claude Code'), null)
  assert.equal(cleanWorkSubject('npx @agent-native/core@latest skills add visual-plans'), null)
  assert.equal(cleanWorkSubject('  '), null)
  assert.equal(cleanWorkSubject('Q3 proposal'), 'Q3 proposal')
})

// ─── v4: junk that reached a real day's "workedOn" facts ─────────────────────

const LENOVO_LISTING = 'LENOVO T14S 2-IN-1 LAPTOP ,INTEL CORE ULTRA7-255U, PROCESSOR ,32GB RAM , 512GB SSD ,14.0" WUXGA AG 400NITS TOUCH SCREEN , UK-ENGLISH KEYBOARD , YOGA PEN , WINDOWS 11 GENUINE PROFFESSIONAL 64 BIT'

test('an inhuman capture title never names work: overlong, comma-spliced, or shouting', () => {
  assert.ok(looksLikeInhumanTitle(LENOVO_LISTING))
  assert.ok(isDisqualifiedWorkSubject(LENOVO_LISTING))
  assert.equal(cleanWorkSubject(LENOVO_LISTING), null)
  // Each heuristic alone: over the 90-char label bound; a comma-spliced spec
  // list; a long mostly-uppercase string.
  assert.ok(looksLikeInhumanTitle(`Reviewing ${'very '.repeat(20)}long threads`))
  assert.ok(looksLikeInhumanTitle('Laptop, 32GB RAM, 512GB SSD, touch screen'))
  assert.ok(looksLikeInhumanTitle('QUARTERLY BUDGET REVIEW DECK FINAL'))
  // Legit names survive, including longer inferred subjects and acronym-heavy
  // short ones.
  const legit = [
    'Setting up the work network with the Ubiquiti dashboard and Terminal',
    'Review article skills for Codex and Cursor integration',
    'CCI cafeteria pitch',
    'Redesigning SPCS Group website',
    'Planning, budgeting the quarter',
  ]
  for (const name of legit) {
    assert.ok(!looksLikeInhumanTitle(name), `flagged a legit name: "${name}"`)
  }
})

test('an owner/repo tab title never names work, uppercase owners included', () => {
  assert.ok(looksLikeRepoPathTitle('Irachrist1/daylens-v1: Daylens'))
  assert.ok(looksLikeRepoPathTitle('Irachrist1/daylens-v1'))
  assert.ok(looksLikeRepoPathTitle('irachrist1/daylens-v1: Daylens'))
  assert.ok(isDisqualifiedWorkSubject('Irachrist1/daylens-v1: Daylens'))
  assert.equal(cleanWorkSubject('Irachrist1/daylens-v1: Daylens'), null)
  // Acronym pairs stay prose.
  assert.ok(!looksLikeRepoPathTitle('CI/CD pipeline cleanup'))
  assert.ok(!looksLikeRepoPathTitle('A/B test analysis for onboarding'))
  assert.ok(!isDisqualifiedWorkSubject('CI/CD pipeline cleanup'))
  assert.ok(!isDisqualifiedWorkSubject('A/B test analysis for onboarding'))
})

test('mailbox and site surfaces never name work, with or without an unread badge', () => {
  const surfaces = [
    'Inbox (1)', 'Spam (11)', 'Inbox', 'Sent', 'Drafts', 'Trash', 'Junk',
    'Archive', 'All Mail', 'Sent Items', 'Deleted Items',
    'Your Repositories', 'Notifications', 'Pull Requests', 'Issues',
    'Home', 'Explore', 'Overview',
    // A single bare word plus a count is a folder badge whatever the word.
    'Updates (3)',
  ]
  for (const surface of surfaces) {
    assert.ok(isSurfaceName(surface), `missed a surface: "${surface}"`)
    assert.ok(isDisqualifiedWorkSubject(surface), `should reject: "${surface}"`)
  }
  // Full-match only: a surface word inside a real subject survives.
  const legit = [
    'Inbox zero push before the trip',
    'Issues with the billing retry',
    'Home page redesign',
    'Pull request review for the seams work',
  ]
  for (const name of legit) {
    assert.ok(!isSurfaceName(name), `flagged a legit name: "${name}"`)
    assert.ok(!isDisqualifiedWorkSubject(name), `should pass: "${name}"`)
  }
})

test('communication tool brands are instruments, never the day\'s work', () => {
  const brands = ['Microsoft Teams', 'Teams', 'Google Meet', 'Meet', 'Zoom', 'Slack', 'Outlook', 'Gmail']
  for (const brand of brands) {
    assert.ok(isToolBrandName(brand), `missed a brand: "${brand}"`)
    assert.ok(isDisqualifiedWorkSubject(brand), `should reject: "${brand}"`)
  }
  // Full-match only: a brand word leading a real subject survives.
  const legit = [
    'Meeting with the design team',
    'Teams standup notes',
    'Meet the new client prep',
    'Slack bot for deploy alerts',
  ]
  for (const name of legit) {
    assert.ok(!isToolBrandName(name), `flagged a legit name: "${name}"`)
    assert.ok(!isDisqualifiedWorkSubject(name), `should pass: "${name}"`)
  }
})

test('a disqualified subject behind a verb lead is rejected as a label', () => {
  assert.ok(workNameGuardLabelViolation('Working on Cursor Agents'))
  assert.ok(workNameGuardLabelViolation('Working on Cursor Agents in Daylens'))
  assert.ok(workNameGuardLabelViolation('Reviewing Copilot Chat'))
  assert.ok(workNameGuardLabelViolation('Working on Microsoft Teams'))
  // A tool as the whole object of the activity is still the tool as the work.
  assert.ok(workNameGuardLabelViolation('Catching up on Slack'))
  // The whole-label vocabulary still applies.
  assert.ok(workNameGuardLabelViolation('Microsoft Teams'))
  assert.ok(workNameGuardLabelViolation('Inbox (1)'))
  assert.ok(workNameGuardLabelViolation(LENOVO_LISTING))
  // Real activity labels pass: a tool named mid-phrase, a tool as the PLACE
  // of the work, or a surface-ish trailing word.
  const legit = [
    'Git workflow cleanup',
    'Make the onboarding deck',
    'Setting up the work network with the Ubiquiti dashboard and Terminal',
    'Refactoring the timeline engine',
    'Cleaning up the inbox',
    'Sprint planning in Slack',
    'Cursor rules for the billing service',
    'Designing the interpretation agent',
  ]
  for (const label of legit) {
    assert.equal(workNameGuardLabelViolation(label), null, `rejected a legit label: "${label}"`)
  }
})

test('a tool brand plus its own surface words is a panel title, never work', () => {
  assert.equal(isDisqualifiedWorkSubject('Cursor Agents'), true)
  assert.equal(isDisqualifiedWorkSubject('Copilot Chat'), true)
  assert.equal(isDisqualifiedWorkSubject('ChatGPT'), true)
  assert.equal(isDisqualifiedWorkSubject('New chat - Claude'), true)
  assert.equal(isDisqualifiedWorkSubject('Untitled chat'), true)
  // A brand followed by a REAL subject is still a valid work name.
  assert.equal(isDisqualifiedWorkSubject('Cursor rules for the billing service'), false)
  // Generic agent words inside a real subject survive.
  assert.equal(isDisqualifiedWorkSubject('Designing the interpretation agent'), false)
})
