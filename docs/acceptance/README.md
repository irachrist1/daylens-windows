# The acceptance dossier

The graded record of what passes and what still fails, surface by surface.

`docs/V2-SHIP-PRIORITIES.md` names this dossier as the authority for every
change. It previously lived outside the repository, at
`~/Desktop/daylens/ACCEPTANCE.md`, and was not present on the machine that
needed it. A grading authority that can go missing cannot be the authority, so
it lives here now, versioned with the code it grades.

The private `spcsorg/daylens-ux-audit` repository holds its own `INDEX.md` and
`ACCEPTANCE.md` for the screenshot UX audit. Those are different files. This
repository is public, so nothing carrying captured activity — screenshots,
calendar entries, colleague names, browsing history — moves here.

## Files

- [performance.md](performance.md) — 60 further acceptance lines (database, background
  cost, correctness). Not counted in ACCEPTANCE.md's 24-line total.

- [ACCEPTANCE.md](ACCEPTANCE.md) — the acceptance lines per surface, each with a
  state and the evidence behind it.
- [INDEX.md](INDEX.md) — every tracked defect, its true board state, and where
  the layers currently disagree.

## States

A line carries exactly one state. The distinction that matters is between code
that merged and behavior that was observed.

| State | Meaning |
| --- | --- |
| `passing` | Observed working in the running application, with evidence recorded |
| `landed` | Implementation merged; no running-application evidence yet |
| `open` | Not implemented |
| `executing` | An active work order under `.sw-factory/` |

`landed` is not a pass. Every defect in `V2-SHIP-PRIORITIES.md` — a button that
always reports success, a merge that silently does nothing — was `landed` code
by any automated measure. Only `passing` closes an acceptance line.

## Grading a line

A line moves to `passing` when someone opens the application, performs the
action the line describes, and records what happened. Reference screenshots
belong beside the observation. The `review-log.md` of the work order that
delivered the change is the normal place for that evidence; this dossier cites
it.

Nothing here is graded from a test result, a commit message, or a Linear status.
Those establish `landed`, and no more.
