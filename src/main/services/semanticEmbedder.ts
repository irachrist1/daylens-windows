// Local embedding model behind semantic search (DEV-180).
//
// The engine is the one DEV-179 chose and recorded in the memory
// specification (memory-and-entities.md §Chosen engine): the pinned
// Xenova/all-MiniLM-L6-v2 revision (384 dimensions, int8-quantized ONNX)
// running under transformers.js, with sqlite-vec as the vector index
// (src/main/services/semanticIndex.ts).
//
// Everything happens on this device. The runtime refuses remote model loads
// (`allowRemoteModels = false`, `local_files_only`), so a missing artifact
// means semantic search is honestly absent — never a network fetch at query
// time, never a remote embedding call. Exact and structured search are
// unaffected (spec §Failure behavior).
//
// The model artifact ships with the installer (spec: "first-run semantic
// search works offline"): `npm run models:semantic` downloads the pinned
// revision into resources/models/, and electron-builder copies it to
// <resources>/models. The artifact is NOT committed to git.
import fs from 'node:fs'
import path from 'node:path'

/** Pinned engine identity — must match the DEV-179 benchmark record. */
export const SEMANTIC_MODEL_ID = 'Xenova/all-MiniLM-L6-v2'
export const SEMANTIC_MODEL_REVISION = '751bff37182d3f1213fa05d7196b954e230abad9'
export const SEMANTIC_EMBEDDING_DIMS = 384
/** Bump to force re-embedding every record (input minimization changes,
 *  pooling changes, requantization — anything that changes vector meaning
 *  without changing the model id). */
export const SEMANTIC_EMBEDDING_VERSION = 1

export interface SemanticEmbedder {
  /** Stamped onto memory_records.embedding_model. */
  readonly model: string
  /** Stamped onto memory_records.embedding_version. */
  readonly version: number
  readonly dims: number
  /** Embed minimized factual texts into L2-normalized vectors. */
  embed(texts: readonly string[]): Promise<Float32Array[]>
}

export type SemanticEmbedderUnavailableReason =
  | 'model-missing'
  | 'runtime-missing'
  | 'load-failed'

export type SemanticEmbedderResult =
  | { ok: true; embedder: SemanticEmbedder }
  | { ok: false; reason: SemanticEmbedderUnavailableReason; detail: string }

/** Model files inside the transformers.js cache layout (the same layout the
 *  DEV-179 bench recorded sizes and hashes for). */
const MODEL_RELATIVE_FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/model_quantized.onnx',
]

/** Where the pinned model lives. Checked in order; the first directory that
 *  contains the pinned artifact wins. The env override is authoritative when
 *  set (tests and power users point at exactly one directory — a test
 *  simulating a missing model must not fall through to the repo checkout). */
function modelCacheDirCandidates(): string[] {
  if (process.env.DAYLENS_SEMANTIC_MODEL_DIR) {
    return [process.env.DAYLENS_SEMANTIC_MODEL_DIR]
  }
  const candidates: string[] = []
  // Packaged: extraResources copies resources/models → <resources>/models.
  // (Electron adds resourcesPath to process; typed loosely so this module
  // never needs the electron type surface — tests import it under plain Node.)
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (resourcesPath) {
    candidates.push(path.join(resourcesPath, 'models'))
  }
  // Dev / repo checkout (main.js builds into .vite/build/, two levels down).
  candidates.push(path.join(__dirname, '..', '..', 'resources', 'models'))
  candidates.push(path.join(process.cwd(), 'resources', 'models'))
  return candidates
}

export function semanticModelCacheDir(): string {
  const candidates = modelCacheDirCandidates()
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, ...SEMANTIC_MODEL_ID.split('/')))) return candidate
  }
  return candidates[0] ?? path.join(process.cwd(), 'resources', 'models')
}

export interface SemanticModelAssetStatus {
  present: boolean
  /** Total bytes of the model files when present. */
  bytes: number
  directory: string
}

/** Is the pinned artifact on disk, and how big is it? (Settings shows this.) */
export function semanticModelAssetStatus(): SemanticModelAssetStatus {
  const directory = semanticModelCacheDir()
  const root = path.join(directory, ...SEMANTIC_MODEL_ID.split('/'), SEMANTIC_MODEL_REVISION)
  let bytes = 0
  for (const relative of MODEL_RELATIVE_FILES) {
    const filePath = path.join(root, relative)
    if (!fs.existsSync(filePath)) return { present: false, bytes: 0, directory }
    bytes += fs.statSync(filePath).size
  }
  return { present: true, bytes, directory }
}

// Rollup rewrites `import()` of externals into require() in the CJS main
// bundle, which cannot load the ESM-only transformers.js. This keeps a real
// dynamic import at runtime.
const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>

let loadPromise: Promise<SemanticEmbedderResult> | null = null
let testFactory: (() => SemanticEmbedderResult | Promise<SemanticEmbedderResult>) | null = null

/** Test seam: substitute a fixture embedder (or a failure) for the real
 *  model pipeline. Pass null to restore the real loader. */
export function setSemanticEmbedderFactoryForTests(
  factory: (() => SemanticEmbedderResult | Promise<SemanticEmbedderResult>) | null,
): void {
  testFactory = factory
  loadPromise = null
}

async function loadReal(): Promise<SemanticEmbedderResult> {
  const asset = semanticModelAssetStatus()
  if (!asset.present) {
    return {
      ok: false,
      reason: 'model-missing',
      detail: `Pinned model artifact not found under ${asset.directory} — run \`npm run models:semantic\` (or reinstall Daylens) to restore it.`,
    }
  }

  let transformers: Record<string, unknown>
  try {
    transformers = await dynamicImport('@huggingface/transformers')
  } catch (error) {
    return {
      ok: false,
      reason: 'runtime-missing',
      detail: `transformers.js is not loadable in this runtime: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  try {
    const env = transformers.env as { allowRemoteModels: boolean; cacheDir: string }
    env.allowRemoteModels = false
    env.cacheDir = asset.directory
    const pipeline = transformers.pipeline as (
      task: string,
      model: string,
      options: Record<string, unknown>,
    ) => Promise<
      ((texts: readonly string[], options: Record<string, unknown>) => Promise<{
        data: Float32Array
        dispose?: () => void
      }>)
    >
    // Same load parameters as the decision benchmark: int8 quantized ONNX,
    // pinned revision, strictly local files.
    const extractor = await pipeline('feature-extraction', SEMANTIC_MODEL_ID, {
      dtype: 'q8',
      revision: SEMANTIC_MODEL_REVISION,
      local_files_only: true,
    })
    const embedder: SemanticEmbedder = {
      model: `${SEMANTIC_MODEL_ID}@${SEMANTIC_MODEL_REVISION}`,
      version: SEMANTIC_EMBEDDING_VERSION,
      dims: SEMANTIC_EMBEDDING_DIMS,
      async embed(texts) {
        if (texts.length === 0) return []
        // MiniLM uses mean pooling; normalize so cosine distance is exact.
        const tensor = await extractor(texts, { pooling: 'mean', normalize: true })
        const vectors: Float32Array[] = []
        for (let index = 0; index < texts.length; index += 1) {
          const offset = index * SEMANTIC_EMBEDDING_DIMS
          vectors.push(new Float32Array(tensor.data.slice(offset, offset + SEMANTIC_EMBEDDING_DIMS)))
        }
        tensor.dispose?.()
        return vectors
      },
    }
    return { ok: true, embedder }
  } catch (error) {
    return {
      ok: false,
      reason: 'load-failed',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Load (and cache) the local embedder. Never throws — semantic search is
 *  honestly absent when this reports !ok, and exact search never notices. */
export function loadSemanticEmbedder(): Promise<SemanticEmbedderResult> {
  if (loadPromise) return loadPromise
  const attempt = (testFactory ? Promise.resolve().then(testFactory) : loadReal()).then(
    (result) => {
      // Cache success and hard failures; a missing artifact may be restored
      // while the app runs, so that case re-checks on the next call (the
      // check is a handful of fs.existsSync calls, not a model load).
      if (!result.ok && result.reason === 'model-missing' && loadPromise === attempt) {
        loadPromise = null
      }
      return result
    },
    (error): SemanticEmbedderResult => {
      if (loadPromise === attempt) loadPromise = null
      return {
        ok: false,
        reason: 'load-failed',
        detail: error instanceof Error ? error.message : String(error),
      }
    },
  )
  loadPromise = attempt
  return attempt
}
