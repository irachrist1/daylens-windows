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
 */
export const WORK_NAME_GUARD_VERSION = 3

/** Tool brands that are the INSTRUMENT of the work, never its subject. */
export const TOOL_BRAND_NAMES = new Set([
  'claude code', 'claude', 'chatgpt', 'cursor', 'warp', 'raycast', 'raycast beta',
  'copilot', 'github copilot', 'terminal', 'iterm', 'iterm2', 'vs code', 'vscode',
  'visual studio code', 'xcode', 'ai chat', 'gemini', 'codex', 'windsurf', 'zed',
  'opencode', 'comet', 'dia', 'safari', 'chrome', 'google chrome', 'firefox',
  'arc', 'edge', 'microsoft edge', 'ghostty',
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

// A lowercase path-ish token ("daylens/ci.yml", "~/dev/daylens",
// "feature/seams"). Uppercase acronym pairs ("CI/CD", "A/B") stay prose.
const PATHISH_TOKEN = /(^|\s)[a-z0-9~.@_-]+\/[a-z0-9~.@_/-]+(\s|$)/

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
  if (PATHISH_TOKEN.test(rest)) return true
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

/** The one gate for "may this string name a thread / stretch / activity":
 *  rejects tool brands, terminal commands, and joined tab titles. Callers
 *  layer their own raw-artifact checks (filenames, spinner glyphs) on top. */
export function isDisqualifiedWorkSubject(label: string): boolean {
  const trimmed = label.trim()
  if (!trimmed) return true
  return isToolBrandName(trimmed) || isToolSurfaceTitle(trimmed)
    || looksLikeCommandLine(trimmed) || looksLikeJoinedTabTitle(trimmed)
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
