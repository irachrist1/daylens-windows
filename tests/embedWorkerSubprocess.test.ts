// End-to-end proof that the embed-worker subprocess loads the pinned model
// and serves embed requests over fork IPC — the transport the Electron main
// process uses so ONNX inference never runs on the UI thread. Runs only where
// the model artifact is present (downloaded asset, not committed).
import test from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import path from 'node:path'
import {
  semanticModelAssetStatus,
  semanticModelCacheDir,
  SEMANTIC_EMBEDDING_DIMS,
  SEMANTIC_MODEL_ID,
} from '../src/main/services/semanticEmbedder.ts'

const projectRoot = path.resolve(__dirname, '..')

interface WorkerReply {
  id?: number
  ok?: boolean
  result?: {
    ok?: boolean
    model?: string
    dims?: number
    vectors?: number[][]
  }
  error?: string
  op?: string
}

test('embed worker round-trip: status then embed', { timeout: 120_000 }, async (t) => {
  if (!semanticModelAssetStatus().present) {
    t.skip('pinned semantic model artifact not present')
    return
  }

  const worker = fork(
    path.join(projectRoot, 'packages', 'embed-worker', 'src', 'index.ts'),
    [],
    {
      execArgv: ['--loader', `file://${path.join(projectRoot, 'packages', 'mcp-server', 'loader.mjs')}`],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        DAYLENS_SEMANTIC_MODEL_DIR: semanticModelCacheDir(),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      serialization: 'json',
    },
  )

  const replies = new Map<number, (reply: WorkerReply) => void>()
  worker.on('message', (message: WorkerReply) => {
    if (typeof message?.id === 'number') replies.get(message.id)?.(message)
  })
  const request = (id: number, payload: Record<string, unknown>): Promise<WorkerReply> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`worker request ${id} timed out`)), 90_000)
      replies.set(id, (reply) => {
        clearTimeout(timer)
        resolve(reply)
      })
      worker.send({ id, ...payload })
    })

  try {
    const status = await request(1, { op: 'status' })
    assert.equal(status.ok, true, status.error)
    assert.equal(status.result?.ok, true)
    assert.ok(status.result?.model?.startsWith(SEMANTIC_MODEL_ID))
    assert.equal(status.result?.dims, SEMANTIC_EMBEDDING_DIMS)

    const embed = await request(2, { op: 'embed', texts: ['Warp — daylens — session', 'Obsidian — notes'] })
    assert.equal(embed.ok, true, embed.error)
    const vectors = embed.result?.vectors
    assert.equal(vectors?.length, 2)
    for (const vector of vectors ?? []) {
      assert.equal(vector.length, SEMANTIC_EMBEDDING_DIMS)
      const norm = Math.sqrt(vector.reduce((acc, v) => acc + v * v, 0))
      assert.ok(Math.abs(norm - 1) < 1e-3, `vector not normalized (|v| = ${norm})`)
    }
  } finally {
    worker.kill('SIGTERM')
  }
})
