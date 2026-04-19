# Daylens Claude Guide

Use these files as the current source of truth, in this order:

1. `../README.md` for the canonical product description
2. `ABOUT.md` for concise reusable product copy
3. `AGENTS.md` for the product and build contract
4. `ISSUES.md` for current constraints and known gaps
5. `IDEAS.md` for future directions

Notes:

- Keep `CLAUDE.md` small. It is a guide for sessions and contributors, not a second product spec.
- Do not duplicate long architecture docs here.
- `ISSUES.md` owns current implementation status, near-term backlog, platform validation snapshots, and what's open vs. fixed. Update that file instead of scattering status notes across the other docs.
- Keep the docs honest about attribution scope: clients and projects now have first-class routed coverage, while broader workstream attribution still belongs in `ISSUES.md` until users validate it.
- Keep launch-on-login, tray or menu-bar quick access, updater messaging, and workspace-device labeling truthful across macOS, Windows, and Linux. Linux tray or AppIndicator caveats belong in `ISSUES.md` until they are validated on real desktops.
- Record truthfulness caveats in `ISSUES.md` when behavior is narrower than the intended contract, such as prompt-caching scope or backlog-cleanup revisit scope.
- Treat Anthropic prompt-caching payload tests as request-shape validation only; do not call prompt caching fully validated until live provider usage confirms cache reads or writes.
- For launch-readiness passes, distinguish clearly between dev-run validation, packaged-app validation, and real cross-platform validation. Keep close-window survival, workspace creation/linking, and explicit streaming-proof claims in `ISSUES.md` until a human validates them end to end.
- Do not claim AI starter prompts, freeform provider-backed answers, focus-session AI flows, report/export generation, week-review AI, or end-to-end rename/reset interactions were validated in a pass unless they were actually exercised in that pass.
- Update the canonical docs during the same task whenever behavior or status changed enough that the docs would drift.
- Unless the user explicitly confirms something is done, describe it as `upon review`, `ready for review`, `implemented pending verification`, or similar.
- Before marking work as fixed or done in the docs, ask the user whether they tested it and whether it worked.
- If copy in another doc conflicts with `AGENTS.md`, `../README.md`, or the current code, prefer those sources.
