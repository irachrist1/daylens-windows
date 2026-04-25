const fs = require('node:fs')
const path = require('node:path')

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

function requiredFilesFor(name) {
  if (name === 'better-sqlite3') {
    return [
      'package.json',
      path.join('lib', 'index.js'),
      path.join('lib', 'database.js'),
      path.join('build', 'Release', 'better_sqlite3.node'),
    ]
  }

  if (name === 'bindings') {
    return ['package.json', 'bindings.js']
  }

  if (name === 'file-uri-to-path') {
    return ['package.json', 'index.js']
  }

  return ['package.json']
}

function isDependencyComplete(target, name) {
  return requiredFilesFor(name).every((entry) => fs.existsSync(path.join(target, entry)))
}

function copyDependency(projectDir, resourcesDir, name) {
  const source = path.join(projectDir, 'node_modules', ...name.split('/'))
  const target = path.join(resourcesDir, 'app.asar.unpacked', 'node_modules', ...name.split('/'))

  if (!fs.existsSync(source)) {
    throw new Error(`Cannot repair unpacked native dependency; missing source ${source}`)
  }

  if (isDependencyComplete(target, name)) {
    return
  }

  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.cpSync(source, target, { recursive: true, force: true })
}

exports.default = async function afterPackNativeModules(context) {
  const asarPaths = walk(context.appOutDir)
  for (const asarPath of asarPaths) {
    const resourcesDir = path.dirname(asarPath)
    const unpackedSqlite = path.join(resourcesDir, 'app.asar.unpacked', 'node_modules', 'better-sqlite3')

    if (!fs.existsSync(unpackedSqlite)) continue

    copyDependency(context.packager.info.projectDir, resourcesDir, 'better-sqlite3')
    copyDependency(context.packager.info.projectDir, resourcesDir, 'bindings')
    copyDependency(context.packager.info.projectDir, resourcesDir, 'file-uri-to-path')
  }
}
