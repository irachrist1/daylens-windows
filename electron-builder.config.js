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
  appId: 'com.daylens.windows',
  productName: 'DaylensWindows',
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
  win,
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
    installerIcon: 'build/icon.ico',
    uninstallerIcon: 'build/icon.ico',
    installerHeaderIcon: 'build/icon.ico',
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Daylens',
    runAfterFinish: true,
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
