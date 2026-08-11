<!--lint disable strong-marker-->

# Implementation Plan: WO-53

**Work Order:** WO-53 — [backend] Enforce evidence coverage for factual answers
**Created At (UTC):** 2026-08-11T14:44:40Z

## Summary

Add evidence enforcement to the existing chat answer pipeline. Eligible totals
and counts are computed from the one canonical corrected-facts boundary before
the model writes, handed to it as authoritative, and then enforced against the
finished answer so a wrong figure cannot reach the person. Every remaining
factual claim is bound to the evidence item that backs it, and any figure
nothing backs is admitted in words.

The guiding constraint is that there must remain exactly ONE definition of
activity, time, and attribution. Nothing here recomputes activity; it reads
`queryCorrectedActivityFactsForDay` and derives from that single read.

## Code Reuse And Package Structure

Reuse unchanged:

- `queryCorrectedActivityFactsForDay` — the only source of activity totals.
- `aggregateAppSummaries` + `getStoredCanonicalAppLinks` — the same app rollup
  and canonical-identity dedupe the Apps view uses.
- `getCorrectedWebsiteSummariesForRange` — site counts.
- `ownedDayBounds` — day boundaries.
- `ContextPacket.request.timeRange` — the only date-scope resolver.
- `extractNamedEntities` from `src/main/ai/citations.ts` — entity claims.
- `resolvePacketCitations` — marker citations, left exactly as it was.

New files:

- `src/main/agent/factClaims.ts` — the shared scanners (durations, integers,
  clock times, ISO dates) plus `renderDuration`. One scanner so "what counts as
  a stated duration" cannot drift between the enforcer and the coverage pass.
- `src/main/agent/deterministicFacts.ts` — detection, computation, and
  enforcement of eligible totals and counts (AC-AIA-002.4).
- `src/main/agent/evidenceCoverage.ts` — the exchange evidence index, claim
  extraction, coverage assessment, and the uncertainty disclosure
  (AC-AIA-002.1, .2, .3).

Modified:

- `src/main/agent/chatAgent.ts` — wiring only, plus the additive `evidence`
  field on `ChatAgentResult`.

No schema change and no migration: nothing new is persisted by this work order.

## Components And Flow

Within one `runChatAgentTurn`:

1. The context packet is assembled and recorded (unchanged, other lane's code).
2. `deterministicFactsForQuestion` reads the packet's resolved time range,
   gates cheaply on question shape, then does ONE read of the corrected
   boundary for the scope and derives every requested fact from that snapshot.
3. The computed facts render into the turn-specific (uncached) system section
   next to the packet, marked authoritative.
4. The model streams; the existing time-chunk table and grounding retry run
   unchanged.
5. `buildExchangeEvidence` indexes this turn's packet items, this turn's
   successful tool results, and this turn's computed facts. Nothing else is
   offered to it.
6. `enforceDeterministicFacts` compares stated figures against computed ones
   and repairs a wrong one.
7. `assessEvidenceCoverage` binds each claim to a backing evidence item;
   `applyUnsupportedFactDisclosure` makes the answer admit unbacked figures.
8. `resolvePacketCitations` and `sanitizeForRender` run last, unchanged.

Ordering rationale: enforcement runs AFTER the grounding retry so the retry
cannot reintroduce a wrong total, and BEFORE coverage so a repaired figure is
assessed as the figure that actually ships.

## Design Decisions

**Repair rather than a second model round-trip.** The grounding path already
spends one retry. A retry cannot guarantee the model complies on the second
attempt, and AC-AIA-002.4 asks for a guarantee. Substituting the computed
rendering in place is deterministic and cheap.

**Target the first UNBACKED figure, not the first figure.** An answer usually
leads with a headline number and then names components quoted from evidence
("you worked 6 hours, 45m of it in Slack"). Overwriting a component would turn
a correct detail into a false one. The figure the exchange cannot back is the
one the model produced itself, which is exactly the claim at issue.

**Counts are noun-anchored.** A count claim is a number attached to the thing
counted ("12 apps"), never a bare integer, so the digits inside a date or a
clock time can never be rewritten as "how many apps".

**Silence when the fact was not stated.** If an answer states no figure for the
requested aggregate, nothing is spliced in. There is no claim to override, and
injecting a number into prose that was answering something else corrupts an
otherwise correct answer.

**One headline figure per dimension.** Policing every incidental number would
need claim-to-subject attribution the answer text does not reliably carry, and
a mis-attributed repair is worse than none.

**Coverage disclosure is limited to figures.** Naming every unmatched word
would bury a good answer in hedging and read as the machinery talking about
itself, which the voice contract bans.

## Testing

New file `tests/agentEvidenceCoverage.test.ts`.

Per criterion:

- **AC-AIA-002.4** — computed total equals `queryCorrectedActivityFactsForDay`
  exactly; a Timeline deletion moves the computed total with it; a correctly
  stated figure (digits or words) is left byte for byte; an answer stating no
  figure is not spliced; a component quoted from evidence is not mistaken for
  the headline; a count never rewrites the digits of a date or clock time;
  detection stays off non-aggregate questions; an app is only named when it is
  really a captured app. **End-to-end: a model that returns "6 hours" for a day
  the boundary computes as 3h 30m does not deliver that number to the user.**
- **AC-AIA-002.1** — a supported claim binds to the identity of the evidence
  item that backs it; an unbacked claim is reported rather than bound; a failed
  tool call is not evidence; a grounded answer gets no spurious caveat.
- **AC-AIA-002.2** — an unsupported figure is named as uncertain with the
  original answer intact; the sentence passes `findBannedVocab` and the em-dash
  ban; an answer that already admits the limit is not double-hedged;
  end-to-end, a fabricated figure reaches the person marked uncertain.
- **AC-AIA-002.3** — the evidence index is built from packet, tool trace, and
  computed facts alone; end-to-end, a turn given a distinctive system
  directive, a distinctive API key, and unrelated thread history produces
  inspection output containing none of them, while still being non-empty.
- Scanner behaviour the enforcement rests on, including negative cases (clock
  times, "3 metres", ISO dates produce no durations).

Regression: full `npm test`, plus `npm run typecheck` and `npm run lint`.
