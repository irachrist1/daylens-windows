// Domain display policy: which web domains are eligible to label a timeline
// block, surface as a "top artifact", or headline the Apps view. This is a
// presentation policy only — capture privacy is handled by trackingControls
// (private-window exclusion and the user's own exclusion list in Settings).
//
// Categories:
//   - 'social_feed': infinite-scroll feed pages whose titles add no signal;
//     allowed inside their own browser detail panel but not promoted as
//     block labels.
//   - 'entertainment': long-form video sinks where the title is the content,
//     not the work; allowed in browser detail, never the block label for a
//     non-entertainment block.

export type DomainPolicyCategory = 'social_feed' | 'entertainment'

const HOST_RULES: Map<string, DomainPolicyCategory> = new Map([
  ['twitter.com', 'social_feed'],
  ['x.com', 'social_feed'],
  ['instagram.com', 'social_feed'],
  ['tiktok.com', 'social_feed'],
  ['reddit.com', 'social_feed'],
  ['facebook.com', 'social_feed'],

  ['youtube.com', 'entertainment'],
  ['youtu.be', 'entertainment'],
  ['music.youtube.com', 'entertainment'],
  ['netflix.com', 'entertainment'],
  ['twitch.tv', 'entertainment'],
  ['primevideo.com', 'entertainment'],
  ['hulu.com', 'entertainment'],
  ['disneyplus.com', 'entertainment'],
  ['max.com', 'entertainment'],
  ['spotify.com', 'entertainment'],
  ['soundcloud.com', 'entertainment'],
  ['vimeo.com', 'entertainment'],
])

function normalizeHost(host: string | null | undefined): string | null {
  if (!host) return null
  const trimmed = host.trim().toLowerCase()
  if (!trimmed) return null
  return trimmed.replace(/^www\./, '')
}

export function policyForHost(host: string | null | undefined): DomainPolicyCategory | null {
  const normalized = normalizeHost(host)
  if (!normalized) return null

  const exact = HOST_RULES.get(normalized)
  if (exact) return exact

  for (const [rule, category] of HOST_RULES) {
    if (normalized.endsWith(`.${rule}`)) return category
  }

  return null
}

/** Every host the rail/label policy knows, for guard checks that need the
 *  brand list itself (e.g. "does this stored label name a leisure service?"). */
export function policyBlockedHosts(): string[] {
  return [...HOST_RULES.keys()]
}

// Kept as named policy points so call sites stay stable if categories evolve.
export function isHostBlockedForLabel(_host: string | null | undefined): boolean {
  return false
}

export function isHostBlockedForAppsRail(host: string | null | undefined): boolean {
  const policy = policyForHost(host)
  return policy === 'social_feed' || policy === 'entertainment'
}

export function isHostFilteredFromArtifacts(_host: string | null | undefined): boolean {
  return false
}
