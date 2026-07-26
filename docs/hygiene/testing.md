# Testing and verification

Daylens combines capture, time reconciliation, local data, AI, cross-platform behavior, and visible product judgment. No single test command proves all of it.

## Normal development checks

Run these for ordinary changes:

```bash
npm run typecheck
npm run lint
npm test
```

`npm test` discovers the hermetic `tests/**/*.test.ts` suite and runs each file in its own Electron process. It uses stubs, seeded or temporary data, and no real user database or provider key. Live provider suites are deliberately excluded.

Use a filename fragment to run a focused subset:

```bash
npm test -- timelineBlockLayout
```

The shared test database helper in `tests/support/testDatabase.ts` creates an isolated SQLite database with the production schema, every production migration, the AI thread schema repair, and derived-state metadata. Normal tests use that helper. Raw `SCHEMA_SQL` setup is reserved for tests that specifically exercise bootstrap or migration behavior.

## Headless CLI

`./daylens` (source in `cli/run.ts`, also `npm run cli`) drives every product surface from the terminal through the same code paths the renderer uses over IPC. It never touches the live database: `daylens db snapshot` stages a pristine copy of the real database plus a writable work copy; `daylens db reset` restores the work copy from pristine; `daylens db info` reports the snapshot source and age.

```bash
./daylens timeline <date> [--evidence]      # day view (blocks, labels, gaps)
./daylens timeline <date> --week            # week summary ending on date
./daylens timeline <YYYY-MM> --month        # month grid
./daylens apps <date> [appId]               # apps view / app detail (--ids lists app ids)
./daylens wrapped <date> [--regen|--facts]  # wrapped narrative (AI on --regen)
./daylens chat "question" [--thread N]      # real agent turn, streamed
./daylens analyze <date> [--hint "…"]       # the Analyze-day pipeline (AI)
```

Global flags: `--json` (machine output), `--fresh` (reset the work DB first), `--db <path>` (explicit DB file, e.g. a fixture), `--out <file>` (tee JSON). The shim runs Electron as Node with the real TypeScript loader, so what the CLI shows is what the app computes.

## Deterministic product-path verification

These commands inject data only at genuine source, provider, operating-system, or network boundaries. The code between those boundaries is production ingestion, storage, migration, projection, correction, privacy, serialization, and presentation code.

```bash
npm run verify:synthetic-day
npm run verify:ai-turn
npm run verify:remote-web
npm run timeline:eval -- --strict
```

- `verify:synthetic-day` feeds synthetic days through foreground and browser capture, canonical focus evidence, projection, Timeline, Apps, search, memory, AI tools, corrections, connector collection, and the current offline sync boundary. It fails if private or excluded facts reach storage or any downstream fact surface. The reference workday keeps a deep hand-written test; every other capture-events fixture runs through the data-driven representative-day runner, including its mutations and privacy rules.
- `verify:ai-turn` runs the production `sendMessage` path with only the model provider replaced. It verifies context assembly, tool execution, source-backed citation checking, streaming, persistence, and final thread state.
- `verify:remote-web` drives the frozen production remote HTTP and Convex paths against an in-memory network/database adapter, then reads them through production web presentation code. It covers sanitization, deduplication, omission deletion, failure/retry, revocation, range behavior, and Apps presentation. It does not claim to verify the future encrypted desktop sync client, which does not exist yet.
- strict Timeline evaluation makes segmentation, label, intent, and wrap invariants a hard failure rather than a score-only diagnostic.

Synthetic and representative-day inputs use the versioned `DayFixture` contract in `tests/support/dayFixture.ts`. Normalized Timeline evidence, source-boundary capture events, and private database copies are input variants of that contract; expected Timeline episodes, Apps facts, meetings, search, memory, AI answers, and privacy rules share its expected-result model. Fixtures live under `tests/timeline-eval/fixtures`. The loader accepts the original unversioned Timeline JSON shape and normalizes it before evaluation.

The representative day set from the agent-runtime specification is executable: a meeting-heavy day, two clients on the same tools, mixed work/personal/entertainment, missing capture, contradictory calendar-versus-device evidence, corrections that conflict with later automated inference, and excluded-plus-deleted evidence. A fixture's `mutations` replay the person's edits through production paths — block corrections and deletions (`writeTimelineBlockReview`), and app or site history purges (`deleteHistoryForApp`/`deleteHistoryForSite`) — before the day is re-derived, so automated inference runs again after the edits. The Timeline gate scores episodes, labels, intent, wraps, and the expected facts (Apps, meetings, search, totals); prohibited privacy terms and failed mutations fail the run even without `--strict`. The `answers` entries (required facts, acceptable interpretations, prohibited claims, required sources) are the accepted expectations for the model-facing evaluation gates; the offline gates enforce their deterministic counterparts through the search and privacy rules.

## Private real-day replay

The real-day benchmark is the primary local check for whether Daylens reconstructs an ordinary day coherently. It never reads through a writable connection to the live database. Preparation discovers the production user-data directory, opens the database read-only, uses SQLite online backup to create a coherent private snapshot, hashes it, and then runs migrations and production queries only against a writable clone. It refuses CI and refuses a private root inside the Git worktree.

```bash
npm run real-day:prepare
npm run verify:real-day
npm run verify:real-day:desktop -- \
  --date YYYY-MM-DD \
  --user-data "$HOME/.daylens-real-day/YYYY-MM-DD/work/userData" \
  --output "$HOME/.daylens-real-day/YYYY-MM-DD/desktop-observation.json"
```

`verify:real-day` writes a private candidate, review form, and hour-by-hour reconstruction under `~/.daylens-real-day/<date>/`. It compares the actual renderer-owned Timeline projection, direct Timeline/AI facts, Apps, calendar and meeting evidence, search, memory, and an accepted baseline when one exists. A draft is not a pass or an accepted truth.

The desktop command launches the real Electron main/preload/renderer against that isolated clone in a fail-closed replay mode. It navigates Timeline, opens block detail, navigates Apps, and exercises command-palette search. Pass `--mutations` only for a disposable clone; it edits and permanently deletes test-copy data through the visible renderer and production IPC, then checks the result. Pass `--with-ai` only when one approved real provider call is intended. That flag enables model-provider network access while analytics, updates, billing, sync, connectors, Intercom, MCP, browser collection, and capture stay disabled. The command does not capture screenshots; screenshots require a separately approved run.

After reviewing `wrapped.md`, record corrections in the private `review.json`. Put stable phrases the agent must state or must not claim under `expectations.ai.requiredFacts` and `expectations.ai.prohibitedClaims`; the desktop AI replay checks those semantic requirements without freezing exact model prose. Change the decision to `confirmed` only when the day is correct. Only a confirmed review can be accepted:

```bash
npm run real-day:accept -- --date YYYY-MM-DD --confirmed
```

Acceptance stores the expected reconstruction beside the private snapshot. Future `verify:real-day` runs fail when missing or invented activity, boundaries, duration, grouping, labels, meetings, Apps facts, or other accepted observations change. The snapshot, titles, pages, memory, and answers remain outside Git and CI.

For wrap-specific debugging, `tests/wrapped-bench/debug.ts <date>` reproduces the exact production wrap prompt for any real day, and `tests/wrapped-bench/probe-facts.ts <date>` prints the day's computed facts.

## Journal-anchored day eval

```bash
npm run eval:days                    # fast: deterministic dimensions only
npm run eval:days -- --judge         # + LLM shape judge (one call per day)
npm run eval:days -- --strict        # non-zero exit under thresholds
npm run eval:days -- 2026-07-22 …    # only these days
npm run eval:days -- --fresh         # restage the work DB from pristine first
```

Ground truth lives in `tests/journal-eval/days/*.yaml`: what the owner said the day was (the Obsidian journal), or machine-verifiable sources (git, calendar, meeting notes) for days without a journal entry. The runner scores what the user actually sees — timeline block labels and narratives plus the wrapped narrative (stored if present, deterministic fallback otherwise; it never spends a wrap-generation call).

Deterministic dimensions: every declared primary work is named somewhere visible; no block label is a tool surface or a day-specific banned-as-work string; no block spans a declared off-computer gap. `--judge` adds one Anthropic call per day scoring 0–10 how well the output captures the shape of the real day, with hard caps for tool surfaces treated as the work, invented continuity, and background media promoted to the activity. `--strict` thresholds start deliberately below 100% and ratchet up as fixes land, never down.

Local-only: it reads the real-DB snapshot staged by `./daylens db snapshot` and journal-derived expectations, so it never runs in CI. Results land in `.journal-eval/results-<stamp>.json` plus a table on stdout.

## Contract and workspace checks

Run the checks that match the changed boundary:

```bash
npm run contract:check
npm run web:contract:check
npm --prefix apps/web run manifest:check
npm run web:typecheck
npm run web:build
npm run billing:check
npm run billing:sandbox
```

- `contract:check` verifies the desktop and web remote contract.
- `web:typecheck` and `web:build` validate the Next.js workspace.
- `billing:check` validates the managed billing server syntax.
- `billing:sandbox` exercises billing and entitlement behavior with ephemeral dependencies and fake providers.

`npm run format:check` excludes generated output and nested agent worktrees. It reports the repository's current formatting debt without traversing another agent's checkout.

## Running-app verification

Automated tests are the floor. Product-facing changes also need verification in the running application using a real or representative day.

Check the behavior that changed, its empty and failure states, and any other surface that consumes the same fact. Timeline, Apps, the AI agent, search, MCP, sync, and web should not disagree.

Platform capture changes require real-machine checks on every affected platform. A macOS result does not prove Windows or Linux behavior.

The packaged-runtime workflows create real foreground and fullscreen test windows and verify the capture file produced by the packaged application. They prove startup, packaging, native loading, and basic capture on their hosted operating system. They do not replace permission prompts, private-window detection in installed browsers, sleep/lock/restart behavior, multi-display behavior, update installation, or visual product acceptance on representative machines.

## Database and migration changes

- Add forward-only migrations.
- Test a fresh database and an upgraded representative database. `tests/upgradedDatabaseMigration.test.ts` runs in the hermetic suite: it boots the frozen schema in `tests/fixtures/upgraded-database/schema-v25.sql`, seeds a representative two-client day plus legacy AI-thread data, runs the production startup sequence and full migration ladder, and verifies the day, Apps, search, legacy threads, and post-upgrade corrections survive.
- Preserve corrections, settings, and existing activity.
- Verify failed or interrupted migration behavior where relevant.
- Never run tests against the person’s live database unless a harness explicitly makes a read-only copy.

## Privacy changes

Test the boundary, not only the presentation. Excluded, private, paused, or deleted activity should be prevented from reaching downstream storage or consumers according to the accepted specification.

Screen-context tests must prove that exclusions apply before capture, derived evidence is committed before a frame is marked safe to delete, failed extraction remains visible and retryable, and analytics contain measurements rather than captured content.

## Interpretation and voice

Product-facing fixtures should start with representative evidence and assert the answer a person should receive. A useful answer names the activity and, when supported, its subject, people, project, client, or outcome. It should not merely rename an application session.

Cover at least these cases when interpretation behavior changes:

- strong evidence produces a direct, specific account of what happened
- conflicting evidence produces one natural explanation of the uncertainty
- a short observation is relevant and supported rather than generic encouragement
- the underlying evidence remains inspectable
- the same interpretation is reflected consistently in Timeline, Apps, search, and the AI agent
- incomplete observation does not become a productivity judgment

## Release confidence

The complete safe terminal gate is:

```bash
npm run verify:shipping
```

It runs type checking, lint, the complete offline suite, the synthetic-day, deterministic AI-turn, remote/web, and strict Timeline harnesses, contract and web checks, the fake-provider billing sandbox, and every local build. Packaged operating-system workflows and approved real-service evaluations remain separate because this command does not pretend to simulate those environments.

Before describing a change as ready:

1. Run focused tests during implementation.
2. Run type checking and the normal offline suite.
3. Run workspace or contract checks for changed boundaries.
4. Run approved evaluations when model behavior changed.
5. Verify visible behavior in the running app.
6. Record what was verified and what remains unverified.

Green checks do not make an active ticket shipped. Shipping requires explicit acceptance.

## Gate for every implementation ticket

Every ticket records and runs:

1. A focused regression that fails before the fix and reaches the production owner of the behavior.
2. `npm run typecheck`, `npm run lint`, and `npm test`.
3. `npm run verify:synthetic-day` for capture, evidence, projection, privacy, correction, deletion, Timeline, Apps, search, memory, connector, AI-tool, MCP, or sync changes.
4. `npm run verify:ai-turn` for retrieval, prompt/context, tool, citation, streaming, provider-routing, persistence, or thread changes.
5. `npm run verify:remote-web` plus contract and web checks for remote or web changes.
6. `npm run timeline:eval -- --strict` for segmentation, label, category, intent, meeting, total, or wrap changes.
7. The affected packaged-runtime workflow for capture, packaging, native dependency, updater, or platform changes.
8. Approved staging or paid-provider verification only when the ticket crosses that external boundary.
9. A small running-product acceptance check for visible or experiential behavior.
