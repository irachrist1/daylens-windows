# Shipping Daylens V2

**Status:** Active. Maintained against the running desktop application.

Daylens V2 is complete when the desktop experience is dependable: capture is
trustworthy, Timeline and Apps agree on the same day, corrections persist,
search retrieves useful detail, and the AI agent answers real questions from the
same memory. Every planned surface already exists in the shipped application.
What remains is the distance between what each surface does today and what a
person needs it to do.

This document describes that distance, surface by surface. It is judged from the
outside — by what a person sees and can accomplish, not by internal
architecture. A change belongs to V2 when it moves one of the surfaces below
from its current behavior toward its intended behavior.

The graded record of what passes and what fails on a real machine is the
acceptance dossier on the owner's Mac (`~/Desktop/daylens/ACCEPTANCE.md` and
`INDEX.md`) plus private `npm run verify:real-day` baselines. This document
tracks which dossier failures are already locked by hermetic tests on `main`,
and which still need an owner regrade before they can be closed.

## How to re-verify

```bash
npm run verify:ship-priorities   # hermetic battery + status table for every item below
npm run verify:synthetic-day     # privacy + representative synthetic day
npm run verify:ai-turn           # one end-to-end AI turn through real seams
npm run timeline:eval            # offline day fixtures (add --strict for voice targets)
```

Owner-only (private data, never CI):

```bash
npm run verify:real-day
npm run verify:real-day:desktop -- --date YYYY-MM-DD --user-data ABSOLUTE_ISOLATED_USER_DATA --output ABSOLUTE_PRIVATE_OUTPUT
```

Follow the Mac walkthrough in [docs/testing/v2-manual.md](testing/v2-manual.md)
when closing OPEN or PARTIAL items.

## Verified fixed on `main`

These failures used to be the Timeline "Today" list. They are locked by
hermetic tests. `npm run verify:ship-priorities` must stay green.

| ID | Surface | Intended behavior | Locked by |
| --- | --- | --- | --- |
| DEV-232 | Timeline | Continuous work stays one block; same-label fragments repair without inventing AI opinion | `workBlockSplitting`, `timelineSegmentation`, `sameLabelFragmentMerge` |
| DEV-233 | Timeline | A merge the person asks for always applies, including across an absence; failures surface in the UI | `correctionCommands`, `timelineAbsenceRepair`, `workBlockSplitting` |
| DEV-231 | Timeline | Re-analyze reports what it actually did (`mergedCount` / relabeled), not a generic "Labels refreshed" | `timelineAutoAnalyze` |
| — | Cross-surface | Adversarial synthetic day through capture → connectors → search → memory → AI | `brutalDay` |

**Decided Timeline behavior (still the rule).** The live day is a single block
spanning the time the laptop has been on, split only where the laptop went
absent, asleep, or idle. That block is divided into smaller labeled blocks only
when the person clicks Analyze-day-with-AI (available once the day holds at
least two hours of tracked time) or when the day ends and a new one begins. The
rule that blocked merges across an absence is removed.

## Partial — code landed, needs a short owner regrade

| ID | Surface | What landed | What still needs eyes |
| --- | --- | --- | --- |
| DEV-234 | Timeline | Overlap columns (`timelineBlockLayout`) | Filter bare-bar / no colliding text has no dedicated hermetic — confirm on a filtered day |
| DEV-230 | Timeline | Attended/correction toast auto-dismisses (~6s) | No hermetic UI test — confirm toast goes away |
| DEV-244 | AI | Activity trail collapses | Confirm chat no longer dumps a wall of file chips; greeting attaches nothing |
| DEV-243 | AI | Load error + Retry instead of infinite spinner | Confirm the tab never sticks on blank "Loading AI…" |
| DEV-247 | Recaps / wraps | Grounded recap + wrap honesty/export hermetics | Confirm slides look clean and export matches what you want visually |

## Still open — do these next

Work these in surface order. Hermetic green is not enough; each needs a pass on
a real day before it is closed.

### Apps — DEV-237

Apps explains where time went, per application. Its center is the "What you did
there" account, and that account is still the open quality bar.

**When it's right**

- Opening any application shows accurate plain-language prose — never raw JSON.
- Browser time resolves to real pages, or one plain sentence explains why it
  cannot.
- Junk strings are filtered, an application never appears twice, sub-few-second
  visits collapse, icons and ranking are believable, and Generate never freezes
  at thirty days.

**How to close.** Regrade Apps on a real week per
[docs/testing/v2-manual.md](testing/v2-manual.md). Add or extend hermetic
fixtures only after the owner failure is named.

### AI chat — DEV-246, DEV-242

**When it's right**

- The first numeric answer to a factual question is correct without pushback,
  and matches Timeline and Apps for the same scope (DEV-246).
- Provider and model have one source of truth in Settings and the chat picker
  (DEV-242). A provider either works for chat or is not offered.

**How to close.** With a real key, ask duration questions against a known day
and confirm Settings ↔ picker never disagree. `aiTimelineParity` only proves
tool and Timeline share a number — it does not prove first-answer quality.

### Real-day reconciliation

Tracked in
[docs/tickets/real-day-timeline-apps-reconciliation.md](tickets/real-day-timeline-apps-reconciliation.md).
Private days (2026-07-13 / 16 / 17) stay failing benchmarks until Timeline,
Apps, meetings, and the agent agree on one corrected day. Close only via
`npm run verify:real-day` + explicit acceptance.

### Settings and legibility

Settings pages must say what they do in few words, keep toggle state, and never
claim a feature is on when its dependency is missing. This is still an owner
visual/pass-fail bar — no hermetic suite replaces it.

### Label voice targets

Hard label-voice **invariants** hold under `npm run timeline:eval`. The
**target** rules (2–7 word activity phrases, activity-not-software) still miss
on thin Slack-style blocks under `--strict`. That is a remaining quality gap,
not a regression of DEV-232/233.

## Sequence

The surfaces are worked in this order, because each depends on the day beneath
it being right:

1. **Timeline** — hermetic core verified above; finish PARTIAL regrades.
2. **Apps** — DEV-237.
3. **AI chat** — DEV-246, then DEV-242 / 244 / 243.
4. **Recaps and wraps** — finish DEV-247 visual regrade.
5. **Settings and remaining surfaces** — legibility and predictable behavior.
6. **Real-day acceptance** — private baselines after the surfaces agree.

Foundation work — capture reliability, cost controls, startup performance — is
in service of these surfaces, not a substitute for them. It is finished when the
acceptance lines it supports pass, and it does not displace the surface work
above.
