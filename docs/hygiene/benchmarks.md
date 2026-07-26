# Benchmarks and evaluations

Daylens has several harnesses because deterministic product logic and model behavior require different evidence. Run only the smallest harness that answers the question.

| Harness                             | Data                                | Provider calls            | Purpose                                                                  |
| ----------------------------------- | ----------------------------------- | ------------------------- | ------------------------------------------------------------------------ |
| `npm test`                          | Seeded or temporary data            | No                        | Deterministic regression suite                                           |
| `npm run verify:synthetic-day`      | Source-boundary day fixture         | No                        | Cross-surface ingestion, privacy, correction, and fact agreement         |
| `npm run verify:ai-turn`            | Production test database            | Mock model boundary       | Complete deterministic agent turn and persisted thread                   |
| `npm run verify:remote-web`         | Remote contract fixtures            | Local network adapter     | Current remote mutation, projection, retry, revocation, and web behavior |
| `npm run timeline:eval -- --strict` | Editable in-memory fixtures         | No                        | Hard gate for Timeline segmentation, labels, intent, and wrap facts      |
| `npm run moment:bench`              | Read-only copy of the live database | Yes                       | End-to-end AI answers for exact moments, recall, follow-ups, and exports |
| `npm run test:behaviour`            | Read-only copy of the live database | Yes, including a judge    | Black-box answer-quality evaluation across providers                     |
| `npm run wrapped:bench`             | Live or representative Daylens data | Yes                       | Generated wrap quality and grounding                                     |
| `npm run eval:days`                 | Read-only copy of the live database | Only with `--judge`       | Journal-anchored grading of regenerated days on every user-visible surface |
| `npm run billing:sandbox`           | Ephemeral billing dependencies      | Fake providers by default | Billing, webhook, reservation, and concurrency behavior                  |
| `npm run bench:queries`             | Seeded temporary database           | No                        | Local query latency for a representative heavy year                      |

## Timeline evaluation

`npm run timeline:eval` is offline and hermetic. Fixtures under `tests/timeline-eval/fixtures` seed sessions, browser evidence, and activity-boundary events, then compare the result with expected blocks and wrap facts. Shipping checks use `--strict`; the non-strict score is useful only while authoring a fixture. The strict result covers segmentation, labels, intent, wrap grounding, boundary reasons, and design invariants. Category and work-kind differences remain visible as diagnostic notes but are not mislabeled as strict failures.

The score is diagnostic. Structural invariants still fail the command. Update the generated reference only when the behavior change is intentional:

```bash
npm run timeline:eval -- --write-baseline
```

The generated report is written under `.timeline-eval` and is not active documentation.

## Query-budget benchmark

`npm run bench:queries` is offline and hermetic. It seeds a temporary on-disk database with a representative heavy year against the real schema — roughly 1.4 million rows across sessions, focus events, and page visits, about 230 MB — and reports median and 95th-percentile latency for the canonical query shapes: day reads, month and year aggregates, exact search, and the worst-case unindexed scan.

Its numbers are the evidence behind the performance budgets in the memory and Apps specifications. Rerun it when the schema, indexes, or canonical queries change, and update those budget lines only when the behavior change is intentional.

## Moment bench

`npm run moment:bench` calls the same `sendMessage` entry point used by the AI tab, using a temporary read-only copy of the live database and the configured provider. It covers exact-time questions, multi-turn follow-ups, recall, exports, and answer guards.

Run all cases or filter deliberately:

```bash
npm run moment:bench
npm run moment:bench -- <case-id>
npm run moment:bench -- --ask "What did I work on Tuesday afternoon?"
```

This costs money and requires explicit approval.

## AI behaviour evaluation

`npm run test:behaviour` exercises the real message pipeline, configured provider, read-only database copy, and an LLM judge. Results are written under `.ai-behaviour` for local comparison.

Use it before shipping meaningful AI routing, retrieval, tool, voice, or answer changes. It is not a CI gate because it requires real credentials, real data, and paid calls.

```bash
npm run test:behaviour
DAYLENS_EVAL_PROVIDER=openai npm run test:behaviour
npm run test:behaviour -- <scenario-id>
```

## Adding coverage

- Add a unit or integration regression when deterministic code was wrong.
- Add a Timeline fixture when the expected grouping, label, intent, or wrap fact was wrong.
- Add a moment case when an exact real-data question failed.
- Add a behaviour scenario when answer quality, grounding, voice, or provider behavior failed.
- Keep credentials, private activity, generated reports, and raw live-database content out of the repository.

Evaluation results support judgment; they do not replace review of the actual answer or running product.
