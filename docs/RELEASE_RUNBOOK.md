# Release Runbook

This project publishes Windows releases through GitHub Actions and a GitHub release page.

## Preconditions

Only cut a release from a clean, intentional release commit.

Before tagging:

```bash
npm run typecheck
npm run build:all
npm run benchmark:ai-workspace
npm run benchmark:ai-workspace:extended
```

Also confirm:

- `CHANGELOG.md` contains a section for the version you are releasing
- the release tag will follow the Windows convention: `vX.Y.Z-win`
- any installer-signing secrets required by `.github/workflows/release-windows.yml` are present in GitHub

## How the release page is created

The GitHub Actions workflow `.github/workflows/release-windows.yml` does the release-page work automatically:

1. derives the Windows semver from the pushed tag or manual dispatch inputs
2. stamps that version into `package.json` during the workflow build
3. rebuilds native modules, typechecks, and builds the app
4. publishes the installer, `latest.yml`, and blockmap metadata
5. extracts the matching `CHANGELOG.md` section
6. creates the GitHub release page body with highlights, install steps, update notes, and a commit summary

## Triggering CI / release

Preferred path:

```bash
git tag v1.0.19-win
git push origin v1.0.19-win
```

Manual dispatch is also supported by the workflow for cases where you need to rerun packaging against an existing ref.

## Release outputs

Successful release runs publish:

- `Daylens-{version}-Setup.exe`
- `Daylens-{version}-Setup.exe.blockmap`
- `latest.yml`
- a GitHub release page populated from `CHANGELOG.md`

## Safety note

Do not tag from a workstation that still has unrelated uncommitted product changes. The release page and artifacts should always correspond to a reviewable Git commit.
