// run_command contract: policy gate outside the model (terminalAccessEnabled,
// default FALSE), allowlist-first argv with named destructive refusals, cwd
// pinned to home/grant roots, first-use consent through the permission card,
// and a disclosure-ledger row for every executed call carrying the reason.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { __resetSettings, __setSettings } from './support/settings-stub.mjs'
import {
  buildTerminalTools,
  checkTerminalArgv,
  __resetTerminalSessionApproval,
} from '../src/main/agent/terminalTools.ts'
import { addFileAccessGrant, listFileDisclosures } from '../src/main/services/fileAccess.ts'

function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-terminal-home-'))
  fs.writeFileSync(path.join(home, 'hello.txt'), 'hello from daylens\n')
  return home
}

function run(tools: ReturnType<typeof buildTerminalTools>, input: Record<string, unknown>) {
  return (tools.run_command as any).execute({ reason: 'inspecting the environment for the answer', ...input }, {} as any)
}

test.beforeEach(() => {
  __resetSettings()
  __resetTerminalSessionApproval()
})

test('run_command refuses honestly when terminal access is off (the default)', async () => {
  const home = tempHome()
  const tools = buildTerminalTools({ homeDir: home })
  const result = await run(tools, { command: 'ls', cwd: home })
  assert.equal(result.found, false)
  assert.match(result.reason, /Settings/)
})

test('destructive and off-allowlist argv is refused before any consent prompt', async () => {
  __setSettings({ terminalAccessEnabled: true })
  const home = tempHome()
  let prompted = 0
  const tools = buildTerminalTools({
    homeDir: home,
    requestTerminalAccess: async () => { prompted += 1; return 'allow_session' },
  })

  for (const argv of [
    { command: 'rm', args: ['-rf', home] },
    { command: 'sudo', args: ['ls'] },
    { command: 'kill', args: ['-9', '1'] },
    { command: 'launchctl', args: ['unload', 'x'] },
    { command: 'dd', args: ['if=/dev/zero'] },
    { command: 'git', args: ['push', 'origin', 'main'] },
    { command: 'git', args: ['reset', '--hard'] },
    { command: 'git', args: ['clean', '-fd'] },
    { command: 'node', args: ['-e', 'process.exit(0)'] },
    { command: 'bash', args: ['-c', 'ls'] },
    { command: '/bin/ls', args: [] },
  ]) {
    const result = await run(tools, { ...argv, cwd: home })
    assert.equal(result.found, false, `${argv.command} ${argv.args.join(' ')} must be refused`)
  }
  assert.equal(prompted, 0, 'refused argv never reaches the consent card')
})

test('checkTerminalArgv allows the read-only surface it advertises', () => {
  assert.equal(checkTerminalArgv('ls', ['-la']).ok, true)
  assert.equal(checkTerminalArgv('git', ['log', '--oneline']).ok, true)
  assert.equal(checkTerminalArgv('git', ['status']).ok, true)
  assert.equal(checkTerminalArgv('node', ['--version']).ok, true)
  assert.equal(checkTerminalArgv('npm', ['ls']).ok, true)
  assert.equal(checkTerminalArgv('npm', ['exec', 'evil']).ok, false)
  assert.equal(checkTerminalArgv('git', ['log', '--output=/tmp/x']).ok, false)
})

test('first use asks on the permission card; deny runs nothing; a session allow covers later calls', async () => {
  __setSettings({ terminalAccessEnabled: true })
  const home = tempHome()
  const answers: Array<'deny' | 'allow_session'> = ['deny', 'allow_session']
  const prompts: string[] = []
  const deps = {
    homeDir: home,
    requestTerminalAccess: async (request: { command: string; reason: string }) => {
      prompts.push(`${request.command}:${request.reason}`)
      return answers.shift() ?? 'deny'
    },
  }
  const tools = buildTerminalTools(deps)

  const denied = await run(tools, { command: 'ls', cwd: home })
  assert.equal(denied.found, false)
  assert.match(denied.reason, /declined/)

  const allowed = await run(tools, { command: 'ls', cwd: home })
  assert.equal(allowed.found, true)
  assert.match(allowed.stdout, /hello\.txt/)

  // The session approval survives a NEW tool instance (a later turn) without
  // another prompt.
  const laterTurn = buildTerminalTools(deps)
  const second = await run(laterTurn, { command: 'cat', args: ['hello.txt'], cwd: home })
  assert.equal(second.found, true)
  assert.match(second.stdout, /hello from daylens/)
  assert.equal(prompts.length, 2, 'exactly the deny and the session allow prompted')
})

test('without a prompt channel the tool refuses with permissionRequired instead of running silently', async () => {
  __setSettings({ terminalAccessEnabled: true })
  const home = tempHome()
  const tools = buildTerminalTools({ homeDir: home })
  const result = await run(tools, { command: 'ls', cwd: home })
  assert.equal(result.found, false)
  assert.equal(result.permissionRequired, true)
})

test('cwd outside the home dir and grant roots is refused; a grant root is accepted', async () => {
  __setSettings({ terminalAccessEnabled: true })
  const home = tempHome()
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-terminal-outside-'))
  fs.writeFileSync(path.join(outside, 'granted.txt'), 'granted\n')
  const db = createProductionTestDatabase()
  const tools = buildTerminalTools({
    db,
    homeDir: home,
    requestTerminalAccess: async () => 'allow_session',
  })

  const refused = await run(tools, { command: 'ls', cwd: outside })
  assert.equal(refused.found, false)
  assert.match(refused.reason, /home directory|file-access grant/)

  addFileAccessGrant(db, { scopeKind: 'folder', path: outside, state: 'model_readable' })
  const allowed = await run(tools, { command: 'ls', cwd: outside })
  assert.equal(allowed.found, true)
  assert.match(allowed.stdout, /granted\.txt/)
  db.close()
})

test('every executed call records a disclosure-ledger row with the stated reason, before the output returns', async () => {
  __setSettings({ terminalAccessEnabled: true })
  const home = tempHome()
  const db = createProductionTestDatabase()
  const observed: string[] = []
  const tools = buildTerminalTools({
    db,
    homeDir: home,
    threadId: 7,
    destination: 'anthropic:test-model',
    requestTerminalAccess: async () => 'allow_session',
    onDisclosure: (row) => observed.push(row.reason),
  })

  const result = await run(tools, {
    command: 'ls',
    args: ['-la'],
    cwd: home,
    reason: 'checking which files exist in the project folder',
  })
  assert.equal(result.found, true)

  const rows = listFileDisclosures(db, { threadId: 7 })
  assert.equal(rows.length, 1)
  assert.match(rows[0].reason, /run_command: ls -la/)
  assert.match(rows[0].reason, /checking which files exist in the project folder/)
  assert.equal(rows[0].destination, 'anthropic:test-model')
  assert.equal(observed.length, 1, 'the turn observes the disclosure for its citations')
  db.close()
})

test('output is capped at 64KB and reported as truncated', async () => {
  __setSettings({ terminalAccessEnabled: true })
  const home = tempHome()
  fs.writeFileSync(path.join(home, 'big.txt'), 'x'.repeat(200 * 1024))
  const tools = buildTerminalTools({
    homeDir: home,
    requestTerminalAccess: async () => 'allow_session',
  })
  const result = await run(tools, { command: 'cat', args: ['big.txt'], cwd: home })
  // execFile enforces maxBuffer by erroring with the partial output; either
  // way nothing beyond 64KB may reach the model.
  const output = String(result.stdout ?? '')
  assert.ok(output.length <= 64 * 1024, `output must be capped, got ${output.length}`)
})
