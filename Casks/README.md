# Homebrew Cask

`daylens.rb` is the source of truth for the Homebrew cask. Users install with:

```bash
brew install --cask irachrist1/daylens/daylens
```

## Publishing the tap (one-time setup)

Homebrew taps must live in a separate repo named `homebrew-<name>`.

1. Create a public GitHub repo called `homebrew-daylens` under the `irachrist1` account. Empty, no README needed.
2. Copy this cask into the tap:

   ```bash
   git clone https://github.com/irachrist1/homebrew-daylens.git
   cd homebrew-daylens
   mkdir -p Casks
   cp /path/to/daylens/Casks/daylens.rb Casks/
   git add Casks/daylens.rb
   git commit -m "Add daylens cask for v1.0.26"
   git push
   ```

3. Smoke-test from any Mac:

   ```bash
   brew tap irachrist1/daylens
   brew install --cask daylens
   brew audit --cask daylens   # sanity check
   ```

4. Add to the release checklist: every time you publish a new macOS DMG, bump `version` and `sha256` in `Casks/daylens.rb`, then push. A GitHub Action can automate this — `livecheck` already tells `brew livecheck daylens` where to look.

## Keeping it in sync on every release

Add a step to `.github/workflows/release-macos.yml` that, after a successful DMG upload, opens a PR against `irachrist1/homebrew-daylens` updating `version` + `sha256`. The standard action for this is [`macauley/action-homebrew-bump-cask`](https://github.com/macauley/action-homebrew-bump-cask) or a simple `sed` + `gh pr create` script. Not wired up yet — open for a follow-up.
