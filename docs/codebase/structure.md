# Repository structure

> This document is a navigation aid, not the source of truth. Verify every claim against the current code before making a change, and update this map when the repository moves.

Daylens is an npm-workspaces monorepo with one root lockfile. Run `npm install` from the repository root.

## Runtime systems

| Path                       | Responsibility                                                                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main`                 | Electron main process: lifecycle, capture, SQLite, activity services, AI orchestration, sync, billing integration, updates, and IPC handlers |
| `src/preload`              | Typed bridge between the renderer and Electron main process                                                                                  |
| `src/renderer`             | React desktop interface for Timeline, Apps, AI, Settings, onboarding, and review surfaces                                                    |
| `src/shared`               | Types and pure helpers shared by desktop processes                                                                                           |
| `src/native`               | macOS and Windows native helpers: capture plus the EventKit calendar helper                                                                  |
| `apps/web`                 | Next.js and Convex marketing site and linked web companion                                                                                   |
| `packages/remote-contract` | Shared desktop and web wire contract                                                                                                         |
| `packages/mcp-server`      | Local stdio MCP server over Daylens data; read-only, same tool executors as the in-app agent                                                 |
| `packages/range-worker`    | Apps-view range reads off the main thread                                                                                                    |
| `packages/embed-worker`    | MiniLM ONNX embedding inference                                                                                                              |
| `packages/capture-relay`   | Drains the on-disk focus-event spool                                                                                                         |
| `services/billing`         | Managed AI access, metering, and payment service                                                                                             |

The four `packages/*/src/index.ts` entries are referenced by vite configs and fork sites; knip flags them as unused, but they are not.

## Supporting paths

| Path              | Responsibility                                                                     |
| ----------------- | ---------------------------------------------------------------------------------- |
| `tests`           | Offline regression suites, evaluation harnesses, fixtures, and test loaders        |
| `cli`             | Headless CLI (`./daylens`) driving product surfaces through the renderer's code paths |
| `scripts`         | Build, release, contract, test, and verification tooling                           |
| `shared`          | Runtime data shared outside TypeScript source, including application normalization |
| `build`           | Packaging resources and generated native-helper output                             |
| `docs/product`    | Product direction, accepted V2 scope, and vocabulary                               |
| `docs/specs`      | Reviewable expected behavior; implementation begins after explicit acceptance      |
| `docs/tickets`    | Active implementation work; a ticket is deleted after explicit acceptance          |
| `docs/codebase`   | Current architecture and repository navigation                                     |
| `docs/hygiene`    | Testing, evaluation, and benchmark guidance                                        |
| `docs/operations` | Installation, releases, billing, signing, and other runbooks                       |
| `docs/research`   | Bounded reference work that informs but does not override accepted specifications  |
| `docs/reviews`    | Dated analyses and reviews, kept as records rather than living documents           |
| `docs/TO-DO.md`   | Specification reviews, product validation, and operational follow-up               |
| `.github`         | Continuous integration and release workflows                                       |
| `Casks`           | Homebrew cask definition                                                           |
| `probes`          | Manual platform experiments that are not part of the runtime                       |

## Generated paths

Do not import source from generated output:

- `node_modules`
- `dist`
- `dist-release`
- `apps/web/.next`
- `apps/web/.generated`
- `logs`
- `artifacts`

## Important boundaries

- The renderer reaches local data and services only through preload and IPC.
- `packages/remote-contract` owns shared desktop and web payloads.
- Platform-specific capture behavior should end behind adapters in the Electron main process.
- The MCP server is bundled by the root build and launched by the desktop application.
- Root scripts are the supported entry points for cross-workspace verification and builds.

See [Architecture](architecture.md) for the current runtime flow.
