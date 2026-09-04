// What the readable memory mirror costs over a long run of days.
//
//   npm run memory:scale          # 600 days
//   npm run memory:scale -- 1825  # five years
//
// Days are synthetic but shaped like busy real ones (6-9 blocks, 6 apps, prose
// on every block), so the per-day figure is an upper bound rather than a median.
// Nothing here touches the real database or the real mirror directory.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  MEMORY_INDEX_FILE,
  listDayMemories,
  rebuildMemoryIndex,
  renderDayMemoryMarkdown,
  writeDayMemory,
  type DayMemoryInput,
} from '../src/main/services/memoryMirror.ts'

const APPS = [
  ['Cursor', 'com.todesktop.cursor'],
  ['Google Chrome', 'com.google.Chrome'],
  ['Figma', 'com.figma.Desktop'],
  ['Slack', 'com.tinyspeck.slackmacgap'],
  ['Notion', 'notion.id'],
  ['Terminal', 'com.apple.Terminal'],
] as const

const TITLES = [
  'Designed the onboarding screens',
  'Reviewed project feedback',
  'Shipped the billing migration',
  'Worked through the capture backlog',
  'Prepared the weekly update',
  'Debugged the sync path',
]

const NARRATIVES = [
  'You worked through the onboarding flow and checked the build alongside it.',
  'You compared comments on the project brief and followed up with the team.',
  'You moved the migration forward and verified it against the staging database.',
]

function dayFor(index: number): DayMemoryInput {
  const base = Date.parse('2025-01-01T00:00:00Z') + index * 86_400_000
  // 6–9 blocks a day, which is the busy end of a real day rather than the median.
  const blockCount = 6 + (index % 4)
  const blocks = Array.from({ length: blockCount }, (_, b) => {
    const start = base + (8 + b) * 3_600_000
    return {
      id: `blk_${index}_${b}`,
      startMs: start,
      endMs: start + 2_700_000 + (b % 3) * 600_000,
      title: TITLES[(index + b) % TITLES.length],
      narrative: NARRATIVES[(index + b) % NARRATIVES.length],
      apps: APPS.slice(0, 2 + (b % 4)).map(([name]) => name),
      category: 'development',
      corrected: b % 5 === 0,
    }
  })
  return {
    date: new Date(base).toISOString().slice(0, 10),
    generatedAtMs: base + 72_000_000,
    timezone: 'Africa/Kigali',
    trackedSeconds: blockCount * 3000,
    blocks,
    apps: APPS.map(([name, bundleId], i) => ({ name, bundleId, seconds: 7200 - i * 900 })),
    entities: ['Acme', 'Onboarding', 'Billing'],
    narrative: 'You spent the day between design and the billing migration.',
  }
}

const DAYS = Number(process.argv[2] ?? 600)

async function main() {

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'daylens-day600-'))
const mirrorRoot = path.join(root, 'memories')

let bytes = 0
let written = 0
const writeStart = performance.now()
for (let i = 0; i < DAYS; i++) {
  const result = await writeDayMemory(dayFor(i), { mirrorRoot })
  bytes += result.bytes
  if (result.outcome === 'written') written++
}
const writeMs = performance.now() - writeStart

// Second pass over identical input: how much does a re-sync actually rewrite?
const resyncStart = performance.now()
let rewritten = 0
for (let i = 0; i < DAYS; i++) {
  const result = await writeDayMemory(dayFor(i), { mirrorRoot })
  if (result.outcome === 'written') rewritten++
}
const resyncMs = performance.now() - resyncStart

const listStart = performance.now()
const listed = await listDayMemories(mirrorRoot)
const listMs = performance.now() - listStart

const single = renderDayMemoryMarkdown(dayFor(0))
const allText = (
  await Promise.all(listed.map((d) => fs.readFile(path.join(mirrorRoot, `${d}.md`), 'utf8')))
).join('\n')

// Rough token proxy: ~4 chars/token for English prose.
const approxTokens = Math.round(allText.length / 4)

console.log(`days written          ${DAYS}`)
console.log(`files on disk         ${listed.length}`)
console.log(`total size            ${(bytes / 1024 / 1024).toFixed(2)} MB`)
console.log(`avg per day           ${(bytes / DAYS / 1024).toFixed(1)} KB`)
console.log(`one day rendered      ${single.length} bytes`)
console.log(`first write pass      ${writeMs.toFixed(0)} ms (${written} written)`)
console.log(`re-sync pass          ${resyncMs.toFixed(0)} ms (${rewritten} rewritten)`)
console.log(`list ${listed.length} files        ${listMs.toFixed(1)} ms`)
console.log(`whole corpus chars    ${allText.length}`)
console.log(`~tokens if all read   ${approxTokens.toLocaleString()}`)
console.log(`projected at 5 years  ${((bytes / DAYS) * 1825 / 1024 / 1024).toFixed(1)} MB`)

  const indexStart = performance.now()
  await rebuildMemoryIndex({ mirrorRoot })
  const indexMs = performance.now() - indexStart
  const indexText = await fs.readFile(path.join(mirrorRoot, MEMORY_INDEX_FILE), 'utf8')
  console.log('')
  console.log(`index rebuild         ${indexMs.toFixed(0)} ms`)
  console.log(`index size            ${(indexText.length / 1024).toFixed(1)} KB`)
  console.log(`~tokens to read index ${Math.round(indexText.length / 4).toLocaleString()}`)
  console.log(`vs reading everything ${(allText.length / indexText.length).toFixed(0)}x smaller`)

  await fs.rm(root, { recursive: true, force: true })

}
void main()
