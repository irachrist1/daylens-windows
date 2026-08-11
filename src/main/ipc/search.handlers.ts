import { ipcMain } from 'electron'
import { getDb } from '../services/database'
import {
  searchArtifacts,
  searchBlocks,
  searchBrowser,
  searchSessions,
  type SearchOptions,
} from '../db/queries'
import { searchNatural } from '../services/naturalSearch'
import { searchExact } from '../services/exactSearch'
import { getSemanticSearchStatus, searchByMeaning } from '../services/semanticIndex'
import { ensureDayMemoryIndexed } from '../services/memoryIndex'
import { planRetrieval } from '../services/retrievalPlanner'
import { localDateString } from '../lib/localDate'

const SEARCH_CHANNELS = {
  UNIFIED: 'search:unified',
  ALL: 'search:all',
  SESSIONS: 'search:sessions',
  BLOCKS: 'search:blocks',
  BROWSER: 'search:browser',
  ARTIFACTS: 'search:artifacts',
  NATURAL: 'search:natural',
  SEMANTIC: 'search:semantic',
  SEMANTIC_STATUS: 'search:semanticStatus',
} as const

function normalizePayload(payload: { query?: string; opts?: SearchOptions } | string): {
  query: string
  opts: SearchOptions
} {
  if (typeof payload === 'string') {
    return { query: payload, opts: {} }
  }
  return {
    query: payload?.query ?? '',
    opts: payload?.opts ?? {},
  }
}

function freshenLiveDayIndex(): void {
  try {
    ensureDayMemoryIndexed(getDb(), localDateString())
  } catch (error) {
    console.error('[search] live-day index refresh failed', error)
  }
}

export function registerSearchHandlers(): void {
  // The unified boundary: one query and one filter scope in, one reconciled and
  // ranked result set out. The single-path channels below stay registered
  // because live surfaces still call them; they return raw per-path rows.
  ipcMain.handle(SEARCH_CHANNELS.UNIFIED, (_event, payload: { query?: string; opts?: SearchOptions } | string) => {
    const { query, opts } = normalizePayload(payload)
    return planRetrieval(getDb(), query, opts)
  })

  // DEV-178: the palette's shared query is the exact retrieval path —
  // entities (alias-aware) + corrected memory records + FTS, one ranked list.
  ipcMain.handle(SEARCH_CHANNELS.ALL, (_event, payload: { query?: string; opts?: SearchOptions } | string) => {
    const { query, opts } = normalizePayload(payload)
    return searchExact(getDb(), query, opts)
  })

  ipcMain.handle(SEARCH_CHANNELS.SESSIONS, (_event, payload: { query?: string; opts?: SearchOptions } | string) => {
    const { query, opts } = normalizePayload(payload)
    freshenLiveDayIndex()
    return searchSessions(getDb(), query, opts)
  })

  ipcMain.handle(SEARCH_CHANNELS.BLOCKS, (_event, payload: { query?: string; opts?: SearchOptions } | string) => {
    const { query, opts } = normalizePayload(payload)
    return searchBlocks(getDb(), query, opts)
  })

  ipcMain.handle(SEARCH_CHANNELS.BROWSER, (_event, payload: { query?: string; opts?: SearchOptions } | string) => {
    const { query, opts } = normalizePayload(payload)
    return searchBrowser(getDb(), query, opts)
  })

  ipcMain.handle(SEARCH_CHANNELS.ARTIFACTS, (_event, payload: { query?: string; opts?: SearchOptions } | string) => {
    const { query, opts } = normalizePayload(payload)
    return searchArtifacts(getDb(), query, opts)
  })

  // S1: natural-language search (provider-interpreted terms over FTS).
  ipcMain.handle(SEARCH_CHANNELS.NATURAL, (_event, payload: { query?: string; opts?: SearchOptions } | string) => {
    const { query, opts } = normalizePayload(payload)
    return searchNatural(query, opts)
  })

  // DEV-180: by-meaning retrieval — the query embeds locally and k-NNs over
  // the embedded memory records. Purely additive next to the exact path: []
  // whenever the local model, extension, or index is unavailable.
  ipcMain.handle(SEARCH_CHANNELS.SEMANTIC, (_event, payload: { query?: string; opts?: SearchOptions } | string) => {
    const { query, opts } = normalizePayload(payload)
    return searchByMeaning(getDb(), query, opts)
  })

  // Settings: local model + index status ("what runs on this device").
  ipcMain.handle(SEARCH_CHANNELS.SEMANTIC_STATUS, () => getSemanticSearchStatus(getDb()))
}
