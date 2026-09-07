# The Daylens agent: decides what context it needs, goes and gets it

Daylens's agent should work the way Claude Code works on a repo: look at the
evidence, notice what's missing or ambiguous, pull exactly that context, and
only then conclude. Not a canned pipeline, not a support bot.

## What we learned from Clicky and OpenClaw

- **Clicky** (heyclicky.com, open core): capture is *event-gated* — one
  screenshot at hotkey release, sent with the transcript; screenshots never
  stored; no tool loop at all. Strong privacy story ("we only see your screen
  when you press the hotkey"), capped capability.
- **OpenClaw**: the real pattern. Devices advertise *capability commands*
  (camera.snap, screen.record, calendar.events); a gateway filters them into
  the model's tool list per policy; the model pulls context mid-loop whenever
  reasoning needs it. Policy gates live *outside* the model; results are
  size-sanitized before re-entering context; when-to-capture heuristics live
  in prompt/skill space (cheap to iterate), primitives stay small and stable.

Daylens should be OpenClaw's loop with Clicky's capture ethics, on top of the
asset neither has: a structured local activity database.

## The three-tier tool surface

Escalation by cost and sensitivity. The agent exhausts a tier before
escalating, and says why when it escalates.

**Tier 1 — the database (free, always allowed).** The existing tool set
(`daylensTools.ts` + `wrappedTools.ts`): day summaries, session search,
window-title context, entities, calendar, git. Milliseconds, text, no prompt.

**Tier 2 — structured live probes (cheap, allowed by default).**
- `get_active_context()` — current foreground app, window title, URL.
- `read_observed_file(path)` — file content, gated to paths Daylens already
  observed in activity evidence (`file_activity_events` / artifacts), via the
  existing `file_access_grants` model.
- `get_accessibility_text(window)` — AX tree text of a window; an order of
  magnitude cheaper in tokens than pixels and usually more useful.

**Tier 3 — pixels (expensive, consent-gated, never stored).**
- `capture_screen(reason)` — one still of the active display via
  `desktopCapturer`, downscaled (long edge ≤1600px, matching the existing
  `electronFrameSource` cap), passed to the model as an image block,
  discarded after the turn. The `reason` string is mandatory and surfaced in
  the UI activity trail — the user always sees *why* the agent looked.
- Historical frames: when the screen-context experiment is enabled and
  frames exist for the asked-about moment, `get_screen_frame(time)` serves
  the stored encrypted frame instead of a live capture.

## The policy gate

OpenClaw's lesson, applied: the gate lives in the main process, outside the
model and outside the renderer.

- Per-tier switches in Settings: Tier 1 always on; Tier 2 on by default;
  Tier 3 off until the user enables it (reuses the screen-context consent
  language — one consent, one mental model).
- Every Tier 2/3 call is logged to the existing activity trail with its
  reason. Tool results pass through `filterTrackingExcludedEvidence` like
  every other AI-bound payload.
- Size hygiene: screenshots enter as one image block; after the turn ends,
  the stored trace keeps only a text summary ("screenshot showed Cursor with
  failing tests"), never the pixels.

## Two consumers, one loop

1. **The chat agent** (`chatAgent.ts`) — already a real tool loop
   (streamText, MAX_STEPS 14, ask_user, context packets). It gains Tier 2/3
   tools. "Why was I stuck at 3pm?" → Tier 1 shows a long Xcode block →
   Tier 2 title context is ambiguous → Tier 3 (if the moment is *now*) or
   stored frames (if past) resolve it.
2. **The interpretation agent** — the `interpretationAgentEnabled` path in
   `analyzeDay.ts`. Day analysis becomes an agent turn over the same
   read-only tools: for each low-confidence historical block it may pull
   title context, entities, or calendar before labeling. Live screen capture
   is reserved for a current block and is not registered on this path.
   Deterministic heuristics stay as the always-available fallback and the
   floor for hermetic tests. This is where "the AI understands activity" and
   "the agent pulls context" become the same feature.

Both consumers share the tool registry, the policy gate, and the trail. New
capabilities (a new probe, a connector, a device) are new tools + a policy
entry — the loop does not change. That is the growth path: the agent's
*capability* is the stable core; integrations are pluggable evidence.

## Escalation heuristics live in the prompt

Encode when-to-escalate as system-prompt guidance, not code: escalate when
naming confidence is low, when evidence conflicts (leisure domain vs work
titles), when the user asks about *now*, when a block is long but unnamed.
Iterating on these costs a prompt edit, matching how Clicky/OpenClaw iterate
in skill space.

## Privacy contract (user-facing, one sentence)

"Daylens reads your local activity database freely; it looks at a file or
your live screen only when a question needs it, tells you why, and never
stores what it saw."
