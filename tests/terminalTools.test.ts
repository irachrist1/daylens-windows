// run_command contract: policy gate outside the model (terminalAccessEnabled,
// default FALSE), allowlist-first argv with named destructive refusals, cwd
// pinned to home/model-readable-grant roots, path-like ARGUMENTS pinned inside
// the resolved cwd, first-use consent through the permission card (serialized,
// per-thread, revoked on toggle-off), and a disclosure-ledger row for every
// executed call — no ledger, no execution.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { __resetSettings, __setSettings } from './support/settings-stub.mjs'
import {
  buildTerminalTools,
  checkTerminalArgv,
  checkPathArguments,
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
  const db = createProductionTestDatabase()
  let prompted = 0
  const tools = buildTerminalTools({
    db,
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
    // ps can dump other processes' environments (ps -E); env dumps this one.
    { command: 'ps', args: ['-E'] },
    { command: 'ps', args: [] },
    { command: 'env', args: [] },
    { command: 'printenv', args: [] },
    // branch mutations: delete, rename, force-move, upstream rewiring.
    { command: 'git', args: ['branch', '-D', 'main'] },
    { command: 'git', args: ['branch', '-M', 'main', 'other'] },
    { command: 'git', args: ['branch', '-f', 'main', 'HEAD~1'] },
    { command: 'git', args: ['branch', '--set-upstream-to=origin/x'] },
  ]) {
    const result = await run(tools, { ...argv, cwd: home })
    assert.equal(result.found, false, `${argv.command} ${argv.args.join(' ')} must be refused`)
  }
  assert.equal(prompted, 0, 'refused argv never reaches the consent card')
  db.close()
})

test('checkTerminalArgv allows the read-only surface it advertises', () => {
  assert.equal(checkTerminalArgv('ls', ['-la']).ok, true)
  assert.equal(checkTerminalArgv('git', ['log', '--oneline']).ok, true)
  assert.equal(checkTerminalArgv('git', ['status']).ok, true)
  assert.equal(checkTerminalArgv('node', ['--version']).ok, true)
  assert.equal(checkTerminalArgv('npm', ['ls']).ok, true)
  assert.equal(checkTerminalArgv('npm', ['exec', 'evil']).ok, false)
  assert.equal(checkTerminalArgv('git', ['log', '--output=/tmp/x']).ok, false)
  assert.equal(checkTerminalArgv('ps', ['aux']).ok, false)
})

test('git branch is forced to --list mode; a bare "git branch <name>" can never create a branch', async () => {
  // The argv rewrite is the policy: whatever the model passes, the executed
  // argv carries --list right after the subcommand.
  const rewritten = checkTerminalArgv('git', ['branch', 'evil-new-branch'])
  assert.equal(rewritten.ok, true)
  assert.deepEqual((rewritten as { ok: true; argv: string[] }).argv, ['branch', '--list', 'evil-new-branch'])
  assert.equal(checkTerminalArgv('git', ['branch', '-D', 'x']).ok, false)
  assert.equal(checkTerminalArgv('git', ['branch', '--delete', 'x']).ok, false)

  // And end to end: in a real repo, "git branch evil" lists (nothing) instead
  // of creating the branch.
  __setSettings({ terminalAccessEnabled: true })
  const home = tempHome()
  const repo = path.join(home, 'repo')
  fs.mkdirSync(repo)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  git('init', '-q')
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '--allow-empty', '-m', 'seed')
  const db = createProductionTestDatabase()
  const tools = buildTerminalTools({ db, homeDir: home, requestTerminalAccess: async () => 'allow_session' })

  const result = await run(tools, { command: 'git', args: ['branch', 'evil-branch'], cwd: repo })
  assert.equal(result.found, true)
  assert.deepEqual(result.args, ['branch', '--list', 'evil-branch'])
  const branches = execFileSync('git', ['branch', '--list', 'evil-branch'], { cwd: repo }).toString()
  assert.equal(branches.trim(), '', 'the branch must not have been created')
  db.close()
})

test('path-like arguments must resolve inside the working directory', async () => {
  __setSettings({ terminalAccessEnabled: true })
  const home = tempHome()
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-terminal-outside-'))
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret\n')
  const db = createProductionTestDatabase()
  const tools = buildTerminalTools({ db, homeDir: home, requestTerminalAccess: async () => 'allow_session' })

  for (const argv of [
    { command: 'cat', args: ['/etc/hosts'] },
    { command: 'cat', args: [path.join(outside, 'secret.txt')] },
    { command: 'cat', args: [`../${path.basename(outside)}/secret.txt`] },
    { command: 'grep', args: ['-r', 'x', outside] },
    { command: 'cat', args: ['~/secret.txt'] },
    { command: 'head', args: [`${home}/../../etc/hosts`] },
  ]) {
    const result = await run(tools, { ...argv, cwd: home })
    assert.equal(result.found, false, `${argv.command} ${argv.args.join(' ')} must be refused`)
    assert.match(result.reason, /working directory|granted workspace|not accepted/)
  }

  // In-workspace paths and non-path args still work.
  const inWorkspace = await run(tools, { command: 'cat', args: ['hello.txt'], cwd: home })
  assert.equal(inWorkspace.found, true)
  assert.match(inWorkspace.stdout, /hello from daylens/)
  const dot = await run(tools, { command: 'grep', args: ['-r', 'daylens', '.'], cwd: home })
  assert.equal(dot.found, true)
  fs.rmSync(outside, { recursive: true, force: true })
  db.close()
})

test('checkPathArguments passes flags and patterns, pins everything path-shaped', async () => {
  const home = tempHome()
  const real = fs.realpathSync(home)
  assert.equal((await checkPathArguments(['-la', '--color=never', 'TODO'], real)).ok, true)
  assert.equal((await checkPathArguments(['hello.txt'], real)).ok, true)
  assert.equal((await checkPathArguments(['/etc/hosts'], real)).ok, false)
  assert.equal((await checkPathArguments(['../elsewhere'], real)).ok, false)
  assert.equal((await checkPathArguments(['~/x'], real)).ok, false)
})

test('first use asks on the permission card; deny runs nothing; a session allow covers later calls', async () => {
  __setSettings({ terminalAccessEnabled: true })
  const home = tempHome()
  const db = createProductionTestDatabase()
  const answers: Array<'deny' | 'allow_session'> = ['deny', 'allow_session']
  const prompts: string[] = []
  const deps = {
    db,
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
  db.close()
})

test('toggling terminal access off revokes a session approval; re-enabling asks again', async () => {
  __setSettings({ terminalAccessEnabled: true })
  const home = tempHome()
  const db = createProductionTestDatabase()
  let prompts = 0
  const deps = {
    db,
    homeDir: home,
    requestTerminalAccess: async () => { prompts += 1; return 'allow_session' as const },
  }
  const tools = buildTerminalTools(deps)

  const first = await run(tools, { command: 'ls', cwd: home })
  assert.equal(first.found, true)
  assert.equal(prompts, 1)

  // Off: refused, and the stored session approval is cleared.
  __setSettings({ terminalAccessEnabled: false })
  const off = await run(tools, { command: 'ls', cwd: home })
  assert.equal(off.found, false)

  // Back on: the old "allow for this session" must NOT survive the toggle.
  __setSettings({ terminalAccessEnabled: true })
  const again = await run(buildTerminalTools(deps), { command: 'ls', cwd: home })
  assert.equal(again.found, true)
  assert.equal(prompts, 2, 're-enabling the setting requires fresh consent')
  db.close()
})

test('a session approval is keyed to its chat thread, never shared across threads', async () => {
  __setSettings({ terminalAccessEnabled: true })
  const home = tempHome()
  const db = createProductionTestDatabase()
  let prompts = 0
  const promptDeps = {
    db,
    homeDir: home,
    requestTerminalAccess: async () => { prompts += 1; return 'allow_session' as const },
  }

  const threadOne = buildTerminalTools({ ...promptDeps, threadId: 1 })
  assert.equal((await run(threadOne, { command: 'ls', cwd: home })).found, true)
  assert.equal(prompts, 1)

  // The same thread on a later turn: no new prompt.
  const threadOneLater = buildTerminalTools({ ...promptDeps, threadId: 1 })
  assert.equal((await run(threadOneLater, { command: 'ls', cwd: home })).found, true)
  assert.equal(prompts, 1)

  // A DIFFERENT thread must ask its own consent.
  const threadTwo = buildTerminalTools({ ...promptDeps, threadId: 2 })
  assert.equal((await run(threadTwo, { command: 'ls', cwd: home })).found, true)
  assert.equal(prompts, 2, 'thread 2 cannot ride thread 1\'s session approval')
  db.close()
})

test('parallel consent requests are serialized — one card at a time', async () => {
  __setSettings({ terminalAccessEnabled: true })
  const home = tempHome()
  const db = createProductionTestDatabase()
  let active = 0
  let maxActive = 0
  let prompts = 0
  const tools = buildTerminalTools({
    db,
    homeDir: home,
    requestTerminalAccess: async () => {
      prompts += 1
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 25))
      active -= 1
      return 'allow_once'
    },
  })

  const [first, second] = await Promise.all([
    run(tools, { command: 'ls', cwd: home }),
    run(tools, { command: 'pwd', cwd: home }),
  ])
  assert.equal(first.found, true)
  assert.equal(second.found, true)
  assert.equal(prompts, 2, 'each allow_once covers exactly one call')
  assert.equal(maxActive, 1, 'consent cards must never overlap')
  db.close()
})

test('without a prompt channel the tool refuses with permissionRequired instead of running silently', async () => {
  __setSettings({ terminalAccessEnabled: true })
  const home = tempHome()
  const db = createProductionTestDatabase()
  const tools = buildTerminalTools({ db, homeDir: home })
  const result = await run(tools, { command: 'ls', cwd: home })
  assert.equal(result.found, false)
  assert.equal(result.permissionRequired, true)
  db.close()
})

test('cwd outside the home dir and grant roots is refused; a model-readable grant root is accepted; an indexed grant is NOT', async () => {
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

  // An INDEXED grant covers local extraction, never model disclosure — and
  // command output is disclosure. It must not unlock the cwd.
  const indexed = addFileAccessGrant(db, { scopeKind: 'folder', path: outside, state: 'indexed' })
  const stillRefused = await run(tools, { command: 'ls', cwd: outside })
  assert.equal(stillRefused.found, false, 'an indexed grant must not make a cwd runnable')

  addFileAccessGrant(db, { scopeKind: 'folder', path: outside, state: 'model_readable' })
  const allowed = await run(tools, { command: 'ls', cwd: outside })
  assert.equal(allowed.found, true)
  assert.match(allowed.stdout, /granted\.txt/)
  void indexed
  db.close()
})

test('every executed call records a disclosure-ledger row naming the command line, before the output returns', async () => {
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
  assert.equal(rows[0].display_name, 'ls -la', 'the disclosed artifact is the command line, not a directory basename')
  assert.match(rows[0].reason, /run_command: ls -la/)
  assert.match(rows[0].reason, /checking which files exist in the project folder/)
  assert.equal(rows[0].destination, 'anthropic:test-model')
  assert.equal(observed.length, 1, 'the turn observes the disclosure for its citations')
  db.close()
})

test('no disclosure ledger means no execution — disclosure-before-output is a guarantee', async () => {
  __setSettings({ terminalAccessEnabled: true })
  const home = tempHome()
  let prompted = 0
  const noDb = buildTerminalTools({
    homeDir: home,
    requestTerminalAccess: async () => { prompted += 1; return 'allow_session' },
  })
  const refused = await run(noDb, { command: 'cat', args: ['hello.txt'], cwd: home })
  assert.equal(refused.found, false)
  assert.match(refused.reason, /disclosure/i)
  assert.equal(refused.stdout, undefined, 'no output may leak without a ledger')
  assert.equal(prompted, 0, 'a call that cannot run never asks for consent')
})

test('a failed ledger write withholds the output', async () => {
  __setSettings({ terminalAccessEnabled: true })
  const home = tempHome()
  const db = createProductionTestDatabase()
  db.exec('DROP TABLE file_disclosures')
  const tools = buildTerminalTools({
    db,
    homeDir: home,
    requestTerminalAccess: async () => 'allow_session',
  })
  const result = await run(tools, { command: 'cat', args: ['hello.txt'], cwd: home })
  assert.equal(result.found, false)
  assert.match(result.reason, /disclosure/i)
  assert.equal(result.stdout, undefined, 'output is withheld when the ledger write fails')
  db.close()
})

test('output beyond 64KB returns the partial stdout as found with truncated:true', async () => {
  __setSettings({ terminalAccessEnabled: true })
  const home = tempHome()
  fs.writeFileSync(path.join(home, 'big.txt'), 'x'.repeat(200 * 1024))
  const db = createProductionTestDatabase()
  const tools = buildTerminalTools({
    db,
    homeDir: home,
    requestTerminalAccess: async () => 'allow_session',
  })
  const result = await run(tools, { command: 'cat', args: ['big.txt'], cwd: home })
  assert.equal(result.found, true, 'a maxBuffer overflow is a truncation, not a failure')
  assert.equal(result.truncated, true)
  const output = String(result.stdout ?? '')
  assert.ok(output.length > 0, 'the partial output is returned')
  assert.ok(output.length <= 64 * 1024, `output must be capped, got ${output.length}`)
  db.close()
})
