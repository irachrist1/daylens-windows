// Projects a materialized timeline day onto the memory-mirror input shape.
//
// Separate from memoryMirror.ts on purpose: the renderer stays a pure function
// over plain data with no knowledge of Daylens types, so it is testable without
// a database and stable if the timeline payload changes shape.
//
// The mirror reads the SAME corrected payload Timeline renders. It never
// queries app_sessions directly, so a deleted block or an excluded app is
// already gone before the file is written, and a correction reaches the file on
// the next write (capture-and-evidence.md §Corrections).
import type { DayTimelinePayload, WorkContextBlock } from '@shared/types'
import type { DayMemoryInput, MirrorApp, MirrorBlock } from './memoryMirror'

/** Blocks below this never carried a useful account of what happened, and a
 *  file full of one-minute entries buries the day for both readers. */
const MIN_BLOCK_SECONDS = 60

/** Provisional live blocks are named "Active now" and rename themselves as the
 *  day runs. Writing one would put a placeholder title into a file an agent
 *  treats as settled. */
function isWritable(block: WorkContextBlock): boolean {
  if (block.provisional || block.isLive) return false
  return Math.round((block.endTime - block.startTime) / 1000) >= MIN_BLOCK_SECONDS
}

function titleFor(block: WorkContextBlock): string {
  const label = block.label
  const candidate =
    label.override?.trim() ||
    label.current?.trim() ||
    block.aiLabel?.trim() ||
    label.ruleBased?.trim() ||
    block.ruleBasedLabel?.trim() ||
    ''
  return candidate || 'Untitled activity'
}

function narrativeFor(block: WorkContextBlock): string | null {
  const narrative = block.label.narrative?.trim()
  if (!narrative) return null
  // A narrative that merely repeats the title adds nothing to the file.
  return narrative === titleFor(block) ? null : narrative
}

function appNamesFor(block: WorkContextBlock, limit = 6): string[] {
  return [...block.topApps]
    .sort((a, b) => b.totalSeconds - a.totalSeconds || a.appName.localeCompare(b.appName))
    .map((app) => app.appName.trim())
    .filter((name) => name.length > 0)
    .filter((name, index, all) => all.indexOf(name) === index)
    .slice(0, limit)
}

function toMirrorBlock(block: WorkContextBlock): MirrorBlock {
  return {
    id: block.id,
    startMs: block.startTime,
    endMs: block.endTime,
    title: titleFor(block),
    narrative: narrativeFor(block),
    apps: appNamesFor(block),
    category: block.dominantCategory,
    corrected: block.review.state === 'corrected',
  }
}

function appsFor(payload: DayTimelinePayload): MirrorApp[] {
  const totals = new Map<string, MirrorApp>()
  for (const block of payload.blocks) {
    if (!isWritable(block)) continue
    for (const app of block.topApps) {
      const name = app.appName.trim()
      if (!name) continue
      const key = app.bundleId || name
      const existing = totals.get(key)
      if (existing) {
        existing.seconds += app.totalSeconds
      } else {
        totals.set(key, { name, bundleId: app.bundleId || null, seconds: app.totalSeconds })
      }
    }
  }
  return [...totals.values()]
}

export interface BuildDayMemoryOptions {
  generatedAtMs?: number
  timezone?: string
  /** Day-level sentence, when one has been generated for this day. */
  narrative?: string | null
}

export function buildDayMemoryInput(
  payload: DayTimelinePayload,
  options: BuildDayMemoryOptions = {},
): DayMemoryInput {
  const blocks = payload.blocks.filter(isWritable).map(toMirrorBlock)
  return {
    date: payload.date,
    generatedAtMs: options.generatedAtMs ?? Date.now(),
    timezone: options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    trackedSeconds: payload.totalSeconds,
    blocks,
    apps: appsFor(payload),
    entities: (payload.dayEntities ?? [])
      .filter((entity) => entity.type === 'project' || entity.type === 'client')
      .map((entity) => entity.name.trim())
      .filter((name) => name.length > 0),
    narrative: options.narrative?.trim() || null,
  }
}
