# To-do list

This is the one place for documentation, decision, and research work that has not been completed or accepted. Durable documents describe what is true now, not promise that someone will update them later.

## Decisions waiting on me

- [ ] Choose the first-customer wedge for positioning and connector priority. Recorded recommendation: professionals who account for their time to clients (consultants, freelancers, agency ICs) — it matches the paid job in the organizational-sharing draft and the strongest competitors' audiences. Alternatives considered: AI-forward knowledge workers wanting personal memory; keeping the broad "any individual" framing. The V2 foundations are identical under all three, so no implementation waits on this.

## Product validation

- [ ] Build the competitor matrix described in V2, angled at the chosen first-customer wedge.
- [ ] Design and build the comparison hub and individual comparison pages for the website.
- [ ] Rewrite the landing page around the accepted positioning, questions, and product surfaces.
- [ ] Define activation and retention measurements for the first recognizable day, useful retrieval, and useful agent answer.

## Documentation and developer experience

- [ ] Capture a connected set of real product screenshots from the running desktop application and add them near the top of the README. The set must show Timeline, Apps, an AI-agent answer, and the evidence or correction path supporting that answer. Complete when every image is current, captioned by the user outcome it demonstrates, and checked against the packaged application.
- [ ] Productize the source setup path around one diagnostic/setup command and one development command. Complete when a fresh clone can verify prerequisites, start every required local component, report authoritative readiness per component, stop children cleanly, and give an exact recovery command for each failed preflight.
- [ ] Verify the documented fresh-clone, development, test, packaging, and release paths in clean environments. Complete when CI or a repeatable release check exercises the same commands the README and operations documents give contributors.
- [ ] Add repository checks that prevent captured personal data, real activity titles, message or document content, access tokens, provider credentials, and production identifiers from entering fixtures, logs, documentation, or Git history. Complete when the contribution guidance and automated checks use synthetic examples and fail on seeded sensitive values.
- [ ] Normalize the existing Prettier baseline in a dedicated clean-tree mechanical change. `npm run format:check` now excludes generated output and nested agent worktrees but reports 605 existing files. Complete when those files are formatted without mixing the rewrite into product work and the command is added to CI.
- [ ] Make `knip` and `depcheck` workspace- and alias-aware, then remove confirmed dead code and dependencies. Complete when both commands distinguish Vite aliases, workspace dependencies, generated Convex exports, and intentional public APIs from real findings and exit successfully.
- [ ] Fix the unhandled "Database not initialised" rejection a background job raises during desktop-replay startup. Complete when `verify:real-day:desktop` starts without an unhandled rejection and the racing job is gated on database initialization.

## Specifications to review

Review in wave order — the [implementation waves](product/v2.md#implementation-waves) define the dependency reasoning. Acceptance of a later wave never unblocks work in an earlier one. The four Wave 1 specifications are accepted; implementation issues derive from them next.

Wave 2:

- [ ] Review and accept the [Memory, search, and entities specification](specs/memory-and-entities.md).
- [ ] Review and accept the [AI agent specification](specs/ai-agent.md).
- [ ] Review and accept the [Agent runtime and context specification](specs/agent-runtime-and-context.md).

Wave 3:

- [ ] Review and accept the [Connectors specification](specs/connectors.md).
- [ ] Review and accept the [Billing and entitlements specification](specs/billing-and-entitlements.md).
- [ ] Review and accept the [Privacy, retention, and sync specification](specs/privacy-retention-and-sync.md).
- [ ] Review and accept the [Screen-context experiment specification](specs/screen-context.md).

Wave 4:

- [ ] Review and accept the [Wrapped specification](specs/wrapped.md).
- [ ] Review and accept the [Briefs specification](specs/briefs.md).

After Version 2:

- [ ] Review the [Web companion specification](specs/web-companion.md) once the browser-encryption research below concludes.

## Research and prototypes

Each item states the evidence required and what completes it. Items marked **(desktop milestone)** must finish before V2 desktop acceptance; the rest gate later work only.

- [ ] **(desktop milestone)** Interpretation-quality prototype. After the representative-day fixtures exist (wave 1), run paired evaluations: the same questions answered from metadata alone and with connector evidence, judged against the accepted answers. Complete when the pass rate is recorded and the wave-2 priorities are confirmed or adjusted from the result.
- [ ] **(desktop milestone)** Local embedding feasibility for semantic search. Candidates: a small sentence-embedding model (MiniLM/bge-small class) under a Node-compatible local runtime, with a local vector index (for example sqlite-vec). Evidence: index build time for a representative year of memory records, query latency against the 1-second budget in the memory specification, resident memory, and CPU cost on battery. Complete when the default model and runtime are recorded in the memory specification, or when the recorded decision is that V2 ships exact-plus-structured search first and semantic indexing follows.
- [ ] **(desktop milestone)** Benchmark representative Daylens questions across the supported managed models before setting the included allowance. Complete when per-question provider-cost figures exist for the model picker and the billing allowance.
- [ ] **(desktop milestone)** Validate query budgets against a real long-lived database. `npm run bench:queries` measures a synthetic heavy year (2026-07: ~1.4M rows, 230 MB, every canonical query shape well inside budget on an M2 Pro). Remaining evidence: the same measurements on a real upgraded database and on a slower reference machine, plus renderer interaction timing. Complete when the specs' budget lines are confirmed against both.
- [ ] Linux capture support matrix. Evidence: which desktop sessions (X11, common Wayland compositors) provide the foreground, title, idle, and lock signals the capture specification requires. Complete when the capture specification's Linux migration step is confirmed or explicitly narrowed to named sessions.
- [ ] Prototype event-driven or periodic screen capture on macOS and Windows only after the screen-context specification is accepted.
- [ ] Measure screen-context evidence quality, extraction failures, corrections, downstream answer improvement, storage, battery, and privacy impact without sending captured content to PostHog.
- [ ] Prototype the canonical connector interface and compare direct adapters with Composio for long-tail tools.
- [ ] **(desktop milestone)** Agent-runtime comparison. Run the same accepted context packets and fixtures through the incumbent AI SDK loop, Claude Agent SDK, and any other serious candidate. Compare factual correctness, disclosure fidelity, dynamic tool scoping, human interruption, continuation, cancellation, crash recovery, latency, tokens, and cost. Complete when one V2 runtime is selected in the agent-runtime specification from recorded results.
- [ ] Reconcile the Boop runtime review with the agent specifications before the runtime comparison. Complete when file access uses explicit grants instead of whole-home access, conversation history enters the governed context packet, every retrieved source is treated as untrusted data, local runtimes have an isolated process and credential boundary, pending human interactions have durable continuation semantics, and tool eligibility is deterministic and testable.
- [ ] Browser-encryption feasibility for the web companion (blocks the web milestone, not desktop). Evidence: WebCrypto key handling bound to a session, an encrypted-at-rest IndexedDB index over a representative organized-fact volume, and whether browser-local semantic search is feasible in the first release. Complete when the web-companion specification names the chosen mechanisms.
- [ ] Confirm whether OpenAI permits Codex App Server and ChatGPT subscription authentication for the intended general-purpose Daylens agent before offering or marketing that runtime. Complete with a written provider answer; until then the CLI provider modes stay personal and unmarketed per the V2 disposition list.
- [ ] Ask Anthropic whether Daylens can receive approval for customer Claude subscription authentication; use supported API authentication unless approval is explicit.
- [ ] Choose the permanent monthly price after desktop beta and real provider-cost data; use $14.99 only for internal planning until then.
- [ ] Re-verify Polar and Flutterwave availability, payout requirements, fees, settlement, and refunds before deployment.

## Operations

- [ ] Provision a billing staging environment with real Postgres and provider test accounts.
- [ ] Verify desktop-to-billing behavior in a packaged build.
- [ ] Run the macOS, Windows, and Linux packaged capture workflows on their hosted operating systems and retain their capture artifacts. Follow with representative-machine checks for permission prompts, supported display servers, private browser windows, fullscreen, multiple displays, sleep, lock, restart, updater installation, and revocation. These signals cannot be simulated faithfully by the offline Electron-as-Node suite.
- [ ] Run approved staging verification for managed AI providers, connector APIs, Convex, payment providers, and billing Postgres. The deterministic suite injects those boundaries and cannot prove credentials, quotas, provider response semantics, webhook delivery, or service availability.
- [ ] Document billing support, cancellation, usage visibility, refunds, and incident response.

## Implementation blocked by later V2 production code

- [ ] Complete [real-day Timeline, Apps, and AI reconciliation](tickets/real-day-timeline-apps-reconciliation.md) after the capture/evidence, Timeline, and Apps specifications are accepted. The private 2026-07-13, 2026-07-16, and 2026-07-17 days stay failing benchmarks until then; they are reviewed and accepted only at that ticket's exit, when meetings are recognized, labels carry my voice, and Timeline, Apps, meetings, and the agent agree.
- [ ] Complete [canonical deletion ownership](tickets/canonical-deletion-ownership.md) after the organized-fact model is accepted.
- [ ] Complete the [encrypted sync terminal foundation](tickets/encrypted-sync-terminal-foundation.md) after the desktop fact model and browser-encryption decision.
- [ ] Complete the [screen-context terminal foundation](tickets/screen-context-terminal-foundation.md) after the experiment specification and extraction runtime are accepted.

## Deferred — does not block the desktop milestone

- Organizational sharing: the [specification](specs/organization-sharing.md) is drafted and explicitly deferred until the individual products succeed.
- Web companion implementation: waits for desktop acceptance and the browser-encryption research above.
- Subscription-backed runtime adapters: excluded until the provider-permission questions above are answered in writing.
- The frozen current web surfaces: disposition recorded in [V2 direction](product/v2.md#existing-features-during-the-transition). Wrapped and the briefs are not deferred — their rebuilds are inside the Version 2 release gate per their specifications.
