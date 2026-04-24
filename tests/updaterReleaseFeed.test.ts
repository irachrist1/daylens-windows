import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildRemoteUpdateFeedUrl,
  compareReleaseVersions,
  isRemoteUpdateDescriptor,
  normalizeRemoteUpdaterError,
} from '../src/shared/updaterReleaseFeed.ts'

test('compareReleaseVersions prefers newer stable releases', () => {
  assert.equal(compareReleaseVersions('1.0.31', '1.0.30') > 0, true)
  assert.equal(compareReleaseVersions('1.2.0', '1.10.0') < 0, true)
  assert.equal(compareReleaseVersions('1.0.30', '1.0.30'), 0)
})

test('compareReleaseVersions treats prereleases as older than stable', () => {
  assert.equal(compareReleaseVersions('1.0.31-beta.1', '1.0.31') < 0, true)
  assert.equal(compareReleaseVersions('1.0.31', '1.0.31-beta.1') > 0, true)
})

test('buildRemoteUpdateFeedUrl appends platform and arch', () => {
  const url = buildRemoteUpdateFeedUrl('https://example.com/api/update-feed', 'darwin', 'arm64')
  assert.equal(url, 'https://example.com/api/update-feed?platform=darwin&arch=arm64')
})

test('isRemoteUpdateDescriptor validates the expected payload shape', () => {
  assert.equal(isRemoteUpdateDescriptor({
    version: '1.0.31',
    releaseName: 'Daylens 1.0.31',
    releaseNotesText: 'Fix updater flow',
    releaseDate: '2026-04-23T00:00:00.000Z',
    installUrl: 'https://example.com/mac.zip',
    installFileName: 'Daylens-1.0.31-arm64.zip',
    manualUrl: 'https://example.com/mac.dmg',
    releasePageUrl: 'https://example.com/releases/v1.0.31',
  }), true)

  assert.equal(isRemoteUpdateDescriptor({
    version: '1.0.31',
    installUrl: 42,
  }), false)
})

test('normalizeRemoteUpdaterError collapses noisy upstream failures into concise UI copy', () => {
  assert.equal(
    normalizeRemoteUpdaterError('Update feed request failed (HTTP 404): {"message":"Not Found"}'),
    'Daylens could not find a public update feed for this build.',
  )
  assert.equal(
    normalizeRemoteUpdaterError('Due to security reasons, actual status may not be reported, but 404. authentication token is missing.'),
    'Daylens could not reach the update service right now. The release feed rejected the request.',
  )
  assert.equal(
    normalizeRemoteUpdaterError('404 "method: GET url: https://github.com/irachrist1/daylens/releases.atom" Headers: {"cache-control":"no-cache","set-cookie":["private"]}'),
    'Daylens could not reach the old GitHub updater feed. Download the latest build from the Daylens site, then future updates will use the public Daylens update service.',
  )
  assert.equal(
    normalizeRemoteUpdaterError(`Unexpected updater failure ${'x'.repeat(500)}`).length <= 240,
    true,
  )
})
