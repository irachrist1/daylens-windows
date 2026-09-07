const fs = require('node:fs')

const win = {
  target: [
    {
      target: 'nsis',
      arch: ['x64'],
    },
  ],
  icon: 'build/icon.ico',
  artifactName: 'Daylens-${version}-Setup.${ext}',
}

const appx = {
  artifactName: 'Daylens-${version}-Store.${ext}',
  displayName: 'Daylens',
  publisherDisplayName: process.env.DAYLENS_APPX_PUBLISHER_DISPLAY_NAME || 'Daylens',
  identityName: process.env.DAYLENS_APPX_IDENTITY_NAME || 'Daylens.Desktop',
  applicationId: process.env.DAYLENS_APPX_APPLICATION_ID || 'Daylens',
  publisher: process.env.DAYLENS_APPX_PUBLISHER || 'CN=Daylens',
  languages: ['en-US'],
  backgroundColor: '#111827',
}

const mac = {
  target: ['zip', 'dmg'],
  icon: 'build/icon.icns',
  category: 'public.app-category.productivity',
  artifactName: 'Daylens-${version}-${arch}.${ext}',
  hardenedRuntime: true,
  gatekeeperAssess: false,
  // EventKit attributes the Calendar prompt to Daylens.app (Electron does not
  // disclaim child helpers). These strings must live on the parent bundle.
  extendInfo: {
    NSCalendarsUsageDescription:
      'Daylens reads meetings already on this Mac so they can sit beside the day as scheduled context. It does not create or change events.',
    NSCalendarsFullAccessUsageDescription:
      'Daylens reads meetings already on this Mac so they can sit beside the day as scheduled context. It does not create or change events.',
  },
  // Hardened-runtime exceptions Electron needs (V8 JIT / wasm). Explicit files
  // instead of electron-builder's bundled defaults so signed builds are
  // deterministic and reviewable.
  entitlements: 'build/entitlements.mac.plist',
  entitlementsInherit: 'build/entitlements.mac.plist',
  // Notarization runs automatically after Developer ID signing when the Apple
  // credentials are present in the environment: either APPLE_API_KEY (path to
  // the App Store Connect .p8) + APPLE_API_KEY_ID + APPLE_API_ISSUER, or
  // APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID. Ad-hoc builds
  // never sign with an identity, so notarization is skipped there.
  notarize: true,
}

const macAfterSign = './scripts/mac-afterSign.js'

const linux = {
  target: [
    {
      target: 'AppImage',
      arch: ['x64'],
    },
    {
      target: 'deb',
      arch: ['x64'],
    },
    {
      target: 'rpm',
      arch: ['x64'],
    },
    {
      target: 'tar.gz',
      arch: ['x64'],
    },
  ],
  icon: 'build/icon.png',
  executableName: 'daylens',
  category: 'Productivity',
  maintainer: 'Christian Tonny <irachrist1@users.noreply.github.com>',
  artifactName: 'Daylens-${version}.${ext}',
  synopsis: 'Cross-platform activity tracking and grounded AI work history',
  description: 'Cross-platform activity tracker that turns laptop history into a searchable, AI-ready work timeline.',
  desktop: {
    entry: {
      StartupWMClass: 'daylens',
      StartupNotify: 'true',
      'X-GNOME-UsesNotifications': 'true',
    },
  },
}

if (process.env.WIN_CERTIFICATE_FILE_PATH) {
  win.certificateFile = process.env.WIN_CERTIFICATE_FILE_PATH
}

if (process.env.WIN_CERTIFICATE_PASSWORD) {
  win.certificatePassword = process.env.WIN_CERTIFICATE_PASSWORD
}

if (process.env.WIN_CERT_SUBJECT_NAME) {
  win.certificateSubjectName = process.env.WIN_CERT_SUBJECT_NAME
  win.publisherName = [process.env.WIN_CERT_SUBJECT_NAME]
}

if (
  process.env.DAYLENS_REQUIRE_WIN_SIGNING === '1'
  && (!process.env.WIN_CERTIFICATE_FILE_PATH || !process.env.WIN_CERTIFICATE_PASSWORD || !process.env.WIN_CERT_SUBJECT_NAME)
) {
  throw new Error('DAYLENS_REQUIRE_WIN_SIGNING=1 requires WIN_CERTIFICATE_FILE_PATH, WIN_CERTIFICATE_PASSWORD, and WIN_CERT_SUBJECT_NAME')
}

if (process.env.DAYLENS_REQUIRE_WIN_SIGNING === '1' && !fs.existsSync(process.env.WIN_CERTIFICATE_FILE_PATH)) {
  throw new Error(`DAYLENS_REQUIRE_WIN_SIGNING=1 requires WIN_CERTIFICATE_FILE_PATH to exist: ${process.env.WIN_CERTIFICATE_FILE_PATH}`)
}

// Mirrors DAYLENS_REQUIRE_WIN_SIGNING: when a release must ship Developer-ID
// signed and notarized, fail the build up front with the exact list of missing
// credentials instead of silently producing an ad-hoc build.
if (process.env.DAYLENS_REQUIRE_MAC_SIGNING === '1') {
  const missing = []
  if (!process.env.CSC_LINK) missing.push('CSC_LINK (base64 Developer ID Application .p12)')
  if (!process.env.CSC_KEY_PASSWORD) missing.push('CSC_KEY_PASSWORD (.p12 password)')
  const hasApiKeyNotary = process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER
  const hasAppleIdNotary = process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID
  if (!hasApiKeyNotary && !hasAppleIdNotary) {
    missing.push('notarization credentials: either APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER, or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID')
  }
  if (missing.length > 0) {
    throw new Error(`DAYLENS_REQUIRE_MAC_SIGNING=1 but credentials are missing:\n- ${missing.join('\n- ')}`)
  }
}

module.exports = {
  appId: 'com.daylens.desktop',
  productName: 'Daylens',
  copyright: 'Copyright © 2026 Daylens',
  directories: {
    output: 'dist-release',
    buildResources: 'build',
  },
  files: [
    'dist/**/*',
    'package.json',
    'shared/app-normalization.v1.json',
  ],
  extraMetadata: {
    main: 'dist/main/main.js',
  },
  electronUpdaterCompatibility: '>=2.16',
  extraResources: [
    {
      from: 'build/',
      to: 'build',
    },
    {
      from: 'shared/app-normalization.v1.json',
      to: 'app-normalization.v1.json',
    },
    // DEV-180: the pinned local embedding model for search-by-meaning
    // (populated by `npm run models:semantic`; ~24 MB). Ships with the
    // installer so first-run semantic search works offline, per
    // docs/specs/memory-and-entities.md §Local semantic search. When the
    // download step was skipped the directory only holds its README and
    // semantic search is honestly absent at runtime.
    ...(fs.existsSync('resources/models')
      ? [{ from: 'resources/models', to: 'models' }]
      : []),
  ],
  mac,
  afterPack: './scripts/afterPack-native-modules.js',
  afterSign: macAfterSign,
  win,
  appx,
  linux,
  deb: {
    // Force the Debian Package field to "daylens". Without this electron-builder
    // derives it from package.json "name" (currently "daylens-windows"), which is
    // why the App Center listed the package as daylens-windows (issue #18).
    packageName: 'daylens',
    depends: ['libgtk-3-0', 'libnotify4', 'libnss3', 'libxss1', 'libxtst6', 'xdg-utils', 'libatspi2.0-0', 'libuuid1', 'libsecret-1-0'],
    // Guarantee the Chromium SUID sandbox is root-owned with mode 4755 (issue #17).
    afterInstall: 'build/linux/after-install.sh',
    afterRemove: 'build/linux/after-remove.sh',
  },
  rpm: {
    packageName: 'daylens',
    depends: ['gtk3', 'libnotify', 'nss', 'libXScrnSaver', '(libXtst or libXtst6)', 'xdg-utils', 'at-spi2-core', '(libuuid or libuuid1)', 'libsecret'],
    // Same Chromium SUID sandbox hardening as deb (issue #17): rpm installs to
    // /opt/Daylens and ships the same chrome-sandbox helper, so without these
    // hooks rpm users hit the "chrome-sandbox is not configured correctly"
    // launch failure. The scripts are POSIX sh so rpm's %post/%postun can run them.
    afterInstall: 'build/linux/after-install.sh',
    afterRemove: 'build/linux/after-remove.sh',
  },
  nsis: {
    oneClick: true,
    include: 'build/win/uninstall.nsh',
    perMachine: false,
    allowToChangeInstallationDirectory: false,
    deleteAppDataOnUninstall: false,
    installerIcon: 'build/icon.ico',
    uninstallerIcon: 'build/icon.ico',
    installerHeaderIcon: 'build/icon.ico',
    createDesktopShortcut: false,
    createStartMenuShortcut: true,
    shortcutName: 'Daylens',
    runAfterFinish: true,
  },
  dmg: {
    background: 'build/dmg-background.png',
    icon: 'build/icon.icns',
    iconSize: 128,
    window: {
      width: 660,
      height: 480,
    },
    contents: [
      { x: 180, y: 225, type: 'file' },
      { x: 480, y: 225, type: 'link', path: '/Applications' },
      { x: 330, y: 400, type: 'file', path: 'build/dmg-README.txt', name: 'Start Here.txt' },
    ],
  },
  asar: true,
  asarUnpack: [
    'node_modules/better-sqlite3/build/Release/*.node',
    'node_modules/@paymoapp/active-window/build/Release/*.node',
    'node_modules/keytar/build/Release/*.node',
    // DEV-180: SQLite dlopens the sqlite-vec extension from a real file path,
    // and onnxruntime-node loads its native binding the same way.
    'node_modules/sqlite-vec-*/**',
    'node_modules/onnxruntime-node/bin/**',
  ],
  publish: {
    provider: 'github',
    owner: 'irachrist1',
    repo: 'daylens',
  },
}
