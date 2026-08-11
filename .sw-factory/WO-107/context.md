<!--lint disable strong-marker-->

# Work Order Entity Index: WO-107

**Initialized At (UTC):** 2026-08-11T08:32:45Z
**Current Status:** in_progress — Phase 3 complete, verdict recorded in `review-log.md`.

## Work Order

- WO-107: [backend] Expand cross-surface policy tests (`277fb25c-d07a-49dd-b99c-a6edd0ce7557`)
  <https://factory.8090.ai/project/45f2f431-ae93-407c-913b-8bce76ba3085/work-orders/107>
  Phase 3. Type: Build. Board status Backlog, which carries no information here.

## Requirements

REQ-VIC-001, REQ-VIC-002, REQ-VIC-003, and REQ-VIC-004 — all acceptance criteria, as embedded in the work order. This work order is the automated protection that the earlier work orders in the lane made executable.

## Blueprints

**Governing — Voice & Interpretation Contract** (`54e028ec-b55e-4036-9799-ddc78d568584`).

## Referenced Blueprints

- Voice & Label Policy — label vs prose split.
- AI Agent — agent and time-chunk consumers.

## Architecture path

- `tests/crossSurfacePolicy.test.ts` — **created.** Names every policy consumer and asserts each REQ-VIC criterion against the landed code.
- No production files changed (work order Out of Scope).

## Delivery

- Branch: `wave/4-voice`
- Pull Request URL: opened against `factory/v2-ship` at the end of the lane.
