import test from 'node:test'
import assert from 'node:assert/strict'
import { isAllowedExternalUrl } from '../src/main/lib/externalUrlPolicy.ts'

test('https links are allowed', () => {
  assert.equal(isAllowedExternalUrl('https://openrouter.ai/models'), true)
})

test('the macOS System Settings privacy panes are allowed', () => {
  assert.equal(isAllowedExternalUrl('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'), true)
  assert.equal(isAllowedExternalUrl('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'), true)
  assert.equal(isAllowedExternalUrl('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'), true)
})

test('other schemes are rejected', () => {
  assert.equal(isAllowedExternalUrl('http://example.com'), false)
  assert.equal(isAllowedExternalUrl('file:///etc/passwd'), false)
  assert.equal(isAllowedExternalUrl('javascript:alert(1)'), false)
  assert.equal(isAllowedExternalUrl('x-apple-other:thing'), false)
})

test('malformed input is rejected, not thrown', () => {
  assert.equal(isAllowedExternalUrl('not a url'), false)
  assert.equal(isAllowedExternalUrl(''), false)
})
