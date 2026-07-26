// Shared guards for what may be NAMED as work — one vocabulary for the day
// facts, the frozen snapshots, and every wrap surface. A tool brand is the
// instrument of the work, never its subject; a terminal command or a joined
// tab title is a capture artifact,
// never a thread. These leaked into real period wraps as "what the week was
// really about": "✳ Claude Code", "npx @agent-native/core@latest skills add
// visual-plans", "Branch · Branch · Space Visualization Prep".

/**
 * Version of the guard rules in this file (plus the stored-label checks built
 * on them in workBlocks.ts `storedLabelViolatesWorkNameGuards`, and the
 * stored-category recomputation the same startup pass runs —
 * `recomputeStoredBlockCategoryFacts`). Bump this whenever either rule set
 * changes so the startup repair pass (labelGuardRepair.ts) re-scans rows
 * persisted under the older rules — stored labels and category facts must
 * heal without the user re-analyzing every day.
 *
 * v2: category-consistency heal — stored dominant_category /
 * category_distribution_json recomputed with the attention-gated distribution
 * (media history-fill credit no longer counts as watching without foreground
 * title corroboration).
 *
 * v3: looksLikeCommandLine no longer flags prose that merely starts with a
 * binary's name ("Git workflow cleanup", "Make the onboarding deck") — the v2
 * predicate deleted legitimate AI labels unrecoverably; stamped databases
 * must re-scan under the corrected rules.
 *
 * v4: junk that reached a real day's "workedOn" facts — a 199-char retail
 * listing window title, "Owner/repo: description" GitHub tab titles with
 * uppercase owners (the v3 path regex was lowercase-only), mailbox surfaces
 * ("Inbox (1)", "Spam (11)"), generic site surfaces ("Your Repositories"),
 * and communication tool brands ("Microsoft Teams", "Meet", "Zoom") — is now
 * disqualified; stamped databases re-scan under the widened rules.
 */
export const WORK_NAME_GUARD_VERSION = 4

/** Tool brands that are the INSTRUMENT of the work, never its subject. */
export const TOOL_BRAND_NAMES = new Set([
  'claude code', 'claude', 'chatgpt', 'cursor', 'warp', 'raycast', 'raycast beta',
  'copilot', 'github copilot', 'terminal', 'iterm', 'iterm2', 'vs code', 'vscode',
  'visual studio code', 'xcode', 'ai chat', 'gemini', 'codex', 'windsurf', 'zed',
  'opencode', 'comet', 'dia', 'safari', 'chrome', 'google chrome', 'firefox',
  'arc', 'edge', 'microsoft edge', 'ghostty',
  // Communication tools: the channel the talking happened through, never what
  // the talking was about. Full-match only (isToolBrandName), so "Meeting with
  // the design team" and "Teams standup notes" stay legitimate work names.
  'microsoft teams', 'teams', 'google meet', 'meet', 'zoom', 'slack',
  'outlook', 'gmail',
])

/** True when the name IS a tool brand (after stripping decorative prefixes —
 *  a captured "✳ Claude Code" is still the tool, not a work subject). */
export function isToolBrandName(name: string): boolean {
  const cleaned = name.trim().toLowerCase().replace(/^[^a-z0-9]+/, '').trim()
  return TOOL_BRAND_NAMES.has(cleaned)
}

// Generic words a tool's own UI uses to name its surfaces. A tool brand plus
// only these ("Cursor Agents", "Copilot Chat") is a panel title, not work —
// it named 8 of 12 slides of a real day whose actual project never appeared.
const TOOL_SURFACE_WORDS = new Set([
  'agent', 'agents', 'chat', 'chats', 'composer', 'panel', 'tab', 'tabs',
  'assistant', 'copilot', 'terminal', 'settings', 'home', 'dashboard',
])

/** True when the name is a tool's own UI surface rather than a work subject:
 *  a tool brand followed only by surface words ("Cursor Agents"), or a fresh
 *  unnamed conversation ("New chat - Claude", "Untitled chat"). */
export function isToolSurfaceTitle(name: string): boolean {
  const cleaned = name.trim().toLowerCase().replace(/^[^a-z0-9]+/, '').trim()
  if (!cleaned) return false
  if (/^(new|untitled) (chat|conversation|thread|tab)\b/.test(cleaned)) return true
  const words = cleaned.split(/\s+/)
  for (let i = words.length - 1; i >= 1; i -= 1) {
    const prefix = words.slice(0, i).join(' ')
    if (TOOL_BRAND_NAMES.has(prefix) && words.slice(i).every((w) => TOOL_SURFACE_WORDS.has(w))) {
      return true
    }
  }
  return false
}

const CLI_VERBS = /^(npx|npm|pnpm|yarn|node|git|gh|python3?|pip3?|brew|cargo|go|docker|kubectl|curl|wget|make|sudo|cd|ls|rm|cp|mv|ssh|scp|bash|zsh|sh)\b/i

// English function words after a CLI-verb lead mark the label as prose:
// "Go over the quarterly budget" is a plan, not a `go` invocation. Real
// command arguments are bare technical tokens and never need these.
const PROSE_FUNCTION_WORDS = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'my', 'our', 'your',
  'their', 'his', 'her', 'its', 'to', 'of', 'for', 'with', 'without', 'on',
  'in', 'at', 'by', 'over', 'under', 'about', 'into', 'from', 'through',
  'across', 'between', 'after', 'before', 'during', 'and', 'or', 'but', 'as',
  'is', 'are', 'was', 'were', 'be', 'been', 'it', 'up', 'out', 'off', 'some',
  'all', 'any', 'more', 'per', 'via',
])

// A path-ish token ("daylens/ci.yml", "~/dev/daylens", "Irachrist1/daylens"),
// case-insensitive — the v3 lowercase-only form let uppercase GitHub owner
// names slip through. Uppercase acronym pairs ("CI/CD", "A/B") stay prose.
const PATHISH_TOKEN = /^[a-z0-9~.@_-]+\/[a-z0-9~.@_/-]+$/i
const ACRONYM_PAIR = /^[A-Z0-9]{1,4}\/[A-Z0-9]{1,4}$/

function isPathishToken(token: string): boolean {
  return PATHISH_TOKEN.test(token) && !ACRONYM_PAIR.test(token)
}

function containsPathishToken(text: string): boolean {
  return text.split(/\s+/).some((token) => isPathishToken(token))
}

/** True when the label reads as a terminal command, not a human work name.
 *  An npm-style @scope/package ref or shell flag syntax is a command wherever
 *  it appears; a CLI-verb lead counts only when what follows actually reads
 *  as an invocation — shell syntax ($, =, redirects, path-like tokens) or a
 *  run of bare lowercase argument tokens ("npm run dev"). A sentence that
 *  merely starts with a binary's name ("Git workflow cleanup", "Make the
 *  onboarding deck", "Go over the quarterly budget") is a work name the AI
 *  legitimately chose, never a command — flagging those deleted real labels
 *  unrecoverably in the startup repair. */
export function looksLikeCommandLine(label: string): boolean {
  const trimmed = label.trim()
  if (/@[a-z0-9-]+\/[a-z0-9-]+/i.test(trimmed)) return true
  if (/\s--?[a-z][a-z-]*(\s|$)/.test(trimmed)) return true
  const verb = CLI_VERBS.exec(trimmed)
  if (!verb) return false
  const rest = trimmed.slice(verb[0].length).trim()
  if (/[$=<>|`\\]/.test(rest)) return true
  if (containsPathishToken(rest)) return true
  // Bare-token invocation: the verb typed lowercase (commands are), every
  // argument a lowercase technical token, and none of them a word only prose
  // needs.
  if (verb[0] !== verb[0].toLowerCase() || !rest) return false
  return rest.split(/\s+/).every(
    (token) => /^[a-z0-9@][a-z0-9@._:-]*$/.test(token) && !PROSE_FUNCTION_WORDS.has(token),
  )
}

/** True when the label is a joined multi-segment tab/window title (the " · "
 *  and " | " joiners are UI chrome; no human names their work with them). */
export function looksLikeJoinedTabTitle(label: string): boolean {
  return /\s[·|]\s/.test(label)
}

// Exactly two path segments — the "owner/repo" shape a GitHub tab title
// leads with. Deeper paths ("src/renderer/views/Insights.tsx") are file
// paths, judged by the raw-artifact checks downstream, not here.
const OWNER_REPO_TOKEN = /^[\w.-]+\/[\w.-]+$/

/** True when the label is a GitHub-style repo tab title: a leading
 *  "owner/repo" token standing alone ("Irachrist1/daylens-v1") or followed by
 *  the repo description after a colon ("Irachrist1/daylens-v1: Daylens").
 *  Acronym pairs stay prose, so "A/B test analysis" is untouched. */
export function looksLikeRepoPathTitle(label: string): boolean {
  const tokens = label.trim().split(/\s+/)
  const first = tokens[0] ?? ''
  const isOwnerRepo = (token: string) => OWNER_REPO_TOKEN.test(token) && !ACRONYM_PAIR.test(token)
  if (first.endsWith(':')) return tokens.length > 1 && isOwnerRepo(first.slice(0, -1))
  return tokens.length === 1 && isOwnerRepo(first)
}

// Mailbox folders every mail client names its surfaces with. "Inbox (1)" is
// where the reading happened, never what the work was about.
const MAILBOX_SURFACE_NAMES = new Set([
  'inbox', 'spam', 'sent', 'drafts', 'trash', 'junk', 'archive', 'all mail',
  'all inboxes', 'outbox', 'starred', 'snoozed', 'important', 'bin',
  'sent items', 'deleted items', 'junk email',
])

// Generic page names sites use for their own navigation chrome ("Your
// Repositories" headlined a real day). Full-match only — "Issues" is a GitHub
// surface, "Issues with the billing retry" is work.
const GENERIC_PAGE_SURFACES = new Set([
  'your repositories', 'notifications', 'pull requests', 'issues', 'home',
  'explore', 'overview',
])

/** True when the name is a mail or site surface, with or without an unread
 *  badge: "Inbox", "Spam (11)", "Your Repositories". A single bare word plus
 *  a "(N)" count is a folder badge whatever the word ("Updates (3)"). */
export function isSurfaceName(name: string): boolean {
  const cleaned = name.trim().toLowerCase().replace(/^[^\p{L}\p{N}]+/u, '').trim()
  if (!cleaned) return false
  const badge = /^(.+?)\s*\(\d+\)$/.exec(cleaned)
  const base = (badge ? badge[1] : cleaned).trim()
  if (MAILBOX_SURFACE_NAMES.has(base) || GENERIC_PAGE_SURFACES.has(base)) return true
  return Boolean(badge) && !base.includes(' ')
}

// Bounds on what a human-written work name can look like. AI labels are held
// to 90 chars by the label-voice invariant and legit inferred subjects run
// shorter still, so anything past the bound is a capture artifact.
const MAX_HUMAN_NAME_CHARS = 90
const SPEC_LIST_MIN_COMMAS = 3
const SHOUTING_MIN_CHARS = 25
const SHOUTING_MIN_LETTERS = 12
const SHOUTING_UPPER_SHARE = 0.8

/** True when no human would name their work this way: overlong past the
 *  label-voice bound, a comma-spliced spec list, or a long mostly-uppercase
 *  string. The observed leak was a raw retail listing window title ("LENOVO
 *  T14S 2-IN-1 LAPTOP ,INTEL CORE ULTRA7-255U, PROCESSOR ,32GB RAM , …") —
 *  199 chars, ten commas, all caps; it fails all three. */
export function looksLikeInhumanTitle(label: string): boolean {
  const trimmed = label.trim()
  if (trimmed.length > MAX_HUMAN_NAME_CHARS) return true
  if ((trimmed.match(/,/g) ?? []).length >= SPEC_LIST_MIN_COMMAS) return true
  if (trimmed.length >= SHOUTING_MIN_CHARS) {
    const letters = trimmed.match(/\p{L}/gu) ?? []
    const upper = trimmed.match(/\p{Lu}/gu) ?? []
    if (letters.length >= SHOUTING_MIN_LETTERS && upper.length / letters.length >= SHOUTING_UPPER_SHARE) {
      return true
    }
  }
  return false
}

/** The one gate for "may this string name a thread / stretch / activity":
 *  rejects tool brands, terminal commands, joined tab titles, repo-path tab
 *  titles, mail/site surfaces, and inhuman capture titles. Callers layer
 *  their own raw-artifact checks (filenames, spinner glyphs) on top. */
export function isDisqualifiedWorkSubject(label: string): boolean {
  const trimmed = label.trim()
  if (!trimmed) return true
  return isToolBrandName(trimmed) || isToolSurfaceTitle(trimmed)
    || looksLikeCommandLine(trimmed) || looksLikeJoinedTabTitle(trimmed)
    || looksLikeRepoPathTitle(trimmed) || isSurfaceName(trimmed)
    || looksLikeInhumanTitle(trimmed)
}

// A gerund verb lead plus its optional preposition ("Working on ",
// "Reviewing ", "Catching up on ", "Setting up "). Only a LEADING gerund is
// a verb phrase — "Sprint planning in Slack" names work that happened in a
// place and is untouched.
const VERB_LEAD_RE = /^\p{L}+ing\s+(?:(?:up\s+on|on|in|at|with|through|over|around)\s+)?/iu

/** Generation-time gate for AI label candidates. A label is verb + object,
 *  so the bare subject gate can miss it: isDisqualifiedWorkSubject("Working
 *  on Cursor Agents") is false because of the verb lead, yet the label still
 *  presents the tool's own panel as the day's work. Tests the whole label,
 *  then strips the gerund verb lead (and cuts a trailing " in <project>"
 *  clause) and re-tests the object against the brand/surface vocabulary
 *  only — "Working on Cursor Agents" dies while "Sprint planning in Slack"
 *  and "Cleaning up the inbox" survive. Deterministic; returns the violation
 *  for the corrective retry, or null when the label passes. */
export function workNameGuardLabelViolation(label: string): string | null {
  const trimmed = label.replace(/\s+/g, ' ').trim()
  if (!trimmed) return null
  if (isDisqualifiedWorkSubject(trimmed)) {
    return `the label "${trimmed}" is a tool name, tool surface, capture artifact, or site surface, not an activity`
  }
  const lead = VERB_LEAD_RE.exec(trimmed)
  if (!lead) return null
  const object = trimmed.slice(lead[0].length)
  const lastIn = object.toLowerCase().lastIndexOf(' in ')
  const candidates = lastIn > 0 ? [object, object.slice(0, lastIn)] : [object]
  for (const candidate of candidates) {
    if (isToolBrandName(candidate) || isToolSurfaceTitle(candidate)) {
      return `the label's subject "${candidate.trim()}" names the tool, not the work done in it`
    }
  }
  return null
}

/** Sanitize-then-check: strips capture decorations (braille spinner glyphs,
 *  control chars, leading symbols) and returns the cleaned subject, or null
 *  when what remains is disqualified. "⠂ Review article skills" keeps its
 *  real subject; "✳ Claude Code" cleans to a tool brand and dies. */
export function cleanWorkSubject(label: string): string | null {
  const cleaned = label
    .replace(/[\u2800-\u28FF]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F]/g, '')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned.length < 3) return null
  if (isDisqualifiedWorkSubject(cleaned)) return null
  return cleaned
}
