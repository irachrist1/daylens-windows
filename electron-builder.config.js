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

const mac = {
  target: ['zip', 'dmg'],
  icon: 'build/icon.icns',
  category: 'public.app-category.productivity',
  artifactName: 'Daylens-${version}-${arch}.${ext}',
}

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
  ],
  mac,
  win,
  linux,
  deb: {
    depends: ['libgtk-3-0', 'libnotify4', 'libnss3', 'libxss1', 'libxtst6', 'xdg-utils', 'libatspi2.0-0', 'libuuid1', 'libsecret-1-0'],
  },
  rpm: {
    depends: ['gtk3', 'libnotify', 'nss', 'libXScrnSaver', '(libXtst or libXtst6)', 'xdg-utils', 'at-spi2-core', '(libuuid or libuuid1)', 'libsecret'],
  },
  nsis: {
    oneClick: true,
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
      height: 420,
    },
    contents: [
      { x: 180, y: 225, type: 'file' },
      { x: 480, y: 225, type: 'link', path: '/Applications' },
    ],
  },
  asar: true,
  asarUnpack: [
    'node_modules/better-sqlite3/**',
    'node_modules/@paymoapp/active-window/**',
    'node_modules/keytar/**',
  ],
  publish: {
    provider: 'github',
    owner: 'irachrist1',
    repo: 'daylens-windows',
  },
}
