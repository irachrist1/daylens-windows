# Installing Daylens

Daylens ships for macOS, Windows, and Linux from one [GitHub release page](https://github.com/irachrist1/daylens/releases/latest).

- [macOS](#macos) — Homebrew (recommended) or manual DMG
- [Windows](#windows) — one-click installer
- [Linux](#linux) — AppImage, deb, rpm, or tar.gz
- [Why macOS shows "Daylens is damaged"](#why-macos-shows-daylens-is-damaged)

---

## macOS

### Option A — Homebrew (recommended, one command)

```bash
brew install --cask irachrist1/daylens/daylens
```

This works because Homebrew strips the macOS quarantine attribute during install, so Gatekeeper never sees the app as "from the internet." No warnings, no Terminal gymnastics.

To upgrade later:

```bash
brew upgrade --cask daylens
```

To uninstall:

```bash
brew uninstall --cask daylens
```

### Option B — Manual DMG

1. Download `Daylens-<version>-arm64.dmg` from the [latest release](https://github.com/irachrist1/daylens/releases/latest)
2. Double-click the DMG to mount it
3. Drag the **Daylens** icon onto the **Applications** folder alias
4. Eject the DMG
5. Open Daylens from `/Applications` or Spotlight

If macOS shows **"Daylens is damaged and can't be opened"**, see the next section.

### Why macOS shows "Daylens is damaged"

Daylens DMGs are **ad-hoc signed** but not yet Apple-notarized (notarization requires the $99/yr Apple Developer Program, which Daylens does not currently fund). On Apple Silicon, electron-builder's ad-hoc signing emits a linker-signed stub with no sealed resources — Gatekeeper reports that as "damaged." The app file is intact, but the signature is incomplete.

The Homebrew path above fixes both issues automatically. If you installed the DMG manually, run **the single command below** — it re-signs the bundle with a proper ad-hoc signature and removes the download quarantine in one go.

#### Fix 1 — One Terminal command (recommended)

```bash
codesign --force --deep --sign - /Applications/Daylens.app && xattr -cr /Applications/Daylens.app
```

No `sudo` required. Double-click Daylens afterwards. Done forever.

- `codesign --force --deep --sign -` replaces the broken stub with a full ad-hoc signature that Gatekeeper can verify (fixes the "damaged" dialog).
- `xattr -cr` removes the `com.apple.quarantine` attribute your browser attached (skips the "unidentified developer" dialog).

#### Fix 2 — "Open Anyway" in System Settings (no Terminal)

Note: on Apple Silicon this sometimes still fails because the signature itself is broken. If it does, fall back to Fix 1.

1. Try to open Daylens. You'll see the "damaged" dialog. Click **Cancel**.
2. Open **System Settings** → **Privacy & Security**
3. Scroll to the **Security** section
4. You'll see *"Daylens was blocked to protect your Mac."* Click **Open Anyway**
5. Confirm with your password or Touch ID
6. Daylens launches. One-time only.

#### Fix 3 — Use Homebrew

The cleanest path is:

```bash
brew install --cask irachrist1/daylens/daylens
```

The cask runs the `codesign` + `xattr` steps for you during install.

### Apple Silicon only

Daylens currently ships arm64 builds only. Intel Macs are not supported by the published DMG. If you need Intel, build from source with `npm run dist:mac`.

---

## Windows

1. Download `Daylens-<version>-Setup.exe` from the [latest release](https://github.com/irachrist1/daylens/releases/latest)
2. Run it. It installs per-user (no admin prompt) and launches automatically.
3. SmartScreen may show a blue "Windows protected your PC" banner on first run. Click **More info** → **Run anyway**. This is the Windows equivalent of the macOS "damaged" dialog — ad-hoc signed builds are unknown to Microsoft's reputation service.

To uninstall: **Settings → Apps → Daylens → Uninstall**.

---

## Linux

Pick whichever matches your distro:

- **AppImage** — `chmod +x Daylens-<version>.AppImage && ./Daylens-<version>.AppImage`
- **Debian/Ubuntu** — `sudo apt install ./Daylens-<version>.deb`
- **Fedora/RHEL** — `sudo dnf install ./Daylens-<version>.rpm`
- **Other** — extract `Daylens-<version>.tar.gz` and run `./daylens`

---

## Running from source (developers)

```bash
git clone https://github.com/irachrist1/daylens.git
cd daylens
npm install
npm start
```

Locally-built apps don't carry a quarantine bit, so the macOS "damaged" dialog never appears.

---

## Data location

Daylens stores everything locally — your data never leaves your machine.

- macOS: `~/Library/Application Support/Daylens/`
- Windows: `%APPDATA%\Daylens\`
- Linux: `~/.config/Daylens/`

See [docs/ISSUES.md](ISSUES.md) for current constraints and known platform-specific issues.
