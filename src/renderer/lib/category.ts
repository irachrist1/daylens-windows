// Shared category color palette — used by Today, History, Apps views
import type { AppCategory } from '@shared/types'

export const CATEGORY_COLOR: Record<string, string> = {
  development:   '#b4c5ff',
  research:      '#c084fc',
  writing:       '#93c5fd',
  aiTools:       '#e879f9',
  design:        '#f472b6',
  productivity:  '#6ee7b7',
  communication: '#4fdbc8',
  email:         '#67e8f9',
  browsing:      '#fb923c',
  meetings:      '#ffb95f',
  entertainment: '#f87171',
  social:        '#a78bfa',
  system:        '#94a3b8',
  uncategorized: '#3d5568',
}

export function catColor(category: AppCategory | string): string {
  return CATEGORY_COLOR[category] ?? '#94a3b8'
}

// Human-readable label for category enum values.
// Needed because raw values like "aiTools" look like code in the UI.
const CATEGORY_NAMES: Record<string, string> = {
  development:   'Development',
  communication: 'Communication',
  research:      'Research',
  writing:       'Writing',
  aiTools:       'AI Tools',
  design:        'Design',
  browsing:      'Browsing',
  meetings:      'Meetings',
  entertainment: 'Entertainment',
  email:         'Email',
  productivity:  'Productivity',
  social:        'Social',
  system:        'System',
  uncategorized: 'Uncategorized',
}

export function formatCategory(category: AppCategory | string): string {
  return CATEGORY_NAMES[category] ?? category
}
