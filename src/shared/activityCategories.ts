import type { AppCategory } from './types'

export const ACTIVITY_CATEGORY_LABELS: Record<AppCategory, string> = {
  development: 'Development',
  communication: 'Communication',
  research: 'Research',
  writing: 'Writing',
  aiTools: 'AI Tools',
  design: 'Design',
  browsing: 'Browsing',
  meetings: 'Meetings',
  entertainment: 'Entertainment',
  email: 'Email',
  productivity: 'Productivity',
  social: 'Social',
  system: 'System',
  uncategorized: 'Uncategorized',
}

export const ALL_ACTIVITY_CATEGORY_OPTIONS = (Object.keys(ACTIVITY_CATEGORY_LABELS) as AppCategory[])
  .map((value) => ({ value, label: ACTIVITY_CATEGORY_LABELS[value] }))

export const EDITABLE_BLOCK_CATEGORY_OPTIONS = ALL_ACTIVITY_CATEGORY_OPTIONS
  .filter(({ value }) => value !== 'system' && value !== 'uncategorized')

export function activityCategoryLabel(
  category: AppCategory,
  options: { uncategorized?: string } = {},
): string {
  if (category === 'uncategorized' && options.uncategorized) return options.uncategorized
  return ACTIVITY_CATEGORY_LABELS[category] ?? String(category)
}

const CANONICAL_CATEGORY_BY_LOWER: Record<string, AppCategory> = Object.fromEntries(
  (Object.entries(ACTIVITY_CATEGORY_LABELS) as Array<[AppCategory, string]>).flatMap(
    ([canonical, label]) => [
      [canonical.toLowerCase(), canonical],
      [label.toLowerCase(), canonical],
    ],
  ),
) as Record<string, AppCategory>

/** Canonicalize a stored category string. Rows written before the vocabulary
 *  settled carry display forms ("AI Tools", "Browsing", "Uncategorized"); every
 *  kind/intent rule compares against the canonical enum, so an un-normalized
 *  read silently demotes hours of development to "personal". Unknown strings
 *  resolve to 'uncategorized' rather than throwing — a category is a hint,
 *  never worth failing a read over. */
export function canonicalAppCategory(raw: string | null | undefined): AppCategory {
  if (!raw) return 'uncategorized'
  return CANONICAL_CATEGORY_BY_LOWER[raw.trim().toLowerCase()] ?? 'uncategorized'
}
