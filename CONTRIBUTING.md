# Contributing to Daylens

Daylens is an open-source desktop application that turns computer activity into a private, organized memory of work and gives that memory to an agent.

Contributions are welcome. Product behavior remains intentional: understand the accepted behavior before changing it, and discuss new product decisions before implementing them.

## Before making a change

Read the documents relevant to the work:

- [Product direction](docs/product/product.md)
- [V2 direction](docs/product/v2.md)
- [Development workflow](docs/development.md)
- [Current architecture](docs/codebase/architecture.md)
- [Repository structure](docs/codebase/structure.md)
- [Agent instructions](AGENTS.md)

If an accepted specification exists under `docs/specs`, follow it. If the change requires a new product decision, open a discussion or issue before writing the implementation.

## Changes that can begin directly

A focused pull request is appropriate for:

- a reproducible bug with clear expected behavior
- documentation or installation corrections
- narrow correctness, accessibility, or reliability fixes
- tests that preserve existing accepted behavior

New features or meaningful behavior changes should begin with an agreed specification and an active ticket.

## Set up the project

Daylens requires Node.js 20 or newer and native build tools for your platform. See [Installation and releases](docs/operations/install.md) for platform prerequisites.

```bash
npm install
npm start
```

## Isolate each change

Never work directly on `main`. Use a dedicated branch or worktree for each change, and keep unrelated local work out of the pull request. When work comes from Linear, include its identifier in the branch name (for example, `dev-161-delivery-pipeline`) so the pull request and issue statuses link automatically.

## Make a focused change

1. Reproduce or inspect the current behavior.
2. Confirm the relevant specification or expected behavior.
3. Keep the change limited to one logical outcome.
4. Add focused regression coverage.
5. Preserve existing data, corrections, and unrelated worktree changes.
6. Run the checks relevant to the changed boundary.
7. Explain what changed, why, and how it was verified.

Do not introduce a second definition of activity, time, attribution, privacy, or correction behavior for one surface. Timeline, Apps, AI, search, MCP, sync, and web should consume shared product facts.

## Verification

Normal checks:

```bash
npm run typecheck
npm run lint
npm test
npm run verify:synthetic-day
npm run verify:ai-turn
npm run verify:remote-web
npm run timeline:eval -- --strict
```

Run contract, web, billing, or packaged-runtime checks when those boundaries change. Some AI evaluations use real data, credentials, and paid provider calls; do not run them casually. See [Testing and verification](docs/hygiene/testing.md) and [Benchmarks and evaluations](docs/hygiene/benchmarks.md).

Visible behavior should also be verified in the running application. Green tests are necessary, not sufficient.

## Pull requests

Include:

- the problem and expected behavior
- the related issue, specification, or ticket
- a concise description of the implementation
- automated checks that ran
- running-app or platform verification that ran
- anything important that could not be verified

Keep commits and pull requests free of private activity, credentials, generated evaluation output, and sensitive website or file data.

## Product and engineering boundaries

- Evidence-backed claims retain a path to their source.
- Models do not become the source of recorded facts.
- Corrections remain authoritative and survive rebuilds.
- Privacy controls are enforced at the relevant data boundary.
- Existing user databases are preserved through tested, forward-only migrations.
- The renderer accesses desktop behavior through typed preload and IPC interfaces.
- Comments explain only non-obvious constraints or invariants.

## Bugs and security

For bugs, include reproduction steps, expected and actual behavior, operating system, and app version.

Do not report vulnerabilities in a public issue. Follow [SECURITY.md](SECURITY.md).
