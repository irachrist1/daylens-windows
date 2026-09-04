# Agent benchmark

**Status:** Canonical. This document is the one place that says how every AI
surface in Daylens behaves, sounds, and is graded. The behavior contract lives
in [ai-agent.md](ai-agent.md), the label voice in [label-voice.md](label-voice.md),
and the harness inventory in ../hygiene/benchmarks.md;
this document binds them to the graded queries, the judge rubric, and the hard
caps a build must clear before it ships.

## The surfaces under grade

Every sentence a person reads that a model or the deterministic narrative
pipeline produced is a graded surface:

1. **Chat answers** — the AI tab, judged by `npm run test:behaviour`.
2. **Timeline block labels and narratives** — judged by `npm run timeline:eval -- --strict`
   (hermetic fixtures) and `npm run eval:days` (real regenerated days).
3. **Wrapped narratives** (day and week) — judged by `npm run eval:days` and
   `npm run wrapped:bench`.
4. **Recaps and briefs** — the same facts and voice rules as wrapped; failures
   are recorded as journal-eval days or wrapped-bench anchors.

One voice contract covers all of them. Its enforcement points:

- `src/main/ai/voiceContract.ts` — chat system prompt, banned vocabulary,
  citation contract, em-dash ban.
- `src/shared/labelVoice.ts` — deterministic label rules (invariant + target).
- `src/shared/summaryVoice.ts` — narrative and summary prose rules.

## How answers must sound

The full statement is in [ai-agent.md](ai-agent.md) ("Voice") and
[label-voice.md](label-voice.md). The graded distillation:

- Name the **activity**, never the app or the telemetry. "3h finishing the
  chat refactor", not "3h in Cursor". App totals are evidence, never the
  headline.
- **Exact numbers.** Times and durations match tool output to the minute.
  Inventing a span or duration the tools never returned is a hard fail,
  however plausible it sounds.
- **Gaps are signal.** Off-screen time is named and bounded ("away 5:21pm to
  10:07pm"), never papered over with claimed continuity.
- **No em dash** anywhere in produced prose, labels, or tables. En dashes in
  time ranges are fine.
- **No banned vocabulary** (`BANNED_VOCAB`), no plumbing words in prose
  ("foreground", "window titles", "coverage", "captured signal"), no
  motivational filler, no exclamation marks, no bare refusals — surface the
  closest captured signal instead.
- **Prose by default.** Tables only for breakdowns and per-interval splits the
  person asked for.

## The graded queries

- **Chat scenarios:** `tests/ai-behaviour/scenarios.yaml`. Each scenario
  carries a question, a `gold_answer_shape` (what a colleague who watched the
  user work would say — the primary bar), and rubric flags. The LLM judge
  (`tests/ai-behaviour/judge.ts`) grades good / bad / worse with the full tool
  trace as authoritative evidence.
- **Journal-anchored days:** `tests/journal-eval/days/*.yaml`. Each day file
  is written from the owner's Obsidian journal (ground truth) and grades what
  the user actually sees: block labels, block narratives, and the wrapped
  narrative. Deterministic dimensions plus an LLM shape judge
  (`tests/journal-eval/judge.ts`).
- **Timeline fixtures:** `tests/timeline-eval/fixtures/` — hermetic
  segmentation, label, intent, and wrap-fact checks.
- **Moment cases:** `tests/moment-bench/` — exact-time questions, follow-ups,
  recall, exports.

## Hard caps

A build ships only when all of these hold:

| Gate | Command | Cap |
| --- | --- | --- |
| Deterministic suite | `npm test` | 0 failures |
| Timeline eval | `npm run timeline:eval -- --strict` | strict pass (structural invariants + wrap grounding) |
| Chat behaviour | `npm run test:behaviour` | every scenario `good`; 0 `bad`, 0 `worse` |
| Journal days | `npm run eval:days -- --judge --strict` | primary-work ≥ 0.85 · tool-surface clean ≥ 0.95 · gap honesty ≥ 0.95 · shape-judge mean ≥ 6.0 |
| Wrapped bench | `npm run wrapped:bench` | 0 failures |

The journal-eval thresholds are floors that only ratchet **up** as fixes land
(`tests/journal-eval/run.ts`), never down. Seven consecutive regenerated days
must clear the journal-eval dimensions before V2 is accepted.

## The loop

Every AI-quality fix follows the same loop, and the loop itself is part of the
spec:

1. **Reproduce through a harness**, never by hand-poking the app: the failing
   answer becomes a scenario, day file, fixture, or moment case first.
2. **Fix the cause**, not the instance — in the tool, the prompt, the
   segmentation, or the fact pipeline. A prompt tweak that hides a data lie is
   a regression, not a fix.
3. **Re-run the harness** until the new case passes without breaking the rest.
4. The case stays in the corpus forever; a behavior can only regress by
   visibly failing a named check.

Judge failures grade the harness, not the product: a judge transport error or
a judge misreading (for example, applying one day's ground truth to another
day's question) is fixed in the harness and never absorbed by weakening a gold
shape.
