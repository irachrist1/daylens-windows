// Embedding worker subprocess. ONNX inference is synchronous CPU work — run
// in the Electron main process it blocks the thread that draws the screen and
// services IPC, tracking, and capture (observed: multi-hour beachballs while
// onnxruntime ground through a badly padded batch). This worker owns the
// transformers.js pipeline instead: the main process sends texts over fork
// IPC and stays free no matter how long an inference call takes.
//
// Runs under ELECTRON_RUN_AS_NODE like the MCP server and range worker, with
// the same loader in dev and a vite bundle (dist/embed-worker) when packaged.
// The model directory arrives via DAYLENS_SEMANTIC_MODEL_DIR because the
// worker has no resourcesPath of its own.
import {
  loadSemanticEmbedder,
  type SemanticEmbedder,
} from '../../../src/main/services/semanticEmbedder'

interface WorkerRequest {
  id: number
  op: 'status' | 'embed'
  texts?: string[]
}

let embedder: SemanticEmbedder | null = null

async function handle(request: WorkerRequest): Promise<unknown> {
  switch (request.op) {
    case 'status': {
      const loaded = await loadSemanticEmbedder()
      if (!loaded.ok) return { ok: false, reason: loaded.reason, detail: loaded.detail }
      embedder = loaded.embedder
      return {
        ok: true,
        model: embedder.model,
        version: embedder.version,
        dims: embedder.dims,
      }
    }
    case 'embed': {
      if (!embedder) {
        const loaded = await loadSemanticEmbedder()
        if (!loaded.ok) throw new Error(`embedder unavailable: ${loaded.reason} — ${loaded.detail}`)
        embedder = loaded.embedder
      }
      const texts = request.texts ?? []
      const vectors = await embedder.embed(texts)
      return { vectors: vectors.map((vector) => Array.from(vector)) }
    }
    default:
      throw new Error(`Unknown op: ${String(request.op)}`)
  }
}

process.on('message', (message: WorkerRequest) => {
  if (!message || typeof message.id !== 'number') return
  handle(message).then(
    (result) => process.send?.({ id: message.id, ok: true, result }),
    (error: unknown) => process.send?.({
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  )
})

process.send?.({ op: 'ready' })
