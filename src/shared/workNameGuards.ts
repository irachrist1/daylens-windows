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
 * ("Inbox (1)", "Spam (11)"), generic site/dashboard surfaces ("Your
 * Repositories", "Hub", "Analytics"), machine hostnames ("DESKTOP-MA0THSC"),
 * and communication tool brands ("Microsoft Teams", "Meet", "Zoom") — is now
 * disqualified, and stored labels are additionally held to the label-shape
 * gate (workNameGuardLabelViolation with storedLabel: a tool surface hiding
 * behind a verb lead or mixed into a list, a brand with no other work
 * object); stamped databases re-scan under the widened rules.
 */
export const WORK_NAME_GUARD_VERSION = 4

/** Tool brands that are the INSTRUMENT of the work, never its subject. */
export const TOOL_BRAND_NAMES = new Set([
  'claude code', 'claude', 'chatgpt', 'cursor', 'warp', 'raycast', 'raycast beta',
  'copilot', 'github copilot', 'terminal', 'iterm', 'iterm2', 'vs code', 'vscode',
  'visual studio code', 'xcode', 'ai chat', 'gemini', 'codex', 'windsurf', 'zed',
  'opencode', 'comet', 'dia', 'safari', 'chrome', 'google chrome', 'firefox',
  'arc', 'edge', 'microsoft edge', 'ghostty',
  'traycer',
  // Communication tools: the channel the talking happened through, never what
  // the talking was about. Full-match only (isToolBrandName), so "Meeting with
  // the design team" and "Teams standup notes" stay legitimate work names.
  'microsoft teams', 'ms teams', 'teams', 'google meet', 'meet', 'zoom',
  'slack', 'outlook', 'gmail', 'google chat', 'whatsapp', 'telegram', 'signal',
  'messages', 'discord', 'facetime',
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

/** Pathish argument scan for the command-shape check. The v3 lesson, twice
 *  over: a token with UPPERCASE letters counts only when the leading verb was
 *  typed lowercase (real invocations are) — otherwise "Go over the Design/Eng
 *  handoff" and "Make the Frontend/Backend split plan" become "commands" and
 *  the startup repair deletes those labels unrecoverably. Lowercase tokens
 *  keep the original v3 behavior regardless of verb case. */
function containsPathishToken(text: string, includeUppercase: boolean): boolean {
  return text.split(/\s+/).some((token) => {
    if (!PATHISH_TOKEN.test(token) || ACRONYM_PAIR.test(token)) return false
    return includeUppercase || token === token.toLowerCase()
  })
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
  if (containsPathishToken(rest, verb[0] === verb[0].toLowerCase())) return true
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
  'explore', 'overview', 'hub', 'analytics', 'usage',
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
const SPEC_LIST_MIN_DIGIT_SEGMENTS = 2

/** True when no human would name their work this way: overlong past the
 *  label-voice bound, or a comma-spliced SPEC list. The observed leak was a
 *  raw retail listing window title ("LENOVO T14S 2-IN-1 LAPTOP ,INTEL CORE
 *  ULTRA7-255U, PROCESSOR ,32GB RAM , …") — 199 chars, ten comma segments
 *  full of digits. The comma rule needs digit-bearing segments so an honest
 *  Oxford list ("Emails, invoices, planning, and admin") is never flagged —
 *  this predicate feeds the startup repair, which DELETES, so it must never
 *  fire on prose. */
export function looksLikeInhumanTitle(label: string): boolean {
  const trimmed = label.trim()
  if (trimmed.length > MAX_HUMAN_NAME_CHARS) return true
  if ((trimmed.match(/,/g) ?? []).length >= SPEC_LIST_MIN_COMMAS) {
    const digitSegments = trimmed.split(',').filter((segment) => /\d/.test(segment))
    if (digitSegments.length >= SPEC_LIST_MIN_DIGIT_SEGMENTS) return true
  }
  return false
}

const SHOUTING_MIN_CHARS = 40
const SHOUTING_MIN_LETTERS = 20
const SHOUTING_UPPER_SHARE = 0.8

/** A long mostly-uppercase string reads as a capture artifact, not a human
 *  work name. A HEURISTIC, not a certainty — real names shout too ("CBC MIT
 *  REDDIT AI HACKATHON", "DAYLENS V2 LAUNCH CHECKLIST" are under the bar by
 *  design) — so it gates SUBJECT INFERENCE and fresh generations (which get
 *  a corrective retry), and is deliberately NOT part of
 *  isDisqualifiedWorkSubject: the startup repair deletes stored labels
 *  unrecoverably and must never do so over a style hunch. */
export function looksLikeShoutingTitle(label: string): boolean {
  const trimmed = label.trim()
  if (trimmed.length < SHOUTING_MIN_CHARS) return false
  const letters = trimmed.match(/\p{L}/gu) ?? []
  const upper = trimmed.match(/\p{Lu}/gu) ?? []
  return letters.length >= SHOUTING_MIN_LETTERS && upper.length / letters.length >= SHOUTING_UPPER_SHARE
}

// A machine hostname ("DESKTOP-MA0THSC") observed as a wrap subject. Single
// token only; short ticket ids ("DEV-276") stay under the 5-char tail bound.
const MACHINE_HOSTNAME = /^[A-Z]+-[A-Z0-9]{5,}$/

export function looksLikeMachineHostname(label: string): boolean {
  return MACHINE_HOSTNAME.test(label.trim())
}

/** The one gate for "may this string name a thread / stretch / activity":
 *  rejects tool brands, terminal commands, joined tab titles, repo-path tab
 *  titles, mail/site surfaces, machine hostnames, and inhuman capture
 *  titles. Callers layer their own raw-artifact checks (filenames, spinner
 *  glyphs) on top. Everything here is deletion-safe: the startup repair
 *  deletes stored labels this predicate flags, so heuristics that can fire
 *  on real names (looksLikeShoutingTitle) live OUTSIDE it. */
export function isDisqualifiedWorkSubject(label: string): boolean {
  const trimmed = label.trim()
  if (!trimmed) return true
  return isToolBrandName(trimmed) || isToolSurfaceTitle(trimmed)
    || looksLikeCommandLine(trimmed) || looksLikeJoinedTabTitle(trimmed)
    || looksLikeRepoPathTitle(trimmed) || isSurfaceName(trimmed)
    || looksLikeMachineHostname(trimmed) || looksLikeInhumanTitle(trimmed)
}

// Words that cannot be the work's object on their own — connective tissue,
// time filler, and generic activity nouns. Consulted only when the label
// mentions a tool brand: "Sprint planning in Slack" has a real object
// ("sprint planning"); "Catching up on Slack" has none.
const NON_OBJECT_WORDS = new Set([
  'a', 'an', 'the', 'this', 'that', 'my', 'our', 'your', 'their', 'some',
  'all', 'and', 'or', 'in', 'on', 'at', 'to', 'of', 'for', 'with', 'via',
  'through', 'over', 'from', 'up', 'out', 'into', 'around',
  'morning', 'afternoon', 'evening', 'night', 'day', 'today', 'week',
  'hour', 'hours',
  'work', 'working', 'worked', 'time', 'session', 'sessions', 'call',
  'calls', 'meeting', 'meetings', 'chat', 'chats', 'chatting', 'message',
  'messages', 'messaging', 'catching', 'checking', 'browsing', 'using',
  'use', 'reviewing', 'review', 'setting', 'set',
])

// Longest token run worth testing against the vocabulary: brands run up to
// three words ("visual studio code"), surfaces a few more.
const MAX_VOCAB_RUN_WORDS = 6

/** The label-shape gate for AI labels, shared by the generation validators
 *  (via labelCandidateViolation) and the startup repair
 *  (storedLabelViolatesWorkNameGuards). A label is verb + object, so the
 *  bare subject gate can miss it: isDisqualifiedWorkSubject("Working on
 *  Cursor Agents") is false because of the verb lead. Three checks:
 *  - the whole label is a disqualified subject;
 *  - a multi-word tool-surface phrase appears ANYWHERE as a token run
 *    ("Reviewing Cursor Agents and Daylens issues", "Cursor Agents work",
 *    "Time in Cursor Agents" — no legitimate label contains one);
 *  - a tool brand is mentioned and every other word is connective tissue or
 *    a generic activity word ("Catching up on Slack", "Microsoft Teams
 *    calls", "In Microsoft Teams all morning") — while "Sprint planning in
 *    Slack" and "Zoom call with Jamie" keep their real objects and pass.
 *  With `storedLabel` the shouting heuristic is skipped: generation has a
 *  corrective retry, the repair DELETES, and a stored all-caps name
 *  ("DAYLENS V2 LAUNCH CHECKLIST") must never die over a style hunch.
 *  Deterministic; returns the violation for the retry, or null. */
export function workNameGuardLabelViolation(
  label: string,
  options: { storedLabel?: boolean } = {},
): string | null {
  const trimmed = label.replace(/\s+/g, ' ').trim()
  if (!trimmed) return null
  if (isDisqualifiedWorkSubject(trimmed)) {
    return `the label "${trimmed}" is a tool name, tool surface, capture artifact, or site surface, not an activity`
  }
  if (!options.storedLabel && looksLikeShoutingTitle(trimmed)) {
    return `the label "${trimmed}" reads as a shouting capture title, not a human work name`
  }
  const words = trimmed.split(' ')
    .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
  const brandCovered = new Array<boolean>(words.length).fill(false)
  for (let start = 0; start < words.length; start += 1) {
    for (let end = start + 1; end <= Math.min(words.length, start + MAX_VOCAB_RUN_WORDS); end += 1) {
      const run = words.slice(start, end).join(' ')
      if (end - start >= 2 && isToolSurfaceTitle(run)) {
        return `the label contains the tool surface "${run}", not the work done in it`
      }
      if (isToolBrandName(run)) {
        for (let index = start; index < end; index += 1) brandCovered[index] = true
      }
    }
  }
  if (brandCovered.some(Boolean)) {
    const rest = words.filter((word, index) => word && !brandCovered[index])
    if (rest.every((word) => NON_OBJECT_WORDS.has(word.toLowerCase()))) {
      return 'the label names only the tool as the work; name what was done in it'
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
  // Shouting gates SUBJECTS (this is the wrap-surface gate) but not stored-
  // label deletion — see looksLikeShoutingTitle.
  if (looksLikeShoutingTitle(cleaned)) return null
  return cleaned
}
