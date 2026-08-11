<!--lint disable strong-marker-->

# Work Order Entity Index: WO-106

**Initialized At (UTC):** 2026-08-11T08:32:45Z
**Current Status:** in_progress — Phase 3 complete, verdict recorded in `review-log.md`.

## Work Order

- WO-106: [backend] Replace telemetry-based time-chunk wording with policy-compliant descriptions (`281b6e08-5156-487f-ba6d-2c4e83900f48`)
  <https://factory.8090.ai/project/45f2f431-ae93-407c-913b-8bce76ba3085/work-orders/106>
  Phase 3. Type: Build. Board status Backlog, which carries no information here.

Source of record: the 2026-08-11 Factory export. See `.sw-factory/WO-99/context.md`.

## Requirements

**REQ-VIC-001** (AC-VIC-001.1 through .4) and **REQ-VIC-003** (AC-VIC-003.1 through .3), as embedded in the work order description.

## Blueprints

**Governing — Voice & Interpretation Contract** (`54e028ec-b55e-4036-9799-ddc78d568584`).

## Referenced Blueprints

- **AI Agent** — owns `#TimeChunkAnswerRenderer` and the deterministic interval presentation.
- **Voice & Label Policy** — `rawLabelForm` / `naturalizeLabel` reused for title filtering.

## Architecture path

- `src/main/agent/timeChunkAnswer.ts` — **Owned.** `rowDescription` is the policy consumer.
- `src/main/agent/daylensTools.ts` — read only. Already supplies `blockLabel` via `userVisibleBlockLabel` and `gap.kind`. Not edited (another session may own tool wiring; this work order only needs the renderer).
- `src/shared/labelVoice.ts`, `src/shared/blockLabel.ts` — reused, not changed here.

## Verified defects

**D1 — rows led with the app.** `Editor: Project review` put telemetry first (AC-VIC-001.3 / .4).

**D2 — raw titles printed verbatim.** URLs, tab soup, and filenames became the description.

**D3 — idle gaps judged the person.** Producer label `likely away or idle` was printed verbatim; unobserved time is unknown, never idle.

**D4 — naturalize could salvage tab soup.** Filtering only the naturalized form let `Inbox | Gmail | Unread (12) | Chrome` become `Unread (12)`. Fixed by rejecting `rawLabelForm` on the original title first.

## Delivery

- Branch: `wave/4-voice`
- Pull Request URL: opened against `factory/v2-ship` at the end of the lane.
