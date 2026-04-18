#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')

function usage() {
  console.error('Usage: node scripts/verify-linux-smoke.js --report <path> --expect-package-type <appimage|deb|rpm|pacman|unknown> [--expect-package-source <source>] [--expect-updater-supported <true|false>] [--require-package-owner]')
  process.exit(1)
}

function readArg(flag) {
  const index = process.argv.indexOf(flag)
  if (index === -1) return null
  return process.argv[index + 1] ?? null
}

function hasFlag(flag) {
  return process.argv.includes(flag)
}

function fail(message) {
  console.error(`Smoke verification failed: ${message}`)
  process.exit(1)
}

const reportPathArg = readArg('--report')
const expectedPackageType = readArg('--expect-package-type')
const expectedPackageSource = readArg('--expect-package-source')
const expectedUpdaterSupportedArg = readArg('--expect-updater-supported')
const requirePackageOwner = hasFlag('--require-package-owner')

if (!reportPathArg || !expectedPackageType) usage()

const reportPath = path.resolve(reportPathArg)
if (!fs.existsSync(reportPath)) {
  fail(`Report file does not exist: ${reportPath}`)
}

const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))

if (report.ok !== true) {
  fail(`App reported failure at stage "${report.stage ?? 'unknown'}": ${report.error ?? 'unknown error'}`)
}

if (report.platform !== 'linux') {
  fail(`Expected linux platform, got: ${report.platform}`)
}

if (report.isPackaged !== true) {
  fail('Expected a packaged app runtime.')
}

if (!report.trackingStatus || typeof report.trackingStatus !== 'object') {
  fail('Tracking status was missing from the smoke report.')
}

if (!report.linuxDesktop || typeof report.linuxDesktop !== 'object') {
  fail('Linux desktop diagnostics were missing from the smoke report.')
}

if (!report.browserStatus || typeof report.browserStatus !== 'object') {
  fail('Browser diagnostics were missing from the smoke report.')
}

if (!Array.isArray(report.browserStatus.discoveredBrowsers)) {
  fail('Browser discovery diagnostics were malformed.')
}

if (!report.updater || typeof report.updater !== 'object') {
  fail('Updater diagnostics were missing from the smoke report.')
}

if (report.linuxDesktop.packageType !== expectedPackageType) {
  fail(`Expected linuxDesktop.packageType=${expectedPackageType}, got ${report.linuxDesktop.packageType}`)
}

if (report.updater.packageType !== expectedPackageType) {
  fail(`Expected updater.packageType=${expectedPackageType}, got ${report.updater.packageType}`)
}

if (expectedPackageSource && report.linuxDesktop.packageDetectionSource !== expectedPackageSource) {
  fail(`Expected packageDetectionSource=${expectedPackageSource}, got ${report.linuxDesktop.packageDetectionSource}`)
}

if (expectedUpdaterSupportedArg) {
  const expectedUpdaterSupported = expectedUpdaterSupportedArg === 'true'
  if (report.updater.supported !== expectedUpdaterSupported) {
    fail(`Expected updater.supported=${expectedUpdaterSupported}, got ${report.updater.supported}`)
  }
}

if (requirePackageOwner && !report.linuxDesktop.packageOwner) {
  fail('Expected an owning package in the smoke report, but none was reported.')
}

if (!report.trackingStatus.moduleSource && !report.trackingStatus.loadError) {
  fail('Expected either a tracking backend source or a tracking load error.')
}

console.log('Smoke verification passed:')
console.log(JSON.stringify({
  packageType: report.linuxDesktop.packageType,
  packageDetectionSource: report.linuxDesktop.packageDetectionSource,
  packageOwner: report.linuxDesktop.packageOwner,
  updaterSupported: report.updater.supported,
  trackerBackend: report.trackingStatus.moduleSource,
  trayAvailable: report.tray?.available ?? null,
}, null, 2))
