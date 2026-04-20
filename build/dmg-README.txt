Installing Daylens on macOS
============================

1. Drag the Daylens icon onto the Applications folder on the right.
2. Open Daylens from /Applications or Spotlight.


If macOS says "Daylens is damaged and can't be opened":
-------------------------------------------------------

The app file is intact. Daylens is ad-hoc signed rather than Apple-
notarized (notarization costs $99/yr, which Daylens does not fund).
On Apple Silicon, electron-builder emits a linker-signed stub without
sealed resources and Gatekeeper reports that as "damaged".

Run this ONE command in Terminal and it's fixed forever:

    codesign --force --deep --sign - /Applications/Daylens.app && \
        xattr -cr /Applications/Daylens.app

No sudo required. Then double-click Daylens normally.

What that command does:
  codesign --force --deep --sign -   Replaces the broken stub with a
                                     proper ad-hoc signature so
                                     Gatekeeper can verify it.
  xattr -cr                          Removes the download quarantine
                                     so the unidentified-developer
                                     prompt never appears.


Prefer Homebrew? One-liner, runs the same two steps for you:

    brew install --cask irachrist1/daylens/daylens


Full install guide and Windows/Linux instructions:
https://github.com/irachrist1/daylens/blob/main/docs/INSTALL.md

Daylens is local-first. Your tracked history never leaves your Mac.
