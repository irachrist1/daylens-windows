#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')
const asar = require('@electron/asar')

const root = process.argv[2] || path.join(process.cwd(), 'dist-release')

function fail(message) {
  console.error(`[packaged-natives] ${message}`)
  process.exit(1)
}

function walk(dir, results = []) {
  if (!fs.existsSync(dir)) return results
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(fullPath, results)
    } else if (entry.isFile() && entry.name === 'app.asar') {
      results.push(fullPath)
    }
  }
  return results
}

function hasAsarEntry(entries, entry) {
  return entries.has(entry.replaceAll(path.sep, '/'))
}

function verifyPackage(asarPath) {
  const resourcesDir = path.dirname(asarPath)
  const unpackedDir = path.join(resourcesDir, 'app.asar.unpacked')
  const entries = new Set(asar.listPackage(asarPath))

  const requiredAsarEntries = [
    '/node_modules/better-sqlite3/package.json',
    '/node_modules/better-sqlite3/lib/index.js',
    '/node_modules/better-sqlite3/lib/database.js',
    '/node_modules/bindings/package.json',
    '/node_modules/bindings/bindings.js',
    '/node_modules/file-uri-to-path/package.json',
    '/node_modules/file-uri-to-path/index.js',
  ]

  for (const entry of requiredAsarEntries) {
    if (!hasAsarEntry(entries, entry)) {
      fail(`${path.relative(process.cwd(), asarPath)} is missing ${entry}`)
    }
  }

  const nativeBinding = path.join(
    unpackedDir,
    'node_modules',
    'better-sqlite3',
    'build',
    'Release',
    'better_sqlite3.node',
  )

  if (!fs.existsSync(nativeBinding)) {
    fail(`${path.relative(process.cwd(), asarPath)} is missing unpacked better-sqlite3 native binding at ${nativeBinding}`)
  }

  const requiredUnpackedEntries = [
    path.join('node_modules', 'better-sqlite3', 'package.json'),
    path.join('node_modules', 'better-sqlite3', 'lib', 'index.js'),
    path.join('node_modules', 'better-sqlite3', 'lib', 'database.js'),
    path.join('node_modules', 'bindings', 'package.json'),
    path.join('node_modules', 'bindings', 'bindings.js'),
    path.join('node_modules', 'file-uri-to-path', 'package.json'),
    path.join('node_modules', 'file-uri-to-path', 'index.js'),
  ]

  for (const entry of requiredUnpackedEntries) {
    const fullPath = path.join(unpackedDir, entry)
    if (!fs.existsSync(fullPath)) {
      fail(`${path.relative(process.cwd(), asarPath)} is missing unpacked native dependency file ${fullPath}`)
    }
  }

  console.log(`[packaged-natives] ok ${path.relative(process.cwd(), asarPath)}`)
}

const packages = walk(root)
if (packages.length === 0) {
  fail(`No app.asar files found under ${root}`)
}

for (const asarPath of packages) {
  verifyPackage(asarPath)
}
