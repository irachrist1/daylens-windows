<!--lint disable no-undefined-references strong-marker-->

# Implementation Plan: WO-99

**Work Order:** WO-99 — [backend] Define the common interpretation and activity-description contract
**Created At (UTC):** 2026-08-11T08:32:45Z

## Summary

Create one executable activity-description policy and one shared interpretation
contract, then make the two existing policy modules read from it instead of
carrying their own copies. Nothing downstream changes behaviour in this work
order: it defines the primitives WO-102, WO-104, WO-105, WO-106, and WO-107
consume. Prompt wiring, label finalization, and time-chunk wording stay out, as
the work order's Out of Scope states.

## Code Reuse And Package Structure

Reused rather than rebuilt:

- `src/shared/labelVoice.ts` — `PLUMBING_TERMS`, `HYPE_TERMS`, `JUDGMENT_RE`,
  `RECAP_INTERNAL_PHRASES`, `rawLabelForm`. These are the real, hard-won
  vocabulary of this product; the new module adopts them verbatim rather than
  inventing a parallel list. Each carries a comment explaining why it is narrow,
  and those comments move with the terms.
- `src/main/ai/voiceContract.ts` — `BANNED_VOCAB`, `PLUMBING_VOCAB`,
  `CITATION_CONTRACT`. Same treatment.
- `src/shared/blockLabel.ts` — `looksLikeRawArtifactLabel`, already used by
  `rawLabelForm`. Untouched.

Created:

- `src/shared/activityDescription.ts` — the one policy. Placed in `src/shared`
  because `labelVoice.ts` lives there and cannot import from `src/main`;
  `voiceContract.ts` (main) importing from shared is the direction the codebase
  already uses.

Modified:

- `src/shared/labelVoice.ts` — imports its vocabulary; `recapVoiceFindings`
  becomes a compatibility re-export of the shared implementation.
- `src/main/ai/voiceContract.ts` — imports its vocabulary and re-exports
  `BANNED_VOCAB` / `PLUMBING_VOCAB` so no consumer changes.

No schema change and no migration. This work order stores nothing; the reserved
migration range 85-89 is not drawn on.

## Components And Flow

The new module is the executable form of `#LabelVoicePolicy` and
`#GeneratedVoiceContract` under one roof, and it carries the interpretation
contract that ADR-002 of the governing blueprint requires
(`#DayAnalysisCoordinator` supplies one interpretation; surfaces apply format and
tone as expression-only transforms).

Four parts, in dependency order:

1. **Vocabulary.** One definition site, two scopes. `BANNED_VOCAB` and
   `PROSE_PLUMBING_VOCAB` are the chat-answer lists (narrow, "window titles"
   stays sayable). `LABEL_PLUMBING_VOCAB` and `LABEL_HYPE_VOCAB` are the
   label-scoped lists, which include forms that are fine in prose and wrong in a
   short label. `DESCRIPTION_PLUMBING_VOCAB` is the union used for generated
   prose about a day. `JUDGMENT_RE` and `INTERNAL_TEMPLATE_PHRASES` are shared
   whole. D1's constraint — the two plumbing lists differ on purpose — is
   preserved by keeping them separate constants, not by merging them.

2. **The interpretation contract.** `SupportedInterpretation`: the activity in
   the person's terms, the named details the evidence supports (each with the
   evidence kind that supports it), the capture limits, and the provenance of the
   wording (`evidence` | `user` | `model`). `EVIDENCE_OWNED_FACTS` names the five
   fact kinds AC-VIC-003.3 reserves to the evidence boundary, and
   `assertEvidenceOwned` is the check that a description quotes a duration,
   identity, URL, file, or event only when the interpretation carried it.

3. **The evaluator.** `ACTIVITY_DESCRIPTION_RULES` — nine named rules across
   invariant and target tiers, one per acceptance criterion clause, so a failure
   reports which criterion it broke. `evaluateActivityDescription(text, context)`
   returns one finding per rule. `activityDescriptionFindings(text)` is the
   flat prose scan that replaces `recapVoiceFindings` with the same shape, so
   existing callers keep working.

4. **The directives.** `ACTIVITY_DESCRIPTION_DIRECTIVES` states the same policy
   to a model, as prompt lines. Prompt text and checker are generated from the
   same constants where the rule is a vocabulary ban, so the prompt cannot drift
   from what the check enforces. This is what makes AC-VIC-001.1 verifiable: one
   policy, stated once, enforced once.

## Steps

1. Write `src/shared/activityDescription.ts` with the four parts above. Move the
   vocabulary comments across intact — they record why each list is narrow, and
   losing them invites a future widening that breaks the honest capability
   answer.

2. Point `labelVoice.ts` at the shared vocabulary. `PLUMBING_TERMS` and
   `HYPE_TERMS` become imports of `LABEL_PLUMBING_VOCAB` and `LABEL_HYPE_VOCAB`;
   `JUDGMENT_RE` becomes an import. Label rule behaviour must not change: the
   label lists keep exactly their current members.

3. Move the prose check out of `labelVoice.ts` (ADR-002, Voice & Label Policy).
   `recapVoiceFindings` and `RecapVoiceFinding` stay exported from that file as
   named re-exports of the shared implementation, with a comment saying where the
   implementation lives and why. No consumer changes in this step.

4. Point `voiceContract.ts` at the shared vocabulary and re-export
   `BANNED_VOCAB` and `PLUMBING_VOCAB`. `tests/voiceContract.test.ts` asserts the
   exact 21-entry banned list through that import and must stay green untouched:
   that test is the proof the convergence changed no vocabulary.

5. `assertEvidenceOwned` and `uncertaintyStatement` are the two new behaviours
   with no existing counterpart. Both are pure and total: `uncertaintyStatement`
   returns one sentence or null, never a paragraph, and never a judgment word,
   because AC-VIC-003.1 and AC-VIC-003.2 are one requirement in practice.

## Testing

New: `tests/activityDescriptionPolicy.test.ts`. Existing tests that must stay
green untouched are the proof of no-drift: `tests/labelVoice.test.ts` (label rule
behaviour unchanged), `tests/voiceContract.test.ts` (vocabulary unchanged),
`tests/recapVoice.test.ts` (the prose check behaves identically through the
re-export).

Scenarios, each named for the criterion it holds:

- AC-VIC-001.1: `LABEL_VOICE_RULES` and `ACTIVITY_DESCRIPTION_RULES` draw their
  vocabulary from the same constants — asserted by identity, not by copying the
  lists into the test.
- AC-VIC-001.2: a description naming a client the interpretation does not
  support fails `no-unsupported-detail`; the same description with that client
  in the interpretation's supported details passes.
- AC-VIC-001.3: a description that leads with an app name and mentions the work
  second fails `activity-before-telemetry`; the reverse order passes.
- AC-VIC-001.4: each of the seven banned forms fails its own rule, with the
  offending fragment named in the finding.
- AC-VIC-003.1: an interpretation with a capture limit produces exactly one
  sentence; a complete interpretation produces null.
- AC-VIC-003.2: the uncertainty sentence carries no judgment word, checked
  against `JUDGMENT_RE` itself rather than a copy.
- AC-VIC-003.3: `assertEvidenceOwned` rejects a duration, a URL, a filename, and
  an identity that the interpretation never carried, and accepts each when it
  did.
- The two plumbing scopes stay separate: "window titles" passes the prose scan
  and fails the label scan. This is D1's constraint as a regression test.

Fixtures are invented activity throughout — an invented client, an invented
repository, invented window titles. No real recap, label, or narrative from any
real day enters this repository.

Commands:

```bash
node scripts/run-tests.mjs tests/activityDescriptionPolicy.test.ts tests/labelVoice.test.ts tests/voiceContract.test.ts tests/recapVoice.test.ts
npm run typecheck && npm run lint
```

Exploratory verification for this work order is a static check, recorded in
`review-log.md`: this work order changes no user-visible surface, so there is
nothing to open and look at. The surfaces it feeds are verified in WO-104 through
WO-106.
