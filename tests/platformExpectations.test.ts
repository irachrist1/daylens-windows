import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getInstallUpdateExpectation,
  getLaunchOnLoginDescription,
  getQuickAccessExpectation,
  getWorkspaceDeviceLabel,
} from '../src/shared/platformExpectations.ts'

test('workspace device labels stay platform-neutral when hostname is unavailable', () => {
  assert.equal(getWorkspaceDeviceLabel(''), 'This device')
  assert.equal(getWorkspaceDeviceLabel('  '), 'This device')
  assert.equal(getWorkspaceDeviceLabel('Tonny-Laptop'), 'Tonny-Laptop')
})

test('linux quick-access copy stays truthful about tray limitations', () => {
  const copy = getQuickAccessExpectation('linux')
  assert.match(copy.body, /AppIndicator/i)
  assert.match(copy.body, /app launcher/i)
})

test('windows install copy calls out setup.exe and SmartScreen truthfully', () => {
  const copy = getInstallUpdateExpectation('win32')
  assert.match(copy.body, /Setup \.exe/i)
  assert.match(copy.body, /SmartScreen/i)
})

test('linux launch-on-login copy explains the autostart entry behavior', () => {
  const description = getLaunchOnLoginDescription('linux')
  assert.match(description, /autostart entry/i)
})
