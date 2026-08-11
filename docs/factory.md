# The factory

One delivery loop, four record layers, one graded record of what passes.

[Developing Daylens](development.md) already describes the loop from idea to
shipped change. This document does not replace it. It names where each record
layer lives, and adds the one thing the loop was missing: a per-issue execution
trail that survives the session that produced it.

## Record layers

| Layer | Question it answers | Where it lives |
| --- | --- | --- |
| Requirements | What must be true from outside the system | `docs/specs/` |
| Blueprints | How the system is arranged inside | `docs/blueprints/`, `docs/codebase/architecture.md` |
| Work orders | What is being delivered now | Linear, the Daylens Version 2 project |
| Execution | What was actually planned, reviewed, and verified | `.sw-factory/<issue>/` |
| Acceptance | What passes and what still fails | `docs/acceptance/` |

A layer is only authoritative for its own question. A specification does not
authorize implementation; a passing test does not mean an issue is accepted.
Acceptance is the graded record, and it is the only place that says a surface
works.

## What the execution layer adds

The [Software Factory skill](../.agents/skills/software-factory/SKILL.md) is
vendored into this repository and provides the execution harness. Initializing a
work order creates `.sw-factory/<issue>/` with four files:

- `checklist.md` — every step, ending `[x]` or `[SKIP]` with a reason
- `context.md` — the requirements, blueprints, and delivery links in play
- `implementation-plan.md` — written *before* any implementation file is touched
- `review-log.md` — one appended round per review pass, ending in a verdict

These are committed. Git history is the archive, and an execution directory is
the evidence that a change was planned, reviewed, and verified rather than
merely merged.

The harness exists because of one recurring failure: code that typechecks,
passes tests, and was never opened and clicked. `docs/V2-SHIP-PRIORITIES.md`
records the pattern — a re-analyze button that "always reports 'Labels
refreshed'", a merge that does nothing with no error, a screen-context page that
claims to be on while its extraction is not installed. The checklist's
user-facing verification step is not optional and cannot be satisfied by a green
suite.

## Claiming work

Unchanged from `AGENTS.md`: implementation is claimed from the Todo column of
the Daylens Version 2 project. Backlog means an open blocker or an unaccepted
specification, and Backlog issues are never worked.

The execution directory is named for the Linear issue it delivers —
`.sw-factory/DEV-292/`, not `WO-292` — so the trail and the board use one
identifier.

At handoff the issue moves to In Review. It moves to Done only on explicit
acceptance, per [Developing Daylens](development.md).

## Verification spine

`npm run verify:shipping` is the gate. The execution checklist records which of
its stages ran and what they proved. Paid-provider evaluations require explicit
approval before they run — see [Benchmarks](hygiene/benchmarks.md).

Automated verification is necessary and not sufficient. Every work order whose
change is visible to a person also carries an exploratory pass against the
running application, with its findings in `review-log.md`.

## Keeping the layers honest

The layers drift, and drift is what makes the factory lie. Two failures have
already happened and are worth naming:

- A specification or priorities document describing a fixed defect as a live
  failure. `docs/V2-SHIP-PRIORITIES.md` described eight Timeline and recap
  defects as current after they were closed.
- A board issue sitting in Backlog after its implementation landed. DEV-239,
  DEV-240, DEV-248, and DEV-249 through DEV-253 all had merged commits while
  Linear still listed them as Backlog.

Reconciling the layers is part of closing a work order, not a separate cleanup.
When an execution directory reaches handoff, the acceptance dossier and the
board must agree with what the working tree now does.
