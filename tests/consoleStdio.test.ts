// The crash loop this prevents: Daylens started from a terminal writes its logs
// to that terminal's pty. Close the terminal window and every later write fails
// with EIO, which Node raises as an uncaught exception one tick after the write
// — past console's own error-swallowing. The crash handler's first act was to
// log the crash, which wrote to the same dead stream and re-entered the handler,
// so the "Daylens crashed — Error: write EIO" dialog came back every time it was
// dismissed and force-quitting was the only way out.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { installConsoleStdioGuards, isStreamWriteError } from '../src/shared/consoleStdio.ts'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function streamError(syscall: string, code: string): Error {
  return Object.assign(new Error(`${syscall} ${code}`), { syscall, code })
}

test('the guard adds exactly one error listener per stream, however often it runs', () => {
  const before = {
    stdout: process.stdout.listenerCount('error'),
    stderr: process.stderr.listenerCount('error'),
  }

  installConsoleStdioGuards()
  assert.equal(process.stdout.listenerCount('error'), before.stdout + 1)
  assert.equal(process.stderr.listenerCount('error'), before.stderr + 1)

  installConsoleStdioGuards()
  assert.equal(process.stdout.listenerCount('error'), before.stdout + 1)
  assert.equal(process.stderr.listenerCount('error'), before.stderr + 1)
})

test('a guarded stream delivers its error instead of throwing it', () => {
  installConsoleStdioGuards()
  assert.doesNotThrow(() => process.stderr.emit('error', streamError('write', 'EIO')))
  assert.doesNotThrow(() => process.stdout.emit('error', streamError('write', 'EPIPE')))
})

test('losing somewhere to print is not a crash', () => {
  assert.equal(isStreamWriteError(streamError('write', 'EIO')), true)
  assert.equal(isStreamWriteError(streamError('write', 'EPIPE')), true)
})

test('anything else still is a crash', () => {
  assert.equal(isStreamWriteError(streamError('read', 'EIO')), false)
  assert.equal(isStreamWriteError(streamError('connect', 'ECONNREFUSED')), false)
  assert.equal(isStreamWriteError(new RangeError('Maximum call stack size exceeded')), false)
  assert.equal(isStreamWriteError(new Error('write EIO')), false)
  assert.equal(isStreamWriteError('write EIO'), false)
  assert.equal(isStreamWriteError(null), false)
})

/** Runs the fixture with its stdio piped, waits until it is chattering, then
 *  takes away the read ends — the terminal closing, in a form a test can
 *  create without a pty. Returns what the child managed to record. */
async function runWithStdioTakenAway(mode: 'guarded' | 'unguarded'): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-stdio-guard-'))
  const reportPath = path.join(dir, 'report.txt')
  fs.writeFileSync(reportPath, '')

  const child = spawn(process.execPath, [
    '--loader',
    `file://${path.join(projectRoot, 'tests', 'support', 'ts-loader.mjs')}`,
    path.join(projectRoot, 'tests', 'support', 'stdio-guard-child.ts'),
    mode,
    reportPath,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })

  const exited = once(child, 'exit')
  const deadline = Date.now() + 30_000
  while (!fs.readFileSync(reportPath, 'utf8').includes('ready')) {
    if (Date.now() > deadline) {
      child.kill('SIGKILL')
      throw new Error(`fixture never became ready (${mode})`)
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  child.stdout?.destroy()
  child.stderr?.destroy()
  await exited

  return fs.readFileSync(reportPath, 'utf8').trim().split('\n').slice(1).join('\n')
}

test('a process outlives the stdio it was logging to, but only when guarded', async () => {
  assert.equal(await runWithStdioTakenAway('unguarded'), 'uncaught write EPIPE')
  assert.equal(await runWithStdioTakenAway('guarded'), 'survived')
})
