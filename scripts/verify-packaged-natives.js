#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')

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

function verifyPackage(asarPath) {
  const resourcesDir = path.dirname(asarPath)
  const unpackedDir = path.join(resourcesDir, 'app.asar.unpacked')

  // All three native modules listed in asarUnpack must be present.
  // Missing any of them means the app will crash on launch.
  const requiredNativeBindings = [
    {
      name: 'better-sqlite3',
      binding: path.join('node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
    },
    {
      name: '@paymoapp/active-window',
      binding: path.join('node_modules', '@paymoapp', 'active-window', 'build', 'Release', 'PaymoActiveWindow.node'),
    },
    {
      name: 'keytar',
      binding: path.join('node_modules', 'keytar', 'build', 'Release', 'keytar.node'),
    },
  ]

  for (const { name, binding } of requiredNativeBindings) {
    const fullPath = path.join(unpackedDir, binding)
    if (!fs.existsSync(fullPath)) {
      fail(`${path.relative(process.cwd(), asarPath)} is missing unpacked ${name} native binding at ${fullPath}`)
    }
  }

  const requiredUnpackedEntries = [
    // better-sqlite3 and its transitive deps (loaded via `bindings` package)
    path.join('node_modules', 'better-sqlite3', 'package.json'),
    path.join('node_modules', 'better-sqlite3', 'lib', 'index.js'),
    path.join('node_modules', 'better-sqlite3', 'lib', 'database.js'),
    path.join('node_modules', 'bindings', 'package.json'),
    path.join('node_modules', 'bindings', 'bindings.js'),
    path.join('node_modules', 'file-uri-to-path', 'package.json'),
    path.join('node_modules', 'file-uri-to-path', 'index.js'),
    // @paymoapp/active-window (loads .node via direct relative require)
    path.join('node_modules', '@paymoapp', 'active-window', 'package.json'),
    path.join('node_modules', '@paymoapp', 'active-window', 'dist', 'index.js'),
    // keytar (loads .node via direct relative require)
    path.join('node_modules', 'keytar', 'package.json'),
    path.join('node_modules', 'keytar', 'lib', 'keytar.js'),
  ]

  for (const entry of requiredUnpackedEntries) {
    const fullPath = path.join(unpackedDir, entry)
    if (!fs.existsSync(fullPath)) {
      fail(`${path.relative(process.cwd(), asarPath)} is missing unpacked native dependency file ${fullPath}`)
    }
  }

  const appBundle = path.dirname(path.dirname(resourcesDir))
  if (path.extname(appBundle) === '.app') {
    const calendarHelper = path.join(
      resourcesDir,
      'build',
      'calendar-helper.app',
      'Contents',
      'MacOS',
      'calendar-helper',
    )
    try {
      fs.accessSync(calendarHelper, fs.constants.X_OK)
    } catch {
      fail(`${path.relative(process.cwd(), asarPath)} is missing executable Calendar helper at ${calendarHelper}`)
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
