<!--lint disable strong-marker-->

# Work Order Entity Index: WO-99

**Initialized At (UTC):** 2026-08-11T08:32:45Z
**Current Status:** in_progress — Phase 3 complete, verdict recorded in `review-log.md`.

## Work Order

- WO-99: [backend] Define the common interpretation and activity-description contract (`eb4b736f-950a-4c28-9d79-583d565f3515`)
  <https://factory.8090.ai/project/45f2f431-ae93-407c-913b-8bce76ba3085/work-orders/99>
  Phase 3. Type: Build. Status on the board: Backlog (every one of the 131 exported
  work orders reads Backlog; the column carries no information).

Source of record for this execution is the 2026-08-11 Factory export
(`~/Downloads/daylens-work-orders-2026-08-11-092326.csv`,
`Daylens_Combined_Requirements.md`, `Daylens_Combined_Blueprints.md`). The MCP
was not called; the export carries the full work order description with its
embedded requirements, and all 39 blueprints.

## Requirements

The `Requirement IDs` column is empty for all six work orders in this lane. The
governing requirements are embedded in each work order description and belong to
the **Voice & Interpretation Contract** requirement node
(`cf885bbe-b4ce-4ba1-b6e5-4813f57949aa`).

**REQ-VIC-001: Apply a shared activity-description policy.**

- **AC-VIC-001.1** — one executable activity-description policy for every
  generated activity description. *Unmet at start.* Two partial policies existed
  (`labelVoice.ts` for labels, `voiceContract.ts` for prose) with a third,
  `recapVoiceFindings`, straddling them.
- **AC-VIC-001.2** — describe the supported activity without naming an
  unsupported subject, project, client, person, or outcome. *Unmet at start.*
  Stated in prompt prose (`CITATION_CONTRACT`), never executable.
- **AC-VIC-001.3** — understood activity before the raw telemetry used to infer
  it. *Partially met.* Enforced for labels only (`activity-not-software`).
- **AC-VIC-001.4** — no raw telemetry, generic wording, application-only
  wording, plumbing wording, judgmental wording, copied titles, or weak activity
  phrases. *Partially met.* All seven forms were checkable for a label; only
  plumbing and hype were checkable for prose.

**REQ-VIC-003: Communicate evidence limits without judgment.**

- **AC-VIC-003.1** — one natural-language uncertainty statement when the
  evidence does not support a confident description. *Unmet at start.* No
  producer of such a statement existed anywhere in the codebase.
- **AC-VIC-003.2** — no focus or productivity judgment from incomplete evidence.
  *Partially met.* `JUDGMENT_RE` existed but was private to `labelVoice.ts`.
- **AC-VIC-003.3** — a model is never the source of recorded durations,
  identities, URLs, files, or events. *Unmet at start as a contract.* Asserted in
  prompt prose; no type in the codebase distinguished an evidence-owned fact
  from model-authored wording.

REQ-VIC-002 and REQ-VIC-004 are out of scope here (WO-104/WO-105 and WO-102) but
their primitives are defined by this work order.

## Blueprints

**Governing — Voice & Interpretation Contract** (`54e028ec-b55e-4036-9799-ddc78d568584`).

Its Key Contracts state this work order's bar directly:

> Every generated activity description uses the same executable policy. The
> policy expresses understood activity before raw telemetry and permits a named
> subject, project, client, person, or outcome only when the available evidence
> supports it.

and:

> Recorded durations, identities, URLs, files, and events remain evidence-owned
> facts. A model can interpret and summarize those facts but cannot originate
> them.

ADR-002 of that blueprint ("Separate interpretation from expression") is the
design constraint: one evidence-backed interpretation feeds every surface, and
format plus `SummaryVoice` are expression-only transforms. This work order builds
the interpretation half.

## Referenced Blueprints

Reached through the governing blueprint's component references and its own
statement that no Component Blueprint documents this cross-surface capability.

- **Voice & Label Policy** — the existing capability this work order extends.
  Its ADR-002 ("Separate label voice from generated-response voice") places label
  evaluation in `labelVoice.ts` and generated-answer directives in
  `voiceContract.ts`. That ADR is the one the codebase violates; see Blueprint
  Alignment in `review-log.md`.
- **Day Recap & Analysis** — `#DayAnalysisCoordinator` is named as the supplier
  of the shared interpretation. Read to size how far the interpretation contract
  can reach without entering `analyzeDay.ts`, which another session owns.
- **Wrapped** — `#NarrativePromptComposer`'s consumer; read to confirm the
  facts/expression split the new policy must not disturb.
- **Corrected Activity Facts** — the evidence boundary that owns durations,
  identities, URLs, files, and events. AC-VIC-003.3 is a statement about this
  boundary, so the provenance vocabulary in the new contract uses its terms.

**Excluded:** Timeline, Apps, Search & Memory, Export & Artifacts, and the
container blueprints hold no contract on the description-policy path.

## Architecture path

`#LabelVoicePolicy` and `#GeneratedVoiceContract` are the two components this
work order converges. The new module sits under both.

- `src/shared/activityDescription.ts` — **created.** The one executable policy:
  rules, vocabulary, the interpretation contract, and the prompt directives that
  state the same policy to a model.
- `src/shared/labelVoice.ts` — reads its vocabulary from the new module; the
  prose check moves out (ADR-002 of Voice & Label Policy).
- `src/main/ai/voiceContract.ts` — reads its vocabulary from the new module and
  re-exports the names its existing consumers import.
- `src/shared/summaryVoice.ts` — untouched by this work order; it is expression,
  and ADR-002 of the governing blueprint keeps expression separate.

## Verified defects

Checked against the code on 2026-08-11 in this worktree.

**D1 — one policy, three implementations.** `labelVoice.ts` defines
`PLUMBING_TERMS` (8 entries), `HYPE_TERMS` (10), and `JUDGMENT_RE` privately.
`voiceContract.ts` defines `PLUMBING_VOCAB` (8 entries, a *different* 8) and
`BANNED_VOCAB` (21). `recapVoiceFindings`, a prose check, lives in
`labelVoice.ts` and scans `PLUMBING_TERMS` and `HYPE_TERMS` — duplicating what
`findPlumbingVocab` and `findBannedVocab` already do in `voiceContract.ts` over
the other two lists. A term added to one list silently fails to bind on the other
surfaces. AC-VIC-001.1 cannot be true while this holds.

The two plumbing lists differ deliberately, and the difference is load-bearing:
`voiceContract.ts` documents that "window titles" must stay sayable, because the
honest capability answer has to name window titles as something Daylens captures,
while a *label* reading "window title" is always wrong. Convergence therefore has
to preserve two scopes with one definition site, not collapse the lists.

**D2 — no executable check for an unsupported named detail (AC-VIC-001.2).**
`CITATION_CONTRACT` states the rule to the model in prose. Nothing evaluates a
produced description against the evidence that was actually available, so the
rule is unenforceable and untestable.

**D3 — no uncertainty producer (AC-VIC-003.1).** Grepped: no function anywhere
returns a natural-language uncertainty sentence. Surfaces improvise. The Wrapped
path has `EVIDENCE_HONESTY_DIRECTIVES` telling the model what not to claim, which
is the opposite duty.

**D4 — no provenance type (AC-VIC-003.3).** No type in `src/shared` or
`src/main` distinguishes an evidence-owned fact from model-authored wording, so
"a model cannot originate a duration" is an instruction, never a contract.

## Delivery

- Branch: `wave/4-voice`
- Pull Request URL: not opened by this execution; the lane pushes the branch and
  the owner decides on the PR.
