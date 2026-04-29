# Daylens Release Runbook

How to ship a new version. Follow every step in order. The v1.0.33 release is the reference for a clean run.

---

## The correct process (what actually works)

### 1. Bump the version

Edit `package.json` — change `"version"` to the new version string (e.g. `"1.0.34"`). Nothing else.

### 2. Update CHANGELOG.md

Add a new `## v{VERSION} - {DATE}` section at the top of CHANGELOG.md **before pushing**. The CI reads this file at build time and uses it as the GitHub release body. If the section is missing the release page falls back to "Preview release build for vX.Y.Z" — informationless to users.

Format:
```markdown
## v1.0.34 - 2026-05-01

### Fixed
- **Short bold title.** One sentence explaining what broke and how it is fixed.

### Added
- **Short bold title.** One sentence explaining what is new and why it matters.
```

### 3. Run tests locally

```bash
npm run typecheck
npm run test:ai-chat
```

Both must pass with zero failures before committing.

### 4. Commit everything

Stage all changed source files plus `package.json`, `CHANGELOG.md`, and any updated docs. Do **not** stage `.agents/`, `skills-lock.json`, or any local tool output.

```bash
git add <source files> CHANGELOG.md docs/ package.json
git commit -m "release: v1.0.34 — <one-line summary>"
git push origin main
```

### 5. Push platform tags

This is what triggers CI. Each tag maps to one workflow:

| Tag | Workflow | Runner |
|---|---|---|
| `v{VERSION}-mac` | `release-macos.yml` | `macos-latest` (arm64) |
| `v{VERSION}-win` | `release-windows.yml` | `windows-latest` |
| `v{VERSION}-linux` | `release-linux.yml` | `ubuntu-latest` (optional) |

```bash
git tag v1.0.34-mac
git tag v1.0.34-win
git push origin v1.0.34-mac v1.0.34-win
```

Push both tags in a single command. If you push them separately there is a race condition where the Windows workflow tries to create the GitHub release that macOS already created — this is harmless (the release action uses `overwrite_files: true`) but can cause a confusing log warning.

### 6. Watch the runs

```bash
gh run list --limit 5
gh run watch <run-id>           # live tail a specific run
gh run view <run-id> --log-failed   # see only failed steps
```

Both macOS and Windows runs should complete in under 5 minutes on a normal day.

---

## What CI does (so you understand failures)

### Version derivation

CI strips the tag suffix to get the version number:
- `v1.0.34-mac` → `1.0.34`
- `v1.0.34-win` → `1.0.34`

It then stamps `package.json` on the runner with that version. So the version in your local `package.json` commit just needs to match — CI overwrites it during build. If they don't match the GitHub release will be named correctly but the in-app version string may differ.

### Release notes pipeline

```
CHANGELOG.md → awk extraction → GitHub release body → electron-updater fetch → UpdateBanner "Includes:" line
```

The `awk` script in the workflow grabs everything between `## v{VERSION} -` and the next `## v` line. That text becomes the GitHub release body. `electron-updater` fetches the release body and passes it as `releaseNotesText`. `extractReleaseHighlights()` in `src/renderer/lib/releaseNotes.ts` strips the markdown and returns the first 2 bullet points for the update banner.

**Consequence:** if you push the tag before updating CHANGELOG.md, the update banner will show nothing useful to users.

### GitHub release tag

Both macOS and Windows workflows publish assets to the same GitHub release at `v{VERSION}` (no platform suffix). The macOS workflow creates it first; Windows uploads into it with `overwrite_files: true`. The release is not draft, not pre-release.

### Native module verification

After packaging, CI runs `node scripts/verify-packaged-natives.js dist-release`. This script checks that `better-sqlite3`, `@paymoapp/active-window`, and `keytar` are present in the unpacked layout inside the ASAR. If any are missing the step exits with code 1 and the run fails. This was the root cause of several failures in the v1.0.30–v1.0.32 range.

### Windows code signing

Public Windows releases must be Authenticode-signed. `release-windows.yml` fails before packaging when `WIN_CERTIFICATE_FILE` or `WIN_CERTIFICATE_PASSWORD` is missing, then checks `Get-AuthenticodeSignature` for the unpacked app executable, NSIS helper, generated uninstaller, and setup installer before uploading release assets.

Required GitHub Actions secrets:

- `WIN_CERTIFICATE_FILE` — base64-encoded trusted PFX certificate
- `WIN_CERTIFICATE_PASSWORD` — PFX password
- `WIN_CERT_SUBJECT_NAME` — optional publisher subject hint

Unsigned internal test builds belong in `preview-builds.yml`, not the public release workflow. A valid signature proves publisher identity and avoids the strongest unknown-publisher block, but Microsoft SmartScreen reputation can still warn for a new file hash until the signed app builds reputation.

---

## Why previous releases failed (historical)

### Native module verification failures (v1.0.30 – v1.0.32 early runs)

**Symptom:** Windows run fails at "Verify packaged native module layout" with:
```
[packaged-natives] dist-release\win-unpacked\resources\app.asar is missing /node_modules/better-sqlite3/package.json
```

**Root cause:** `electron-builder` was not correctly unpacking native modules into `app.asar.unpacked`. The `verify-packaged-natives.js` script was added in v1.0.32 to catch this before publish. The underlying `electron-builder.config.js` `asarUnpack` patterns were fixed across `4e83fe4`–`7a7b609` (the four commits immediately before v1.0.33).

**Status:** Fixed. If this re-appears, check `asarUnpack` in `electron-builder.config.js`.

### Unsigned Windows installers (v1.0.33 and earlier)

**Symptom:** Installing on Windows shows the blue Defender SmartScreen / "Windows protected your PC" warning, with the installer treated as unknown or potentially dangerous.

**Root cause:** The public Windows release workflow allowed empty signing secrets. electron-builder logged `no signing info identified, signing is skipped` for `Daylens.exe`, `elevate.exe`, the NSIS uninstaller, and `Daylens-1.0.33-Setup.exe`, then uploaded the unsigned installer anyway.

**Status:** Release workflow fixed to require signing secrets and verify Authenticode signatures before upload. The remaining operational blocker is adding a trusted Windows code-signing certificate to GitHub Actions secrets before the next Windows release.

### Artifact storage quota (sporadic)

**Symptom:** Run shows success but the diagnostics upload step prints:
```
Failed to CreateArtifact: Artifact storage quota has been hit. Unable to upload any new artifacts.
```

**Root cause:** GitHub Actions artifact storage quota was exhausted. The diagnostics upload step uses `continue-on-error: true` so this does **not** fail the release — the DMG/EXE/YML files still publish to the GitHub release correctly.

**Status:** Not a real failure. Quota recalculates every 6–12 hours. Old diagnostic artifacts auto-expire after 14 days (configured in the workflows).

### Wrong tag in `workflow_dispatch` (manual re-runs)

**Symptom:** `workflow_dispatch` run checks out the wrong commit, typechecks pass, but the packaged version number is wrong or the release overwrites a different version.

**Root cause:** When triggering manually via `workflow_dispatch`, both `version` and `tag_name` inputs must be provided and must be consistent:
- `version` = bare number, e.g. `1.0.33`
- `tag_name` = full platform tag, e.g. `v1.0.33-mac`

If `tag_name` points to a tag that does not yet exist on the remote, checkout will fail silently or fall back to HEAD.

**Status:** Not a real failure when using the tag-push method (step 5 above). Only relevant for manual re-runs.

### Pushing tags before committing CHANGELOG (missing release notes)

**Symptom:** GitHub release body shows "Preview release build for vX.Y.Z". Update banner shows nothing.

**Root cause:** Tags were pushed before CHANGELOG.md was updated. CI checked out the tagged commit and found no matching section in CHANGELOG.md.

**Status:** Avoided by always updating CHANGELOG.md in the same commit as `package.json`, before creating tags.

---

## Monitoring during a release

```bash
# See all recent runs
gh run list --limit 10

# Live-stream a specific run
gh run watch <run-id>

# Show only failed step logs (fastest for debugging)
gh run view <run-id> --log-failed

# Confirm the GitHub release was created with assets
gh release view v1.0.34
```

GitHub web UI: `https://github.com/irachrist1/daylens/actions`

For persistent notifications, enable GitHub email notifications for "Failed workflows" under Settings → Notifications. The `gh` CLI is the fastest debugging tool — `--log-failed` shows only the relevant lines and skips the setup noise.

---

## Checklist (copy this each release)

```
[ ] Bump version in package.json
[ ] Write CHANGELOG.md entry with date
[ ] npm run typecheck — zero errors
[ ] npm run test:ai-chat — all pass
[ ] Confirm Windows signing secrets exist before pushing v{VERSION}-win
[ ] git add + commit + push to main
[ ] git tag v{VERSION}-mac && git tag v{VERSION}-win
[ ] git push origin v{VERSION}-mac v{VERSION}-win
[ ] gh run list — confirm both runs appear
[ ] gh run watch <run-id> — confirm both succeed
[ ] For Windows, confirm "Verify Authenticode signatures" passed
[ ] gh release view v{VERSION} — confirm assets present
```
