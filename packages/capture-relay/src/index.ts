// Capture relay subprocess (DEV-262). Before this existed, the capture
// helper's events sat in an in-memory pipe waiting for the main process to
// drain them — a frozen or killed app lost hours of the user's day (July 22:
// two morning stretches gone permanently). The relay owns the helper instead:
// every observed event is gated and appended to an on-disk spool the moment
// it arrives, so the app being frozen, crashed, or force-killed loses at
// most the current write buffer (≲250 ms), never hours. The main process
// tails the spool at its leisure and ingests with original timestamps.
//
// PRIVACY INVARIANT: the full capture gate (consent, incognito, app/site
// exclusions, system noise, browser-content strip) runs HERE, before any
// byte reaches disk. A gated event never exists in the spool. Until the
// parent sends the current tracking controls, nothing is written.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { gateHelperLine } from '../../../src/main/services/captureEventGate'
import type { TrackingControlsState } from '../../../src/shared/trackingControls'

const FLUSH_INTERVAL_MS = 250
const PRE_CONTROLS_BUFFER_LIMIT = 10_000
const SHUTDOWN_KILL_DELAY_MS = 1_500

const helperPath = process.env.DAYLENS_CAPTURE_HELPER_PATH
const spoolDir = process.env.DAYLENS_CAPTURE_SPOOL_DIR
const helperArgs: string[] = process.env.DAYLENS_CAPTURE_HELPER_ARGS
  ? JSON.parse(process.env.DAYLENS_CAPTURE_HELPER_ARGS) as string[]
  : []

if (!helperPath || !spoolDir) {
  console.error('[capture-relay] DAYLENS_CAPTURE_HELPER_PATH and DAYLENS_CAPTURE_SPOOL_DIR are required')
  process.exit(2)
}

fs.mkdirSync(spoolDir, { recursive: true })

let controls: TrackingControlsState | null = null
// Lines seen before the first controls snapshot: held in memory (bounded),
// gated and spooled the moment controls arrive. Never written pre-gate.
let preControlsBuffer: string[] = []
let writeBuffer: string[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
let stopping = false
let helper: ChildProcessWithoutNullStreams | null = null

function spoolFileForNow(): string {
  const now = new Date()
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return path.join(spoolDir!, `spool-${stamp}.ndjson`)
}

function flushWriteBuffer(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (writeBuffer.length === 0) return
  const batch = writeBuffer
  writeBuffer = []
  try {
    fs.appendFileSync(spoolFileForNow(), batch.join('\n') + '\n')
  } catch (err) {
    // Losing a batch to a disk error must be loud — durability is this
    // process's entire job.
    console.error('[capture-relay] spool append failed:', err)
  }
}

function handleLine(line: string): void {
  if (!controls) {
    if (preControlsBuffer.length < PRE_CONTROLS_BUFFER_LIMIT) preControlsBuffer.push(line)
    return
  }
  const gated = gateHelperLine(line, controls)
  if (!gated) return
  writeBuffer.push(JSON.stringify(gated))
  if (!flushTimer) {
    flushTimer = setTimeout(flushWriteBuffer, FLUSH_INTERVAL_MS)
  }
}

function spawnHelper(): void {
  let proc: ChildProcessWithoutNullStreams
  try {
    proc = spawn(helperPath!, helperArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    })
  } catch (err) {
    console.error('[capture-relay] helper spawn failed:', err)
    process.exit(1)
    return
  }
  helper = proc

  let buffer = ''
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', (chunk: string) => {
    buffer += chunk
    let nl = buffer.indexOf('\n')
    while (nl !== -1) {
      handleLine(buffer.slice(0, nl))
      buffer = buffer.slice(nl + 1)
      nl = buffer.indexOf('\n')
    }
  })

  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', (chunk: string) => {
    const msg = chunk.trim()
    if (msg) console.log('[capture-helper]', msg)
  })

  proc.on('error', (err) => {
    console.error('[capture-relay] helper process error:', err)
  })

  proc.on('exit', (code, signal) => {
    flushWriteBuffer()
    if (stopping) {
      process.exit(0)
      return
    }
    // The parent owns restart/backoff policy; report and die so a crashing
    // helper cannot loop unsupervised.
    process.send?.({ op: 'helper-exited', code, signal })
    process.exit(1)
  })
}

interface RelayMessage {
  op: 'controls' | 'shutdown'
  controls?: TrackingControlsState
}

process.on('message', (message: RelayMessage) => {
  if (!message || typeof message.op !== 'string') return
  if (message.op === 'controls' && message.controls) {
    const firstControls = controls === null
    controls = message.controls
    if (firstControls && preControlsBuffer.length > 0) {
      const held = preControlsBuffer
      preControlsBuffer = []
      for (const line of held) handleLine(line)
    }
    return
  }
  if (message.op === 'shutdown') {
    stopping = true
    try {
      helper?.stdin.write('shutdown\n')
      helper?.stdin.end()
    } catch {
      /* helper already gone */
    }
    setTimeout(() => {
      flushWriteBuffer()
      try {
        helper?.kill('SIGTERM')
      } catch {
        /* noop */
      }
      process.exit(0)
    }, SHUTDOWN_KILL_DELAY_MS).unref()
  }
})

// The parent disappearing (crash, force-kill) must not orphan the helper: a
// disconnected IPC channel means no one will ever send shutdown. Flush and
// exit; whatever was spooled is already safe on disk.
process.on('disconnect', () => {
  stopping = true
  try {
    helper?.stdin.write('shutdown\n')
    helper?.stdin.end()
  } catch {
    /* noop */
  }
  setTimeout(() => {
    flushWriteBuffer()
    try {
      helper?.kill('SIGTERM')
    } catch {
      /* noop */
    }
    process.exit(0)
  }, SHUTDOWN_KILL_DELAY_MS)
})

process.on('exit', () => {
  flushWriteBuffer()
})

spawnHelper()
process.send?.({ op: 'ready' })
