import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { IPC } from '../src/shared/types.ts'
import { codexMemoryRoot, memoryMirrorRoot, writeDayMemory } from '../src/main/services/memoryMirror.ts'

// The service module itself imports electron, so it is exercised through the
// renderer/main contract and its pure collaborators rather than loaded here.

test('the mirror channels are declared on the IPC contract', () => {
  assert.deepEqual(Object.keys(IPC.MEMORY_MIRROR).sort(), [
    'DELETE',
    'LIST',
    'REVEAL',
    'ROOT',
    'SYNC',
  ])
  for (const channel of Object.values(IPC.MEMORY_MIRROR)) {
    assert.match(channel, /^memory-mirror:/)
  }
})

test('the mirror lives inside the app data directory', () => {
  const root = memoryMirrorRoot('/data/Daylens')
  assert.ok(root.startsWith('/data/Daylens'), `${root} escaped the app data directory`)
})

test('the codex export targets an extension directory Daylens owns', () => {
  const root = codexMemoryRoot({ CODEX_HOME: '/codex' } as NodeJS.ProcessEnv, '/home/x')
  assert.ok(root.endsWith(path.join('memories', 'extensions', 'daylens')))
  assert.ok(!root.includes('skysight'))
})

test('turning the codex export off leaves the daylens copy intact', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'daylens-mirror-svc-'))
  const mirrorRoot = path.join(root, 'memories')
  const codexRoot = path.join(root, 'codex')

  const input = {
    date: '2026-08-14',
    generatedAtMs: Date.parse('2026-08-14T10:00:00.000Z'),
    timezone: 'UTC',
    trackedSeconds: 600,
    blocks: [],
    apps: [],
    entities: [],
    narrative: null,
  }

  await writeDayMemory(input, { mirrorRoot, codexRoot })
  assert.ok(await fs.stat(path.join(codexRoot, '2026-08-14.md')))

  // A later write with the export disabled must not remove what it already
  // wrote, and must keep the app's own copy current.
  await writeDayMemory({ ...input, trackedSeconds: 900 }, { mirrorRoot, codexRoot: null })
  const mirrored = await fs.readFile(path.join(mirrorRoot, '2026-08-14.md'), 'utf8')
  assert.match(mirrored, /tracked_seconds: 900/)
  assert.ok(await fs.stat(path.join(codexRoot, '2026-08-14.md')))

  await fs.rm(root, { recursive: true, force: true })
})
