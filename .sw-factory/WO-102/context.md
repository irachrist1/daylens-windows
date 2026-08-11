<!--lint disable strong-marker-->

# Work Order Entity Index: WO-102

**Initialized At (UTC):** 2026-08-11T08:32:45Z
**Current Status:** in_progress — Phase 3 complete, verdict recorded in `review-log.md`.

## Work Order

- WO-102: [backend] Apply shared interpretation with verbatim user-label precedence (`e677fc65-d845-4487-91ca-f37d5333d6e6`)
  <https://factory.8090.ai/project/45f2f431-ae93-407c-913b-8bce76ba3085/work-orders/102>
  Phase 3. Type: Build. Board status Backlog, which carries no information here.

Source of record: the 2026-08-11 Factory export. See `.sw-factory/WO-99/context.md`
for the full note on why the MCP was not called.

## Requirements

**REQ-VIC-001** (all four criteria, as in WO-99) and:

**REQ-VIC-004: User-authored labels always take precedence.**

- **AC-VIC-004.1** — a user-authored label is used verbatim and is never
  altered, rejected, or replaced by the activity-description policy. *Met in
  substance at start, untested.* `userVisibleBlockLabel` returns
  `block.label.override` before any policy runs, and `labelCandidateViolation`
  is only ever called on model candidates. Nothing asserted it, so nothing would
  catch a regression.
- **AC-VIC-004.2** — a user-authored label is presented in preference to any
  generated activity description. *Met at the read path, broken at the prompt
  path.* See D1.
- **AC-VIC-004.3** — a propagated user-authored label must not have its
  unsupported detail represented as a system-derived fact. *Unmet.* See D2.

## Blueprints

**Governing — Voice & Interpretation Contract** (`54e028ec-b55e-4036-9799-ddc78d568584`).

The binding statement for this work order, from Feature-Specific Components:

> #BlockLabelFinalizer depends on #LabelVoicePolicy to separate evidence from
> user-facing wording. It currently lets a user override win before policy
> evaluation. The required precedence and any invariant treatment for an
> override remain an explicit product decision.

and from Key Contracts:

> The user-authored-label precedence rule is pending product confirmation. Until
> it is decided, downstream consumers must not represent user wording as an
> evidence-derived fact.

Both sentences are stale: REQ-VIC-004 *is* the product decision, and it decides
in favour of what the code already does. Recorded under Blueprint Alignment in
`review-log.md`.

The Integration Contract this work order actually enforces:

> #BlockLabelFinalizer supplies a policy-checked label and its source on
> `WorkContextBlock`; Timeline and Apps consume that same finalized activity
> meaning.

"That same finalized activity meaning" is what D1 breaks: the narrative prompts
consume a different one.

## Referenced Blueprints

- **Voice & Label Policy** — `#TimelineLabelPolicyAdapter` and its ADR-002.
- **Corrections** — owns `block_label_overrides` and the corrected-label review
  state, the two paths that produce a user-authored label. Read to confirm both
  set `label.source = 'user'`.
- **Timeline** — the consumer whose displayed label is the parity reference.
- **Day Recap & Analysis** — the surface whose prompt diverges.

## Architecture path

- `src/shared/blockLabel.ts:142` — `userVisibleBlockLabel`, the resolution every
  screen uses and the parity reference. Not changed by this work order.
- `src/shared/labelVoice.ts` — gains the provenance helpers. **Owned.**
- `src/main/jobs/aiService.ts`, prompt-building region only —
  `buildDaySummaryScaffold` and `buildWeekReviewBundle`. **Shared file; edits
  confined to the prompt-building region, and that confinement is stated in
  `review-log.md`.**
- `src/main/services/workBlocks.ts:4918` — where `source: 'user'` is set. Read
  only; another session owns this file.

## Verified defects

Read against the code on 2026-08-11.

**D1 — the narrative prompts describe blocks by a label no screen shows
(AC-VIC-004.2, AC-VIC-001.1).** Six prompt sites send `block.label.current` raw:
`aiService.ts:1876` (day recap scaffold), `:2146`, `:2189`, `:2217`, `:2256`,
`:2588` (week review bundle). Every screen renders `userVisibleBlockLabel(block)`
instead, which falls through `override → current (gated on isUsefulLabel) →
aiLabel → ruleBasedLabel → top artifact → site name → category floor`.

The two diverge whenever `current` fails `isUsefulLabel`, and that is the common
case, not an edge: the finalizer's floor is
`prettyCategory(block.dominantCategory)` (`workBlocks.ts:4916`), which produces
"Development", "Browsing", "Communication" — all members of `GENERIC_LABELS`, all
rejected by `isUsefulLabel`. On such a block the person sees the artifact title
or the AI label on screen while the recap prompt is told "Development" and writes
the day around that word.

`userVisibleBlockLabel` is already imported in `aiService.ts` at line 36 and used
at exactly one place, `recapWorthyLabel` (line 1780). The fix is to use it at the
other six.

**D2 — provenance is not propagated (AC-VIC-004.3).** No prompt anywhere tells a
model which labels are the person's own words. `BlockLabel.source` already
carries `'user'` (`types.ts:1442`, `LabelSource` at `:1343`) and both user paths
set it: the corrected-review path (`workBlocks.ts:1837`) and the
`block_label_overrides` path (`workBlocks.ts:4918`). Nothing reads it into a
prompt.

The consequence is the exact failure AC-VIC-004.3 names. A person renames a
block to "Ridgeline renewal" when no captured evidence names Ridgeline. The
recap prompt receives "Ridgeline renewal" indistinguishable from an
evidence-derived label, and the model writes "you worked on the Ridgeline
renewal" as an observation. Daylens has now told the person a fact it learned
from the person, as though it had seen it.

**D3 — the policy bypass is real but implicit (AC-VIC-004.1).** A user override
is returned verbatim before any rule runs, and `labelCandidateViolation` is
called only on model candidates (`aiService.ts:3072`,
`interpretationAgent.ts:105`). Correct, and asserted nowhere. A future change to
the label chooser that started policy-checking overrides would pass every
existing test.

**Checked and NOT a defect:** `daySummaryCacheKey` (`aiService.ts:1830`) keys on
`block.label.current`. Because the finalizer writes the override into `current`,
a rename does change the key and the recap does regenerate. Recorded because it
looks like a cache-invalidation bug and is not one.

## Delivery

- Branch: `wave/4-voice`
- Pull Request URL: opened against `factory/v2-ship` at the end of the lane.
