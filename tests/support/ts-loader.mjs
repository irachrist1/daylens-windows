import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// vite injects these as compile-time `define` globals (see vite.main.config.ts).
// Provide the same defaults as module-scoped consts so a transpiled module that
// reads one does not throw ReferenceError. Injected only into modules that
// reference a define.
const BUILD_DEFINES = {
  __DAYLENS_CONVEX_SITE_URL__: process.env.DAYLENS_CONVEX_SITE_URL || 'https://decisive-aardvark-847.convex.site',
  __POSTHOG_KEY__: process.env.POSTHOG_KEY || '',
  __POSTHOG_HOST__: process.env.POSTHOG_HOST || '',
  __DAYLENS_BILLING_API_URL__: process.env.DAYLENS_BILLING_API_URL || '',
  __DAYLENS_ENTITLEMENT_PUBLIC_KEYS__: process.env.DAYLENS_ENTITLEMENT_PUBLIC_KEYS || '{}',
}

function buildDefineShim(source) {
  // Emit each define as a const that prefers a globalThis override when present,
  // falling back to the build default. Tests that need a non-empty value (e.g.
  // analytics.service.test.ts setting __POSTHOG_KEY__) assign globalThis.<name>
  // before importing the module under test; without this a hardcoded const would
  // shadow that global and the value would always be the empty-string default.
  return Object.entries(BUILD_DEFINES)
    .filter(([name]) => source.includes(name))
    .map(([name, value]) => `const ${name} = globalThis.${name} !== undefined ? globalThis.${name} : ${JSON.stringify(value)};`)
}

function tryFile(basePath) {
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.js`,
    path.join(basePath, 'index.ts'),
    path.join(basePath, 'index.tsx'),
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

  if (specifier === 'electron' && !process.env.DAYLENS_REAL_ELECTRON) {
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

  if (specifier === 'electron-updater') {
    return {
      url: pathToFileURL(path.resolve(projectRoot, 'tests/support/electron-updater-stub.mjs')).href,
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

  if (specifier.startsWith('@/')) {
    const resolved = path.resolve(projectRoot, 'apps/web', specifier.slice(2))
    const withFile = tryFile(resolved)
    if (withFile) {
      return {
        url: pathToFileURL(withFile).href,
        shortCircuit: true,
      }
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
      ...buildDefineShim(source),
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
