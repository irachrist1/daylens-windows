# Daylens positioning and plan

**Status:** Awaiting approval. Recorded 2026-08-14, the day after OpenAI shipped Computer History. Revised the same day against the full feature documentation and interface captures.

This is the standing answer to "why does Daylens exist now that ChatGPT does this," and the plan that follows. It replaces `competitive-position.md` and `landing-positioning.md`, merged into this document. Product behavior still follows [product.md](product.md). Delivery order still follows [V2-SHIP-PRIORITIES.md](../V2-PLAN.md).

## Approve this, and building starts

Each row has a recommendation and a default. Approving all is one word; overriding any one changes only that line.

| # | Decision | Recommendation | If you say nothing |
|---|---|---|---|
| 1 | Does the V2 order change? | **No.** Timeline → Apps → AI chat → recaps → settings. Everything here depends on the day underneath being right. | No change |
| 2 | First new build | **The readable memory mirror** — memories as Markdown on disk with a deterministic frontmatter block, plus export into the Codex memories convention. **Shipped 2026-08-14**, with the agent index, history backfill, and Settings pane. | Build it first |
| 3 | Second and third | **Menu-bar pause with granular clear**, then **collapsed per-entry provenance** (DEV-244). | That order |
| 4 | Capture upgrade | **Read more of the Accessibility API we already hold** — documents, web URLs, focused element — and move from polling to `AXObserver`. No new permission. | Approved, scheduled after the AI-chat fix |
| 5 | Summarizer architecture | **Match their agent-over-events design, run locally.** Structured facts stay authoritative; prose never carries a number the structure does not. | Approved |
| 6 | Storage | **Four tiers, coalesce before writing.** Keep coalesced intervals well past their 48-hour horizon — this is what makes corrections possible. | Approved |
| 7 | Interface | **Adopt their timeline entry anatomy** — outcome title, one plain sentence, app icons as the only provenance, one accent color. | Approved |
| 8 | Site headline | **"You did a lot today. Daylens remembers all of it."** A capability becomes a moment. | Keep the old line |
| 9 | Announcement device | **The with/without toggle**, asked with a time-accounting question theirs cannot answer at all. | Approved |
| 10 | Screen context | **Preview channel, not the default path.** Per your call; not cut. | Preview channel |
| 11 | Nine unverified defects | **One hour in the running app before scoping the V2 list.** Several are likely closed. | Do it before scoping |

Two things are deliberately not defaulted, because they are not mine to default:

- **`docs/reviews/gap-analysis-2026-07-20.md`** narrates a real day of yours, is linked from the README, and sits in a public repo. It breaks no rule you wrote. It is still a decision.
- **"A folder you can open"** is the strongest trust line available to us, and it is only true once decision 2 ships. If it slips, cut the line rather than soften it.

## 1. What OpenAI shipped

Computer History, in the ChatGPT macOS desktop app, replacing the screenshot-based Chronicle research preview. Rebuilt, not renamed.

**Capture.** An interaction-event stream from allowed apps and websites: clicks, typing, keyboard shortcuts, app switches, "and context that macOS exposes through its accessibility system." Not screenshots, screen recordings, microphone input, or system audio. Private-mode browsing never included. **It does not require Screen Recording permission** — a point they make explicitly, because it is the objection they expect.

**Processing.** Events are captured locally, then Computer History "periodically starts an ephemeral Codex session with access to the interaction-event stream to summarize your activity into memories." Those sessions run on OpenAI servers. Raw events are not retained after processing unless legally required, and are not used for training.

**Output.** Plain-text Markdown under `$CODEX_HOME/memories/extensions/skysight/`, readable and editable by the user, persisting until deleted.

**Retention.** Event files live in the ChatGPT App Group container — a sandboxed shared container other apps cannot read without permission — for up to 48 hours, then are deleted.

**Gating.** Pro, Business, Enterprise. In workspaces an administrator grants access before a member can opt in; the grant does not opt anyone in. Requires Memories. macOS desktop only. Not available on API key or Amazon Bedrock. Unavailable in the EEA, Switzerland, and the UK.

**Interface.** `Settings > Computer history` with two panes, `History` and `Permissions`. History is a timeline grouped by day and time; each item can carry a title, a text summary, the apps that contributed, a suggested skill or automation, and actions to reveal the memory file in Finder or delete the item. An **Ask about your history** button opens a chat. Permissions offers four modes: exclude these apps, exclude these websites, include only these apps, include only these websites. Selecting an app icon inside a timeline item excludes that app from future history. The macOS menu bar shows what is being captured, pauses and resumes, and clears the last session for a recent app. Clearing history deletes the underlying events and any memories derived from them, irreversibly.

**Risks they name themselves.** Prompt injection from app and website content. Memory files are not encrypted and other programs running as the same macOS user may be able to read them. They advise turning it off during communications with people who have not consented, and excluding sensitive health, financial, and personal sources. Token usage is incurred during summarization.

Sources: [OpenAI documentation](https://learn.chatgpt.com/docs/customization/computer-history), [9to5Mac](https://9to5mac.com/2026/08/13/chatgpt-for-mac-adds-opt-in-computer-history-feature-replacing-chronicle/), [unite.ai](https://www.unite.ai/openais-computer-history-turns-mac-activity-into-chatgpt-memory/).

## 2. How it works, and where ours should be better

### The capture layer

They read the macOS Accessibility API. So do we. `probes/capture-probe.swift` already calls `AXUIElementCopyAttributeValue`, and reads exactly two attributes: `kAXFocusedWindowAttribute` and `kAXTitleAttribute`. Window titles, by polling. There is no `AXObserver` in the capture path.

That is the finding that matters: **the distance between our capture and theirs is not a permission, a framework, or a platform API we lack. It is attributes we already have access to and do not read.** Everything below is reachable through the Accessibility permission we already request.

Worth adding, in rough order of value per unit of risk:

- **`AXDocument`** — the `file://` URL of the document in the focused window. Exact file paths for edited documents, instead of inferring them from window-title parsing. Directly improves artifact and file-mention accuracy.
- **`AXWebArea` and its `AXURL`** — the page URL of the focused browser tab, straight from the browser's accessibility tree. This is how they attribute websites without a browser extension or history-database read, and it is the most likely fix for the "No page recorded — 11h 21m" gap in Apps. It also sidesteps the Safari history-access problem entirely.
- **`AXFocusedUIElement` with `AXRole`** — what kind of thing has focus: a text area, a code editor, a chat composer, a search field. Distinguishes writing from reading inside the same application, which is precisely what "What you did there" needs and cannot currently say.
- **Focus dwell** — how long an element actually held focus, as opposed to how long the app sat in the foreground. Real attention rather than window ownership.
- **`AXSelectedText`** — the highest-signal and highest-sensitivity attribute available. Do not read it by default. If it is ever read, it belongs behind the same explicit consent as screen context.

Two engineering notes that will bite otherwise. First, `AXObserver` with notification callbacks is the correct pattern — polling costs battery and misses transitions between samples, and their event stream is observer-shaped. Second, accessibility calls block against unresponsive applications: set `AXUIElementSetMessagingTimeout` and treat a timeout as a missing value rather than letting it stall the capture loop.

### The processing layer

Their design, stated plainly in their own privacy section: **a periodically spawned ephemeral agent session with file access to the event stream, which writes Markdown memories.**

This is worth understanding rather than dismissing, because three things follow from it that a fixed summarization prompt would not give:

1. **The summarizer can decide what matters.** An agent reading an event file chooses what is worth recording. A fixed prompt applies the same template to a day of deep work and a day of email.
2. **Memories are pointers, not copies.** Their documentation says ChatGPT and Codex use the history to *identify* a better source — a file, a Slack thread, a Google Doc — and then read that source directly. They are not storing your documents. They are storing enough to find them again. That is why their memory files stay small.
3. **Batching amortizes cost.** Periodic sessions over a window of events, not a model call per event.

We should match the shape and change three things:

- **Run it locally.** Theirs requires the server round trip; that round trip is their single biggest liability and our clearest claim. A local model handles the interval summaries; escalate to a paid model only for the day-level narrative where quality is visible.
- **Structure stays authoritative, prose stays descriptive.** We already compute durations, app totals, page visits, and entities. Their memory throws those away and keeps prose, which is why their product cannot answer "how long." Ours should write a deterministic frontmatter block — start, end, duration, apps, entities, evidence ids — with prose beneath it. **The prose never carries a number that the frontmatter does not.** This is not a style preference: reconstructing a duration from prose is the exact failure class that produced "ten minutes" where the truth was three hours forty-three.
- **Keep the source long enough to redo the work.** Theirs deletes raw events at 48 hours. After that, a wrong memory can never be regenerated — the evidence is gone, and deletion is the only remedy left. Ours must be able to re-derive a memory weeks later, which is what makes a correction propagate instead of merely hiding a bad row.

### The storage layer

Their model is two tiers: raw events, transient and sandboxed, 48 hours; derived memories, permanent and plain-text. The expensive tier is deliberately disposable.

A four-tier version, which is what lets us keep evidence far longer than they do at a fraction of the cost:

| Tier | Contents | Lifetime |
|---|---|---|
| Raw events | Observer callbacks, unmodified | Hours. A crash buffer, not a record. |
| Coalesced intervals | Focus spans with app, document, URL, role, dwell | Long — this is the correctable evidence |
| Structured facts | The existing SQLite tables: sessions, blocks, entities, rollups | Permanent |
| Memory files | Markdown with deterministic frontmatter | Permanent, user-visible, user-deletable |

Three rules make the numbers work:

**Coalesce before writing, not after.** A typing burst is one interval — field, duration, keystroke count — never two hundred keystroke rows. This is the single largest reduction available and it must happen at the capture boundary, because anything written raw has to be read, compacted, and deleted later.

**Intern the repeated strings.** Almost all volume is repetition: bundle identifiers, window titles, URLs, AX roles. An interning table plus integer references collapses most of it. Compress closed segments; leave the open one uncompressed.

**Never store keystroke content by default.** Store that typing happened, where, and how much. Content is a separate consent, and by default we do not have it.

Sizing needs measuring rather than asserting: instrument a real day, record bytes per tier, and set retention from the measurement. The design intent is that tier two stays affordable for months, because that is precisely the capability their 48-hour horizon gives up.

### Where this leaves us

Four differences that follow from architecture rather than from marketing:

1. **Nothing leaves the machine to build the memory.** Theirs sends every event batch to a server.
2. **Time is accounted for.** Their memory is prose; ours carries the numbers in structure.
3. **A wrong memory is fixable, not just deletable.** Theirs cannot be regenerated after 48 hours.
4. **More than interaction events.** Calendar, meetings, git activity, connectors, entities, projects, clients.

## 3. What we take from the interface

Their timeline is the best-designed thing in the release, and the gap between it and ours is not taste. It is structure.

### Anatomy of one of their entries

Read off their History timeline, top to bottom:

1. **Time**, small and muted, on a left rail with a single dot. Not a badge, not a pill.
2. **An outcome title in past tense** — "Prepared a launch update", "Reviewed project feedback", "Organized your work for the day". A thing that was accomplished. Never an application name, never a duration.
3. **One sentence, second person, no numbers** — "You reviewed the launch plan, checked the implementation, and gathered feedback before updating the documentation."
4. **A row of application icons**, and nothing else, as the entire provenance display. No text, no chips, no filenames.
5. **An optional suggestion card**, nested inside the entry, offering a skill or automation with a single blue link. **Not on every entry** — two of the three visible entries have one.
6. **Exactly one accent color**, spent only on the action link. Everything else is text, icon, or hairline.

Three rules are doing the work. Titles are outcomes. Numbers live in structure, never in prose. Colour is spent once.

### What ours does today

From the current Timeline capture, judged the same way:

- The block summary reads **"Spent 3h 37m editing Design, with ai tools and browsing alongside."** It leads with a metric, lowercases "ai", and ends on "alongside", which describes nothing. Theirs would render this as *"You designed the onboarding screens while checking the build."*
- **The header says 3h 59m and the sentence says 3h 37m.** Two different numbers for one block on one screen. This is the prose-carrying-numbers failure, visible in the interface.
- **Calendar events are truncated to unreadability** — "AI Implem…", "9:00 AM…". Three narrow dashed columns crushed against a wide solid one. This is DEV-234 as a user sees it.
- **Three visual systems compete**: a saturated blue fill, dashed grey outlines, and a white card, none of which share a hierarchy.
- **The clarification panel owns roughly forty percent of the width** and is the heaviest element on screen, so the eye lands on a question about a twenty-minute meeting rather than on the day.
- **No application icons anywhere.** The one piece of provenance their design leans on entirely, we do not show at all.
- **Two competing blue elements** — the active block and the "Analyze day" button — so the accent no longer means anything.

Ours is not ugly. It is undifferentiated: everything on screen asks for attention with equal force, so nothing reads first.

### The rules we adopt

- Blocks get an **outcome title and one plain sentence**. No number in the sentence, ever. The duration lives in the header, once.
- **Application icons under every block**, as the primary provenance. They replace the chip wall in the AI tab and give the timeline the visual texture it currently lacks.
- **Events get their own readable column.** Never an ellipsis where a name should be.
- **One accent colour, spent once per screen.** If the active block is blue, the button is not.
- **Clarifications become an inline strip** attached to what they are about, dismissible, never a panel that outweighs the day.
- **Suggestions appear only when there is something to suggest.** Their restraint is the point; a suggestion on every row is noise.
- **Stay light.** Their timeline is dark and ours is light, and that is not the difference. Do not restyle to look like them — fix density and hierarchy.

Their "suggested skill / suggested automation" card is the one feature-shaped thing here, and it is the deferred item in §6. The card is easy; noticing a genuinely repeated workflow is not.

## 4. What we claim

### Audience

Unchanged. Knowledge workers who spend their day on a laptop and already use AI tools — not developers only, not freelancers only.

### Headline

Decision 8. The accepted line described a capability:

> Your digital life, made searchable on demand.

The replacement describes the moment:

> **You did a lot today. Daylens remembers all of it.**

Under it: Daylens is the private memory of what you did on this computer. Ask about that memory in plain language, see where your time actually went, and bring that context into the AI tools you already use.

Keep "Remember everything you did" from [product.md](product.md) as the app's own line. The site headline may be warmer than the product promise; it may not contradict it.

### The three jobs

The first two are proven by their release. The third is ours alone.

1. **Pick up where you left off.** Come back after a meeting, a weekend, or a month and get the thread back without reconstructing it.
2. **Find what you know you saw.** Describe the thing — the page, the document, the discount, the article before the meeting — instead of remembering where it went.
3. **See where your time actually went.** Per project, per client, per month. The job no assistant-native version does at all, and the reason to keep Daylens open rather than only asking an assistant.

Proofs: "What did I actually get done this week?" · "What did I work on for Acme?" · "Where did Tuesday afternoon go?" · "What did I read before that meeting?" · "Draft my weekly update from what I got done this week."

### Surfaces to name

1. **Ask in Daylens** — in-app AI over the same memory as Timeline and Apps.
2. **See the day** — Timeline and Apps: the evidence underneath the answers, and the only place time is accounted for.
3. **Bring context into your tools** — opt-in MCP and handoff into Claude, Codex, Cursor, and similar tools.

Surface 2 moves up. It was supporting evidence; it is now the differentiator, and it should be shown rather than described.

### Claims against the assistant-native version

Defended by §1 and §2. Do not name OpenAI on the site, do not run a comparison table, and do not lead with the competitive angle — someone who has never heard of Computer History should read the page as being about them, not about a rival.

- **Nothing leaves your machine to build the memory.** Theirs ships every event batch to a server to be summarized. Given OpenAI is under a court order to preserve ChatGPT logs, the round trip is concrete, not hypothetical.
- **Where your time went, not just what you did.** The widest gap, and architectural: their memory is prose without numbers.
- **Wrong is fixable, not just deletable.** Their raw events expire at 48 hours, after which a bad memory can only be destroyed. A Daylens correction persists and propagates.
- **Every platform, every country, no subscription tier.** Theirs is macOS-only, paid-tier-gated, administrator-gated in workspaces, and unavailable in the EEA, Switzerland, and the UK. Phrase as availability, not as a swipe.
- **More than interaction events.** Application usage, window titles, page visits, git activity, calendar, meetings, artifacts, file mentions — resolved into entities and projects.

### Privacy line

Activity lives on the laptop in a local database. What leaves the device is what the person chooses to send to a model when they ask — not a silent cloud of their whole day. Do not claim that all AI runs entirely on-device.

Two additions:

- **The memory is a file you can open.** A local database is a claim; a folder you can open is proof. Stronger still because their memory files are unencrypted and readable by any program running as the same user — a risk they document themselves. Depends on decision 2.
- **It is off until you turn it on.** Already true. Saying it answers the first objection a skeptical reader has.

### Voice

Simple, clear, role-agnostic — closer to Notion's breadth than developer-tool jargon. No "open source" pitch on the public site.

One addition: **name the moment before naming the mechanism.** Capture, events, blocks, and evidence are implementation words. They belong in the product, not on the first screen.

## 5. How we announce

Next week, while the category is still being explained by someone else's launch budget.

### The device to copy

Their strongest marketing asset is a segmented toggle — **With Computer History / Without** — showing the same question answered twice. With: a real answer. Without: "I don't have context about what you were doing." No feature list, no benefit copy. The value is demonstrated in the gap between two screenshots.

Copy the device, change the question. Theirs asks "What was I working on before my last break?" — a question we would tie on. Ours should ask something their product cannot answer even with Computer History switched on:

> **"How much time did I spend on Acme last month?"**
>
> **With Daylens:** a real total, broken down by session and application, with the evidence underneath.
>
> **Without:** "I don't have access to your activity."

That is the whole pitch in one image, and it is unbeatable by them specifically, because the missing capability is architectural rather than a feature they have not shipped yet.

### The page

Follow their structure, since it works: a hero with the toggle, then one section per job with a demonstration rather than a description, then the honest privacy section. Lead each section with the moment, not the mechanism.

The timeline illustration is the second asset to build, and it should show a real Daylens day rendered under the §3 rules — outcome titles, one sentence, application icons, one accent colour.

### What not to copy

Their assets and their page. Borrow the structure and the restraint; build our own illustrations in our own visual language. This is practical, not scrupulous: a recognisable clone reads as derivative and quietly concedes the thing we are actually claiming, which is that we have been doing this longer and take it further. The design language is worth learning from. The artwork is theirs.

## 6. What we build

The [V2 order](../V2-PLAN.md) does not change — Timeline, Apps, AI chat, recaps, settings. Computer History raises the floor on a correct answer; it does not change which surface to fix first.

Then, in order:

1. ~~**The readable memory mirror and Codex-directory export**, with the deterministic frontmatter block.~~ **Shipped 2026-08-14.** One Markdown file per finished day under `<userData>/memories/`, optionally mirrored into `$CODEX_HOME/memories/extensions/daylens/`. Written from the same corrected payload Timeline renders, so a deleted block or excluded app never reaches the file and a correction reaches it on the next write. The renderer is pure and deterministic — identical input renders identical bytes, and an unchanged day rewrites nothing. Every number lives in the frontmatter; `proseDurationViolations()` is the enforcement seam for the "no number in prose" rule. Files are written `0o600` via atomic rename. Settings → Memory files carries both toggles, the folder path, the day list, and a per-day "Show file" that opens it in the file manager.

   Three things the first pass got wrong, all found by asking what happens on day 600 rather than by testing the happy path:

   - **Deletion did not reach the files.** `deleteHistoryForApp`, `deleteHistoryForSite`, and `deleteTrackedActivity` left the Markdown untouched, so deleted activity survived on disk in plain text. Now re-projected from `rematerializeAndNotify` (`trackingHistory.ts`), the choke point every purge already passes through.
   - **An agent pointed at the folder would read all of it.** 600 days is ~2.4 MB but ~616k tokens, which overflows any context window and fails by silently truncating. `INDEX.md` is now the entry point: newest first, so truncation keeps recent days; days past the most recent 180 stay listed and linkable but drop their block titles. 600 days indexes to ~17k tokens, five years to ~41k against a 1.9M corpus. It also states where the numbers live and that `corrected: true` outranks inference. Measure with `npm run memory:scale`.
   - **No backfill.** Only days analyzed after the feature shipped got files, so a person with two years of history would open a nearly empty folder. `startMemoryMirrorBackfill` now fills history a few days per tick, using the same day enumeration as the memory index.

   Disk is a non-issue: 4 KB/day, ~7 MB over five years. No retention policy is needed, which matches [privacy-retention-and-sync.md](../specs/privacy-retention-and-sync.md) — organized facts live until deleted.
2. **Timeline entry redesign** to the §3 rules. Cheapest visible quality gain available, and it fixes the DEV-234 legibility defect as a side effect.
3. **The accessibility capture upgrade** — `AXDocument`, `AXWebArea`/`AXURL`, `AXFocusedUIElement`, and observers in place of polling. Most likely fix for the unattributed browser time in Apps.
4. **Menu-bar pause and granular clear.** Low cost, high trust.
5. **Collapsed per-entry provenance**, replacing the chip wall. Already DEV-244; becomes an icon row under item 2.

Deferred, recorded so it is not lost: **repeated-pattern detection** that offers to turn recurring activity into an automation. The strongest idea we do not have. The card is easy; the detection is not, and it needs a correct day underneath it to work at all.

## 7. What is honestly against us

**Their loop works and ours does not yet.** Computer History answers correctly today. Ours reported ten minutes where the truth was three hours forty-three — and the recorded cause was wrong. The docs claimed no calendar or Granola tool was registered for the agent; both are registered (`get_calendar_events`, `read_meeting_notes`, `src/main/agent/contextTools.ts:62,86`, wired through `chatAgent.ts:28`). The defect is real, its cause is unidentified, and it outranks everything else on this page.

**Distribution.** They are already installed.

**Capture cost.** Their event stream is cheap. Every capture addition in §2 holds the line on battery and token cost, not just coverage — and observer-based capture is part of how that line gets held.

**The V2 list is not yet trustworthy in either direction.** The acceptance dossier was graded against a commit predating the six-lane sprint merge, so its open states understate what shipped. Nine defects cannot be verified from code and need a person in the running application. Until that hour is spent, any V2 date is a guess — which is what decision 11 is for.

## 8. What this does not change

The product promise, the audience, and the delivery order. Before this release Daylens had to explain the category from scratch. It no longer does. The work is to stop explaining the idea and take a side inside it: **this is the memory of your computer, and it is yours.**
