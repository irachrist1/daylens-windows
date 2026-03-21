# Build & Release

## Dev (electron-forge)

```bash
npm install
npm start          # launches electron-forge dev server with HMR
```

Forge manages Vite configs automatically — no `STANDALONE_BUILD` needed.

## Production standalone build

Three Vite configs must run in order:

```bash
npm run build:all
# equivalent to:
STANDALONE_BUILD=1 vite build --config vite.main.config.ts
STANDALONE_BUILD=1 vite build --config vite.preload.config.ts
STANDALONE_BUILD=1 vite build --config vite.renderer.config.ts
```

Output:
```
dist/
  main/
    main.js       ← main process
    preload.js    ← preload script
  renderer/
    main_window/  ← renderer static files
```

`electron-builder` then packages `dist/**` + `package.json` into `dist-release/`.

## Why `STANDALONE_BUILD=1`?

The Vite configs are shared between electron-forge (dev) and electron-builder (prod). The flag switches:
- `outDir` → `dist/main` or `dist/renderer/main_window` (instead of forge's `.vite/`)
- `ssr: true` on main + preload → prevents Vite treating them as browser bundles and externalising `node:` builtins
- `format: 'cjs'` on main + preload → keeps the packaged Electron runtime on CommonJS so `__dirname` and native-module loading work at startup
- `define` → injects `MAIN_WINDOW_VITE_DEV_SERVER_URL = undefined` so the packaged app loads from disk

## electron-builder config (`electron-builder.yml`)

- Output: `dist-release/`
- Targets: NSIS installer (x64)
- ARM64 is **not** built — `@paymoapp/active-window` has no prebuilt Windows ARM64 binaries and node-gyp fails on Python 3.12+ (missing `distutils`)
- Native modules unpacked from asar: `better-sqlite3`, `@paymoapp/active-window`, `keytar`
- `extraMetadata.main: dist/main/main.js` overrides `package.json "main"` inside the package

## Artifacts

| File | Description |
|---|---|
| `Daylens-{version}-Setup.exe` | NSIS installer — creates Start menu + Desktop shortcuts |

## Release workflow (GitHub Actions)

Trigger: push a tag matching `v*-win` (e.g. `v0.1.4-win`).

Steps:
1. Derive semver from tag (`v0.1.4-win` → `0.1.4`)
2. `npm ci --ignore-scripts`
3. `electron-rebuild -f -w better-sqlite3,@paymoapp/active-window,keytar` — rebuilds native modules against Electron's Node ABI
4. Three Vite builds (with `STANDALONE_BUILD=1`)
5. `electron-builder --win --publish never`
6. `softprops/action-gh-release@v2` creates the GitHub release with the installer artifact

Workflow file: `.github/workflows/release-windows.yml`

## Tagging convention

- Windows releases: `v0.x.y-win`
- macOS releases (separate repo): `v1.x.y` — never mix versioning

```bash
git tag v0.1.5-win
git push origin v0.1.5-win
```

## Known CI issues resolved

| Tag | Failure | Fix |
|---|---|---|
| v0.1.0-win | `argv.w.split is not a function` | electron-rebuild: `-w mod1,mod2` not `-w mod1 -w mod2` |
| v0.1.1-win | `Could not resolve entry module "src/main/index.ts/index.html"` | Moved entry points to `rollupOptions.input`; removed CLI positional args |
| v0.1.2-win | `"promisify" is not exported by "__vite-browser-external"` | Added `ssr: true` to standalone build options |
| v0.1.3-win | `ModuleNotFoundError: No module named 'distutils'` | Dropped ARM64 target — no prebuilt binaries, node-gyp fails on Python 3.12+ |
| v0.1.6-win | `require is not defined in ES module scope` on first launch | Emit the packaged main bundle as CommonJS and remove the leftover Squirrel startup hook |
