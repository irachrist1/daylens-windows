import type { AppCategory, WorkContextBlock } from '@shared/types'
import { sanitizeForModel } from '@shared/aiSanitize'
import { blockActiveSeconds } from '@shared/blockDuration'
import { isArtifactCompatibleWithBlockCategory, naturalizeLabel } from '@shared/blockLabel'
import { rawLabelForm } from '@shared/labelVoice'
import { activityCategoryLabel } from '@shared/activityCategories'
import { formatDuration } from './format'

const PAGE_ARTIFACT_LABEL_CATEGORIES: ReadonlySet<AppCategory> = new Set([
  'browsing', 'research', 'entertainment', 'social', 'aiTools',
])

function pageArtifactLabelAllowed(block: WorkContextBlock): boolean {
  if (PAGE_ARTIFACT_LABEL_CATEGORIES.has(block.dominantCategory)) return true
  const totalSeconds = block.topApps.reduce((sum, app) => sum + (app.totalSeconds ?? 0), 0)
  if (totalSeconds <= 0) return false
  const browserInTop2 = block.topApps.slice(0, 2).find((app) => app.isBrowser)
  return browserInTop2 ? (browserInTop2.totalSeconds ?? 0) / totalSeconds > 0.5 : false
}

export function safeTimelineText(text: string): string {
  return sanitizeForModel(text)
}

// Terminal window titles arrive with a leading status glyph — a braille spinner
// (⠿, ⣷…), an activity mark (✳, ✶…), or a bullet — that is process chrome, not
// content. Strip it for display so a row reads "Traycer", not "⠿ Traycer".
const LEADING_STATUS_GLYPH_RE = /^[\s⠀-⣿✳✶✽✻✼✱✲✦✧✻●○◌◍◎◦∙·•▪▸▹►▶◆◇*]+/u

export function cleanTitleForDisplay(text: string): string {
  return safeTimelineText(text.replace(LEADING_STATUS_GLYPH_RE, '').trim())
}

export function shortDomainLabel(domain: string): string {
  return domain.replace(/^www\./i, '')
}

function categoryVerbPhrase(category: WorkContextBlock['dominantCategory']): { verb: string; noun: string } {
  switch (category) {
    case 'development': return { verb: 'editing', noun: 'code' }
    case 'design': return { verb: 'working on', noun: 'design work' }
    case 'writing': return { verb: 'writing', noun: 'a draft' }
    case 'research': return { verb: 'researching', noun: 'reference material' }
    case 'aiTools': return { verb: 'working with', noun: 'AI tools' }
    case 'email': return { verb: 'checking', noun: 'email' }
    case 'communication': return { verb: 'in', noun: 'conversation' }
    case 'meetings': return { verb: 'in', noun: 'meetings' }
    case 'browsing': return { verb: 'reviewing', noun: 'web context' }
    case 'productivity': return { verb: 'working through', noun: 'tasks' }
    case 'entertainment': return { verb: 'watching', noun: 'video content' }
    case 'social': return { verb: 'on', noun: 'social' }
    case 'system': return { verb: 'on', noun: 'system tasks' }
    default: return { verb: 'on', noun: 'mixed work' }
  }
}

function artifactPhraseForCategory(
  artifactTitle: string,
  artifactType: string,
  category: WorkContextBlock['dominantCategory'],
): string {
  if (/^inbox(?:\s*\(\d+\))?$/i.test(artifactTitle)) return 'email'
  if (artifactType === 'page' && category === 'browsing') return `the ${artifactTitle} page`
  if (artifactType === 'page' && (category === 'research' || category === 'aiTools')) return artifactTitle
  return artifactTitle
}

/** Deterministic renderer fallback only. Persisted main-process narrative wins.
 *  It describes the ACTIVITY, never the tools (DEV-280): the subject when a
 *  clean artifact names one, the category mix otherwise — no "mostly in
 *  Cursor" clauses, no window titles. */
export function blockShortSummary(block: WorkContextBlock): string {
  const duration = formatDuration(blockActiveSeconds(block))
  const sites = pageArtifactLabelAllowed(block)
    ? block.websites.slice(0, 2).map((site) => shortDomainLabel(site.domain))
    : []
  const topArtifact = block.topArtifacts.find((artifact) => (
    artifact.displayTitle.trim().length > 0
    && isArtifactCompatibleWithBlockCategory(artifact, block.dominantCategory)
  ))
  const rawArtifact = topArtifact ? safeTimelineText(topArtifact.displayTitle.trim()) : null
  const cleanArtifact = rawArtifact ? naturalizeLabel(rawArtifact) || rawArtifact : null
  const naturalizedArtifact = cleanArtifact && !rawLabelForm(cleanArtifact) ? cleanArtifact : null

  const { verb, noun } = categoryVerbPhrase(block.dominantCategory)
  // The other real activities inside the block, so a long mixed block is not
  // summarized by its top category alone (the "ignores my morning" failure).
  const otherActivities = Object.entries(block.categoryDistribution ?? {})
    .filter((entry): entry is [AppCategory, number] =>
      typeof entry[1] === 'number' && entry[1] >= 60
      && entry[0] !== block.dominantCategory
      && entry[0] !== 'system' && entry[0] !== 'uncategorized')
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([category]) => activityCategoryLabel(category).toLowerCase())
  const alongside = otherActivities.length > 0
    ? `, with ${otherActivities.join(' and ')} alongside`
    : ''

  if (naturalizedArtifact) {
    return `Spent ${duration} ${verb} ${artifactPhraseForCategory(naturalizedArtifact, topArtifact!.artifactType, block.dominantCategory)}${alongside}.`
  }
  if (sites.length > 0) return `Spent ${duration} ${verb} ${noun} across ${sites.join(' and ')}${alongside}.`
  return `Spent ${duration} ${verb} ${noun}${alongside}.`
}
