cask "daylens" do
  version "1.0.29"
  sha256 "b2d21f8bba3be1e2b618f81fb28428b13273a193cf3aed61eae62146d32e0e85"

  url "https://github.com/irachrist1/daylens/releases/download/v#{version}/Daylens-#{version}-arm64.dmg"
  name "Daylens"
  desc "Activity tracker that turns laptop history into a searchable, AI-ready work timeline"
  homepage "https://github.com/irachrist1/daylens"

  livecheck do
    url :url
    strategy :github_latest
    regex(/^Daylens[._-]v?(\d+(?:\.\d+)+)[._-]arm64\.dmg$/i)
  end

  auto_updates false
  depends_on macos: ">= :big_sur"
  depends_on arch: :arm64

  app "Daylens.app"

  postflight do
    # electron-builder without a Developer ID emits a linker-signed ad-hoc
    # stub with no CodeResources, which Gatekeeper flags as "damaged and
    # can't be opened". Re-signing ad-hoc with --force --deep produces a
    # complete, verifiable signature. Then we strip the quarantine bit so
    # users don't hit the "unidentified developer" gate either. Both steps
    # are required; stripping quarantine alone leaves the broken signature
    # and the damaged dialog still fires on Finder double-click.
    system_command "/usr/bin/codesign",
                   args: ["--force", "--deep", "--sign", "-", "#{appdir}/Daylens.app"],
                   sudo: false
    system_command "/usr/bin/xattr",
                   args: ["-dr", "com.apple.quarantine", "#{appdir}/Daylens.app"],
                   sudo: false
  end

  zap trash: [
    "~/Library/Application Support/Daylens",
    "~/Library/Application Support/DaylensWindows",
    "~/Library/Caches/com.daylens.desktop",
    "~/Library/Caches/com.daylens.desktop.ShipIt",
    "~/Library/Logs/Daylens",
    "~/Library/Preferences/com.daylens.desktop.plist",
    "~/Library/Saved Application State/com.daylens.desktop.savedState",
  ]
end
