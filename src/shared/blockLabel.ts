import type { AppCategory, ArtifactRef, WorkContextBlock } from './types'
import { ACTIVITY_CATEGORY_LABELS, activityCategoryLabel } from './activityCategories'
import { workNameGuardLabelViolation } from './workNameGuards'

// Categories where a browser page artifact is a plausible label source for the
// whole block. For development/communication/writing/etc. a co-occurring browser
// tab (YouTube, Slack web, a news site) is noise — never the block's identity.
const PAGE_ARTIFACT_LABEL_CATEGORIES = new Set<AppCategory>([
  'browsing',
  'aiTools',
  'research',
  'entertainment',
  'social',
])

export function isArtifactCompatibleWithBlockCategory(
  artifact: Pick<ArtifactRef, 'artifactType'>,
  category: AppCategory,
): boolean {
  if (artifact.artifactType === 'page' || artifact.artifactType === 'domain') {
    return PAGE_ARTIFACT_LABEL_CATEGORIES.has(category)
  }
  return true
}

const GENERIC_LABELS = new Set([
  'AI Tools',
  'Browsing',
  'Building & Testing',
  'Communication',
  'Design',
  'Development',
  'Email',
  'General Browsing',
  'General Productivity',
  'Inbox Triage',
  'Insufficient Data',
  'Insufficient Data For Label',
  'Meetings',
  'Misc Tasks',
  'Mixed Browsing',
  'Mixed Work',
  'Productivity',
  'Research',
  'Research & AI Chat',
  'System',
  'Terminal Session',
  'Terminal Work',
  'Uncategorized',
  'Untitled Block',
  'Web Session',
  'Writing',
])

// timeline.md §3.5 / invariant 3: a block is never named after a mangled machine
// identifier. This rejects only the indefensible shape — a SCREAMING token
// (AGENT) or a SCREAMING-KEBAB/SNAKE stem with or without a file extension
// (AGENT-EXECUTION-PLAN, AGENT-EXECUTION-PLAN.md). It deliberately does NOT reject
// ordinary filenames or paths (insightsQueryRouter.ts, src/main/workBlocks.ts) or
// repo names (daylens) — those are the existing label design (blockOwnership /
// workBlockSplitting tests). Turning a filename or repo into a real "verb +
// object" name is the AI naming path (§3.5 tier 2), a separate decision, not here.
export function looksLikeRawArtifactLabel(value: string | null | undefined): boolean {
  const t = value?.trim()
  if (!t) return true
  if (/^[A-Z][A-Z0-9]+$/.test(t)) return true                        // a SCREAMING token: AGENT, API
  if (/^[A-Z0-9]+([-_][A-Z0-9]+)+(\.[a-z0-9]+)?$/.test(t)) return true // SCREAMING-KEBAB(.ext): AGENT-EXECUTION-PLAN(.md)
  return false
}

export function naturalizeLabel(value: string): string {
  if (!value) return ''
  let cleaned = value.trim()

  // 0. Strip a leading notification/unread count like "(1) ", "(12) " — these
  //    are tab-title cruft ("(1) Instagram", "(5) Andersen …"), never part of
  //    what the activity actually was. Loop so "(1) (2) X" fully unwraps.
  let previous: string
  do {
    previous = cleaned
    cleaned = cleaned.replace(/^\(\d+\)\s*/, '').trim()
  } while (cleaned !== previous)

  cleaned = cleaned.replace(/^[*✳]\s*/, '').trim()

  const repoTitle = cleaned.match(/^[\w.-]+\/[\w.-]+:\s*(.+)$/)
  if (repoTitle?.[1]) cleaned = repoTitle[1].trim()

  // 1. Clean trailing browser/app names
  cleaned = cleaned.replace(/\s*-\s*(?:Google Chrome|Safari|Arc|Firefox|Brave|Microsoft Edge|Chrome)$/i, '')

  // 2. Clean trailing pipe-soup or dash-soup (domain names, app names, etc.)
  const splitters = [/\s*\|\s*/, /\s*—\s*/, /\s*-\s*/]
  for (const splitter of splitters) {
    if (splitter.test(cleaned)) {
      const segments = cleaned.split(splitter).map(s => s.trim()).filter(Boolean)
      if (segments.length > 1) {
        const domainOrAppSuffixes = /^(?:github|jira|figma|google docs|google sheets|safari|chrome|arc|domain|perusall|youtube|twitter|facebook|notion|slack|canvas|gmail|inbox|mailbox|drive|calendar|meet)$/i
        const filtered = segments.filter(s => !domainOrAppSuffixes.test(s))
        if (filtered.length > 0) {
          cleaned = filtered[0]
          break
        } else {
          cleaned = segments[0]
          break
        }
      }
    }
  }

  return cleaned.trim()
}

export function isUsefulLabel(value: string | null | undefined): value is string {
  if (!value) return false
  const trimmed = value.trim()
  if (!trimmed) return false
  if (GENERIC_LABELS.has(trimmed)) return false
  if (looksLikeRawArtifactLabel(trimmed)) return false
  if (workNameGuardLabelViolation(trimmed, { storedLabel: true })) return false
  const pipeSegments = trimmed.split(/\s*\|\s*/).filter(Boolean)
  // 3+ pipe segments is almost always raw browser-tab soup
  // ("W2_Reading | Intro to ML | Perusall"). Reject so we fall through to a
  // useful AI/rule label, top artifact, or domain fallback rather than
  // showing the user the tab title verbatim.
  if (pipeSegments.length >= 3) return false
  if (pipeSegments.length === 2) {
    const natural = naturalizeLabel(trimmed)
    if (!natural || GENERIC_LABELS.has(natural)) return false
  }
  return true
}

function categoryDisplayName(category: AppCategory): string {
  return activityCategoryLabel(category)
}

const CATEGORY_FLOOR_LABELS = new Set(
  [...Object.values(ACTIVITY_CATEGORY_LABELS), 'Untracked time'].map((label) => label.toLowerCase()),
)

/** True for the wordings `userVisibleBlockLabel` falls back to when nothing
 *  named the block: the category word, "Untracked time", or the app list
 *  ("Cursor and Chrome — activity"). `GENERIC_LABELS` misses several of them
 *  (Entertainment, Social), so a surface that must not present a floor as a
 *  description asks here as well. */
export function labelIsCategoryFloor(value: string | null | undefined): boolean {
  const trimmed = value?.trim()
  if (!trimmed) return false
  if (CATEGORY_FLOOR_LABELS.has(trimmed.toLowerCase())) return true
  return /\s—\sactivity$/.test(trimmed)
}

function cleanSiteName(domain: string): string {
  const stripped = domain.replace(/^www\./i, '').split('.')[0] ?? ''
  if (!stripped) return ''
  return stripped.charAt(0).toUpperCase() + stripped.slice(1)
}

export function userVisibleBlockLabel(block: WorkContextBlock): string {
  const override = block.label.override?.trim()
  // User override is intentional — preserve it verbatim even if it contains
  // pipes or other characters that naturalize would strip.
  if (override) return override

  const current = block.label.current?.trim()
  if (isUsefulLabel(current)) return naturalizeLabel(current)

  const ai = block.aiLabel?.trim()
  if (isUsefulLabel(ai)) return naturalizeLabel(ai)

  const rule = block.ruleBasedLabel?.trim()
  if (isUsefulLabel(rule)) return naturalizeLabel(rule)

  // Before defaulting to a website domain or "Untitled block", try the
  // dominant artifact title — that is what the user was actually looking at,
  // and a naturalized version reads better than "Untitled block" or a bare
  // domain like "github.com".
  // Skip page/domain artifacts that don't fit the block's category — a stray
  // YouTube tab in a development block must not label the block.
  const topArtifact = block.topArtifacts.find(
    (artifact) =>
      artifact.displayTitle?.trim().length > 0
      && isArtifactCompatibleWithBlockCategory(artifact, block.dominantCategory),
  )
  if (topArtifact) {
    const naturalized = naturalizeLabel(topArtifact.displayTitle.trim())
    if (isUsefulLabel(naturalized)) return naturalized
  }

  // A bare site name is only an honest label when a page could own the block.
  // On a development/writing/etc. block the open tabs are background noise, so
  // never let "github.com" or "youtube.com" become a coding block's name.
  if (PAGE_ARTIFACT_LABEL_CATEGORIES.has(block.dominantCategory)) {
    const site = block.websites[0]?.domain
    if (site) {
      const clean = cleanSiteName(site)
      if (clean) return clean
    }
  }

  // Floor: name the category ("Development") rather than announcing that
  // naming failed. For system / uncategorized blocks, name from the app
  // evidence that exists; if there is none, say the interval was untracked.
  if (block.dominantCategory !== 'uncategorized' && block.dominantCategory !== 'system') {
    return categoryDisplayName(block.dominantCategory)
  }
  const appNames = block.topApps
    .filter((app) => app.category !== 'system')
    .map((app) => app.appName.trim())
    .filter((name, index, names) => name.length > 0 && names.indexOf(name) === index)
    .slice(0, 3)
  if (appNames.length === 0) return 'Untracked time'
  const list = appNames.length === 1
    ? appNames[0]
    : `${appNames.slice(0, -1).join(', ')} and ${appNames[appNames.length - 1]}`
  return `${list} — activity`
}
