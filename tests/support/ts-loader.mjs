import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function tryFile(basePath) {
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.js`,
    path.join(basePath, 'index.ts'),
    path.join(basePath, 'index.js'),
  ]
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null
}

export async function resolve(specifier, context, defaultResolve) {
  if (
    specifier === '../../services/database'
    || specifier === '../services/database'
    || specifier === './database'
    || specifier.endsWith('/services/database')
  ) {
    return {
      url: pathToFileURL(path.resolve(projectRoot, 'tests/support/database-stub.mjs')).href,
      shortCircuit: true,
    }
  }

  if (
    specifier === '../../services/settings'
    || specifier === '../services/settings'
    || specifier === './settings'
    || specifier.endsWith('/services/settings')
  ) {
    return {
      url: pathToFileURL(path.resolve(projectRoot, 'tests/support/settings-stub.mjs')).href,
      shortCircuit: true,
    }
  }

  if (specifier === 'electron') {
    return {
      url: pathToFileURL(path.resolve(projectRoot, 'tests/support/electron-stub.mjs')).href,
      shortCircuit: true,
    }
  }

  if (specifier === 'electron-store') {
    return {
      url: pathToFileURL(path.resolve(projectRoot, 'tests/support/electron-store-stub.mjs')).href,
      shortCircuit: true,
    }
  }

  if (specifier.startsWith('@shared/')) {
    const resolved = path.resolve(projectRoot, 'src/shared', specifier.slice('@shared/'.length))
    const withFile = tryFile(resolved)
    if (withFile) {
      return {
        url: pathToFileURL(withFile).href,
        shortCircuit: true,
      }
    }
  }

  if (specifier === '@daylens/remote-contract') {
    return {
      url: pathToFileURL(path.resolve(projectRoot, 'packages/remote-contract/index.ts')).href,
      shortCircuit: true,
    }
  }

  try {
    return await defaultResolve(specifier, context, defaultResolve)
  } catch (error) {
    const relative = specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/')
    if (!relative || path.extname(specifier)) {
      throw error
    }

    const parentPath = context.parentURL
      ? path.dirname(fileURLToPath(context.parentURL))
      : projectRoot
    const candidatePath = specifier.startsWith('/')
      ? specifier
      : path.resolve(parentPath, specifier)
    const withFile = tryFile(candidatePath)
    if (!withFile) throw error

    return {
      url: pathToFileURL(withFile).href,
      shortCircuit: true,
    }
  }
}

export async function load(url, context, defaultLoad) {
  if (!url.startsWith('file:')) {
    return defaultLoad(url, context, defaultLoad)
  }

  const filePath = fileURLToPath(url)

  if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) {
    const source = fs.readFileSync(filePath, 'utf8')
    const withDirnameShim = [
      "import { fileURLToPath as __codexFileURLToPath } from 'node:url';",
      "import { dirname as __codexDirname } from 'node:path';",
      'const __filename = __codexFileURLToPath(import.meta.url);',
      'const __dirname = __codexDirname(__filename);',
      source,
    ].join('\n')
    return {
      format: 'module',
      source: ts.transpileModule(withDirnameShim, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
          jsx: ts.JsxEmit.ReactJSX,
        },
        fileName: filePath,
      }).outputText,
      shortCircuit: true,
    }
  }

  return defaultLoad(url, context, defaultLoad)
}
