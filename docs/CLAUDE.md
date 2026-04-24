# Daylens Contributor Guide

Start from code, not prose.

Use sources in this order:

1. Current implementation in `src/main`, `src/renderer`, `src/shared`, `packages/remote-contract`, and the paired `daylens-web` repo when remote behavior is in scope.
2. Behavior tests in `tests/`.
3. `docs/ISSUES.md` for current status wording.
4. `docs/AGENTS.md` for the product contract.
5. The remaining docs only after the code and status ledger agree.

Rules:

- Existing docs are hypotheses until the code confirms them.
- Use exact file references when helpful.
- Distinguish code-proven, inferred, and runtime-validated claims.
- Use `implemented pending verification` when code exists without runtime proof.
- Keep `docs/ISSUES.md` as the implementation-status ledger.
- For remote-companion work, re-audit both `daylens` and `daylens-web` before claiming parity.
