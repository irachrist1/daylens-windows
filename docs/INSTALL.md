# Installing Daylens

Pick your platform — each one works in under a minute.

- [macOS](#macos) — one-click Homebrew, or drag-and-drop DMG
- [Windows](#windows) — one-click installer
- [Linux](#linux) — AppImage, deb, rpm, or tar.gz
- [Troubleshooting](#troubleshooting) — older DMGs, "damaged" dialog, source builds

## Public download routes

These links stay versionless on purpose, so they follow the newest real release asset instead of assuming every latest tag contains every platform package.

- **macOS (Apple Silicon):** [download now](https://daylens-web-irachrist1s-projects.vercel.app/daylens/api/download/mac)
- **Windows:** [download now](https://daylens-web-irachrist1s-projects.vercel.app/daylens/api/download/windows)
- **Linux:** [status page](https://daylens-web-irachrist1s-projects.vercel.app/daylens/linux)

Need a different version? Browse the [full releases page](https://github.com/irachrist1/daylens/releases).

---

## macOS

### Option A — Homebrew (fastest, zero prompts)

```bash
brew install --cask irachrist1/daylens/daylens
```

Homebrew handles the one-time macOS approval step for you. To upgrade later: `brew upgrade --cask daylens`. To remove: `brew uninstall --cask daylens`.

### Option B — Drag-and-drop DMG

1. Download the current macOS DMG from the link above
2. Double-click the DMG to open it
3. Drag the **Daylens** icon onto the **Applications** folder on the right
4. Eject the DMG
5. Open **Applications** and double-click **Daylens**

**First launch shows a one-time approval prompt.** This is normal and expected — macOS shows it for any app that isn't distributed through the App Store (the same prompt you see on ChatGPT's Codex app and most indie Mac apps).

The prompt looks like this:

> **"Daylens" Not Opened**
>
> Apple could not verify "Daylens" is free of malware that may harm your Mac or compromise your privacy.
>
> **[ Move to Trash ]  [ Done ]**

To approve Daylens — takes about 15 seconds, one time only:

1. Click **Done** on the prompt
2. Open the Apple menu → **System Settings**
3. Click **Privacy & Security** in the sidebar
4. Scroll down to the **Security** section (near the bottom)
5. Find the line *"Daylens was blocked to protect your Mac"* and click **Open Anyway**
6. Confirm with your password or Touch ID

Daylens launches. From then on, just double-click it like any other app.

The mounted DMG also includes a `Start Here.txt` file with the same walkthrough if you prefer to read it there.

### Apple Silicon only

Daylens currently ships arm64 builds only. Intel Macs are not supported by the published DMG. If you need Intel, build from source with `npm run dist:mac`.

---

## Windows

1. Download the current Windows installer from the link above
2. Run it. It installs per-user (no admin prompt) and launches automatically.
3. If Windows shows a blue *"Windows protected your PC"* banner, stop and verify the installer came from the official Daylens release link above. Older Windows builds were unsigned, which triggers the strongest SmartScreen warning. New public Windows releases are expected to be Authenticode-signed; a signed but brand-new build can still show a reputation warning until Microsoft has seen enough trusted installs.

To uninstall: **Settings → Apps → Daylens → Uninstall**.

---

## Linux

Pick whichever matches your distro:

- **AppImage** — `chmod +x Daylens-1.0.27.AppImage && ./Daylens-1.0.27.AppImage`
- **Debian/Ubuntu** — `sudo apt install ./Daylens-1.0.27.deb`
- **Fedora/RHEL** — `sudo dnf install ./Daylens-1.0.27.rpm`
- **Other** — extract `Daylens-1.0.27.tar.gz` and run `./daylens`

---

## Troubleshooting

### "Daylens is damaged and can't be opened" (older DMGs, v1.0.27 and earlier)

v1.0.28 onward ships with a deep ad-hoc signature that Gatekeeper accepts — you should see the "Not Opened" prompt described above, not "damaged". If you somehow still hit the damaged dialog (old DMG, corrupted download, or sideloaded copy), run this one Terminal command:

```bash
codesign --force --deep --sign - /Applications/Daylens.app && xattr -cr /Applications/Daylens.app
```

No `sudo` required. It replaces the broken signature with a proper ad-hoc one and removes the download quarantine. Double-click Daylens afterwards — done.

### Why the approval step exists at all

Daylens is **ad-hoc signed** but not Apple-notarized. Notarization requires the $99/yr Apple Developer Program, which Daylens does not currently fund. The app is exactly the same — you're just telling macOS "yes, I trust this developer" the first time you launch it, instead of Apple having pre-registered the signature. Homebrew's `postflight` hook performs that trust step for you automatically, which is why Option A has no prompts.

### Running from source (developers)

```bash
git clone https://github.com/irachrist1/daylens.git
cd daylens
npm install
npm start
```

Locally-built apps don't carry a quarantine bit, so the first-launch approval prompt never appears during development.

---

## Data location

Daylens stores everything locally — your data never leaves your machine.

- macOS: `~/Library/Application Support/Daylens/`
- Windows: `%APPDATA%\Daylens\`
- Linux: `~/.config/Daylens/`

See [docs/ISSUES.md](ISSUES.md) for current constraints and known platform-specific issues.
