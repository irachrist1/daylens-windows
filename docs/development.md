# Developing Daylens

Changes begin with understanding and end with explicit acceptance.

## Sources of truth

Read the smallest relevant set:

0. [What actually blocks V2](V2-SHIP-PRIORITIES.md) — the user-facing failures that must ship first, and the rule that every change is graded against the acceptance dossier, not a convenient ticket.
1. [Product direction](product/product.md) for the product promise and boundaries.
2. [V2 direction](product/v2.md) for accepted scope, sequencing, and technical boundaries.
3. The relevant file under `docs/specs` for expected behavior.
4. The active file under `docs/tickets` for the implementation outcome and acceptance checks.
5. [Architecture](codebase/architecture.md) and the code for current behavior.

A specification marked `Ready for review` is complete enough to evaluate but does not authorize implementation. Implementation begins only after its status is explicitly accepted and an active ticket is created.

`AGENTS.md` contains the small set of repository instructions that agents discover automatically. Product decisions and detailed workflows do not belong in agent entry files.

## Documentation model

- **Product documents** explain why Daylens exists and which product decisions are accepted.
- **Specifications** describe expected behavior in enough detail to implement without inventing product decisions.
- **Tickets** describe active work that moves the codebase from current behavior to an accepted specification.
- **Codebase documents** explain the current implementation and must be checked against code.
- **Hygiene documents** explain testing and evaluation.
- **Operations documents** contain deployment and release runbooks.

Documentation is written for people encountering the open-source project without private context. Personal intentions use first person; technical behavior uses direct, neutral language.

Durable documents describe what is true or what has been explicitly accepted. Do not leave placeholders such as “this will be documented,” “this needs updating,” or “a specification will be added.” Put unfinished documentation work in [TO-DO.md](TO-DO.md) instead.

## From idea to shipped change

1. Confirm the product direction.
2. Create or update the relevant specification.
3. Create an active ticket with the desired outcome, dependencies, acceptance checks, and verification.
4. Inspect the current path, callers, tests, and data implications.
5. Implement the smallest complete behavior slice.
6. Run focused checks, type checking, and the normal offline suite.
7. Present the running behavior and evidence against the acceptance checks.
8. Wait for explicit acceptance.
9. Promote durable facts into the specification, codebase documentation, and user-facing changelog.
10. Delete the completed ticket. Git history is the archive.

A passing test suite does not mean a ticket is accepted. A ticket is shipped only after I explicitly agree that it is shipped.

## Ticket shape

```markdown
# <Outcome>

## Why

<The user or product problem this resolves.>

## Current behavior

<What the code does now, verified against the repository.>

## Desired behavior

<The outcome required by the accepted specification.>

## Dependencies

<Decisions or tickets that must be resolved first.>

## Acceptance checks

- <A visible or measurable result.>

## Verification

- <Focused automated and running-app checks.>
```

## Implementation standards

- Preserve unrelated worktree changes and existing user data.
- Ask before making a product or architecture decision that is not recorded.
- Add focused regression coverage for changed behavior.
- Keep policy in one owner and adapt it for each surface.
- Preserve provenance for evidence-backed facts.
- Keep projections deterministic.
- Keep the renderer behind typed IPC.
- Validate external and IPC inputs at boundaries.
- Make destructive or externally visible actions explicit and confirmable.
- Use comments only for non-obvious constraints or invariants.
- Remove superseded paths after their consumers move.

## Normal verification

```bash
npm run typecheck
npm run lint
npm test
npm run verify:synthetic-day
npm run verify:ai-turn
npm run verify:remote-web
npm run timeline:eval -- --strict
npm run contract:check
```

The verification commands are offline and deterministic. Run the boundary-specific web, billing, and packaged-runtime checks described in [Testing and verification](hygiene/testing.md) when those surfaces change. Some quality evaluations call paid providers and require explicit approval. See [Benchmarks](hygiene/benchmarks.md).

For hands-on inspection, the headless CLI (`./daylens`) drives timeline, apps, wrapped, chat, and analyze from the terminal through the same code paths as the renderer, against an isolated snapshot of the real database. For day-quality work, `npm run eval:days` scores real days against journal ground truth (local-only; `--judge` adds an LLM shape judge, `--strict` gates on thresholds). Both are described in [Testing and verification](hygiene/testing.md).

For changes that can alter an ordinary reconstructed day, also run the private local `npm run verify:real-day` benchmark against an accepted snapshot. Use `npm run verify:real-day:desktop -- --date YYYY-MM-DD --user-data ABSOLUTE_ISOLATED_USER_DATA --output ABSOLUTE_PRIVATE_OUTPUT` when renderer, IPC, correction, deletion, search, Apps, or AI presentation changes. These commands refuse CI and never belong in a shared fixture or pull request artifact.

## Large planning efforts

When I explicitly request Wayfinder, use the global opt-in skill and treat `docs/tickets` as the local Markdown tracker unless another issue tracker is named. Wayfinder is for resolving decisions, not permission to begin implementation. Do not load or invoke it automatically.
