import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCLIProcessPayload, buildCLIProcessSpec } from '../src/main/services/cliLaunch.ts'

test('windows cmd shims are proxied through PowerShell without shell mode', () => {
  const spec = buildCLIProcessSpec(
    'C:\\Users\\tonny\\AppData\\Roaming\\npm\\codex.cmd',
    ['exec', '--model', 'gpt-5.4', 'hello & calc.exe'],
    'win32',
  )

  assert.equal(spec.command, 'powershell.exe')
  assert.equal(spec.shell, false)
  assert.equal(spec.usesJsonStdin, true)
  assert.ok(spec.args.includes('-Command'))
})

test('CLI payload round-trips dangerous prompt characters without shell escaping', () => {
  const prompt = 'line one & calc.exe\nline two "quoted" | whoami'
  const payload = buildCLIProcessPayload(
    'C:\\Users\\tonny\\AppData\\Roaming\\npm\\claude.cmd',
    ['-p', '--output-format', 'text', prompt],
  )

  assert.deepEqual(JSON.parse(payload), {
    executablePath: 'C:\\Users\\tonny\\AppData\\Roaming\\npm\\claude.cmd',
    args: ['-p', '--output-format', 'text', prompt],
  })
})

test('non-cmd executables keep direct spawn semantics', () => {
  const spec = buildCLIProcessSpec('/usr/local/bin/codex', ['exec', 'status'], 'darwin')

  assert.equal(spec.command, '/usr/local/bin/codex')
  assert.equal(spec.shell, false)
  assert.equal(spec.usesJsonStdin, false)
  assert.deepEqual(spec.args, ['exec', 'status'])
})
