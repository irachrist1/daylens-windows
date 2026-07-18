import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const WORKFLOWS = [
  '.github/workflows/verify-linux-runtime.yml',
  '.github/workflows/release-linux.yml',
]
const RUN_SCRIPT = fs.readFileSync(
  path.resolve(process.cwd(), 'scripts/run-linux-capture-smoke.sh'),
  'utf8',
)

test('linux smoke workflows launch Electron inside a DBus session', () => {
  for (const workflowPath of WORKFLOWS) {
    const source = fs.readFileSync(path.resolve(process.cwd(), workflowPath), 'utf8')
    assert.match(
      source,
      /timeout 110s dbus-run-session -- xvfb-run -a env[\s\S]*?DAYLENS_SMOKE_REPORT_PATH="\$RUNNER_TEMP\/daylens-appimage-smoke\.json"[\s\S]*?scripts\/run-linux-capture-smoke\.sh/,
      `${workflowPath} should run AppImage smoke under dbus-run-session`,
    )
    assert.match(
      source,
      /timeout 110s dbus-run-session -- xvfb-run -a env[\s\S]*?DAYLENS_SMOKE_REPORT_PATH="\$RUNNER_TEMP\/daylens-deb-smoke\.json"[\s\S]*?scripts\/run-linux-capture-smoke\.sh/,
      `${workflowPath} should run deb smoke under dbus-run-session`,
    )
    assert.match(
      source,
      /if \[ -f "\$candidate" \] && \[ -x "\$candidate" \] && \[ "\$\(basename "\$candidate"\)" = "daylens" \]/,
      `${workflowPath} should resolve package smoke APP_PATH to an executable daylens file`,
    )
    assert.match(
      source,
      /DAYLENS_SMOKE_REPORT_PATH=\/smoke\/daylens-rpm-smoke\.json[\s\S]*?timeout 110s dbus-run-session -- scripts\/run-linux-capture-smoke\.sh "\$APP_PATH"/,
      `${workflowPath} should run rpm smoke under dbus-run-session`,
    )
    assert.match(source, /DAYLENS_SMOKE_EXPECT_FOREGROUND_TITLE="Runtime Capture Foreground"/)
    assert.match(source, /DAYLENS_SMOKE_EXPECT_FULLSCREEN_TITLE="Runtime Capture Fullscreen"/)
    assert.match(source, /--window-state/)
    assert.match(source, /apt-get install -y[^\n]*\bwmctrl\b/)
    assert.match(source, /dnf install -y[^\n]*\bwmctrl\b/)
    assert.doesNotMatch(source, /xorg-x11-apps/)
    assert.match(source, /dnf install[^\n]*\bxmessage\b[^\n]*\bxwininfo\b/)
    assert.match(RUN_SCRIPT, /wmctrl -m[\s\S]*?"\$app_path" "\$@"/)
    assert.match(RUN_SCRIPT, /kill -0 "\$app_pid"/)
    assert.match(RUN_SCRIPT, /xwininfo -root -tree/)
  }
})
