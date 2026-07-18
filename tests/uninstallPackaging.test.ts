// Static checks that the per-platform uninstall hooks stay wired: the NSIS
// customUnInstall include and the Linux maintainer script's autostart cleanup.
// These files only run inside installers, so regressions here are invisible to
// every runtime test.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const NSIS_INCLUDE = path.join(ROOT, 'build/win/uninstall.nsh')

test('electron-builder wires the NSIS uninstall include', () => {
  const config = fs.readFileSync(path.join(ROOT, 'electron-builder.config.js'), 'utf8')
  assert.match(config, /include: 'build\/win\/uninstall\.nsh'/)
  assert.ok(fs.existsSync(NSIS_INCLUDE))
})

test('NSIS uninstall hook removes every login-item registry value on real uninstalls', () => {
  const source = fs.readFileSync(NSIS_INCLUDE, 'utf8')
  assert.match(source, /!macro customUnInstall/)
  // Guarded so auto-updates (which run the uninstaller too) never touch the login item.
  assert.match(source, /\$\{ifNot\} \$\{isUpdated\}/)
  for (const hive of [
    'Software\\Microsoft\\Windows\\CurrentVersion\\Run',
    'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run',
  ]) {
    for (const valueName of ['com.daylens.desktop', 'dev.christiantonny.daylens', 'Daylens']) {
      assert.ok(
        source.includes(`DeleteRegValue HKCU "${hive}" "${valueName}"`),
        `expected DeleteRegValue for ${hive} \\ ${valueName}`,
      )
    }
  }
})

test('NSIS uninstall hook only deletes data on an explicit choice, never silently', () => {
  const source = fs.readFileSync(NSIS_INCLUDE, 'utf8')
  // Interactive uninstalls must ASK; the /SD default keeps data.
  assert.match(source, /MessageBox MB_YESNO[^\n]*\/SD IDNO/)
  assert.match(source, /\$\{GetOptions\} \$R0 "\/S" \$R1/)
  assert.match(source, /SetSilent normal/)
  // The in-app flow's --delete-app-data path must remove every data
  // directory — current, package-name cache, and legacy — itself, not rely
  // on the built-in block staying in place.
  assert.match(source, /\$\{GetOptions\} \$R0 "--delete-app-data" \$R1/)
  const deleteBranch = source.split('${GetOptions} $R0 "--delete-app-data" $R1')[1]?.split('${else}')[0] ?? ''
  for (const dir of ['Daylens', 'daylens', 'DaylensWindows']) {
    assert.ok(deleteBranch.includes(`RMDir /r "$APPDATA\\${dir}"`), `expected --delete-app-data branch to remove $APPDATA\\${dir}`)
  }
})

test('linux after-remove drops per-user autostart entries but never user data', () => {
  const source = fs.readFileSync(path.join(ROOT, 'build/linux/after-remove.sh'), 'utf8')
  const desktopSource = fs.readFileSync(path.join(ROOT, 'src/main/services/linuxDesktop.ts'), 'utf8')
  // Custom XDG paths are read from the exact marker written by the app.
  assert.match(source, /getent passwd \| cut -d: -f6/)
  assert.ok(
    source.includes('rm -f "$home/.config/autostart/daylens.desktop"'),
    'after-remove must delete the XDG autostart entry per user home',
  )
  // $VAR form, not ${VAR}: electron-builder treats ${VAR} in maintainer
  // scripts as an fpm macro (see linuxPackageScripts.test.ts).
  assert.ok(source.includes('"$XDG_CONFIG_HOME/autostart/daylens.desktop"'))
  assert.ok(source.includes('marker="$home/.daylens-autostart-path"'))
  assert.ok(desktopSource.includes("const AUTOSTART_MARKER_FILE = '.daylens-autostart-path'"))
  assert.ok(desktopSource.includes('fs.writeFileSync(markerPath, `${autostartPath}\\n`, { mode: 0o600 })'))
  assert.match(source, /\*\/autostart\/daylens\.desktop\)/)
  assert.ok(source.includes("grep -q '^Name=Daylens$' \"$autostart\""))
  assert.ok(source.includes("grep -q '^StartupWMClass=daylens$' \"$autostart\""))
  assert.ok(!source.includes('find '), 'after-remove must not sweep account homes')
  assert.ok(!/\.config\/Daylens/.test(source), 'after-remove must not delete user data directories')
})
