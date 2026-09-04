// Variant of ts-loader.mjs that does NOT stub electron / settings / database.
// Use for end-to-end behavioural runs that need the real DB, keytar, and
// Electron app object.
//
// The shared ts-loader.mjs short-circuits those modules to in-memory stubs so
// unit tests stay hermetic. The behavioural harness is the explicit opposite:
// it wants real I/O. Everything else (path resolution, @shared/* aliasing,
// TS transpile) stays identical.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// vite injects these as compile-time `define` globals (see vite.main.config.ts).
// The loaders transpile without that step, so any module that reads one (e.g.
// workspaceLinker.ts) throws ReferenceError at import. Inject the same defaults
// as real module-scoped consts, but only into modules that actually reference
// one so we don't touch every file.
const BUILD_DEFINES = {
  __DAYLENS_CONVEX_SITE_URL__: process.env.DAYLENS_CONVEX_SITE_URL || 'https://decisive-aardvark-847.convex.site',
  __POSTHOG_KEY__: process.env.POSTHOG_KEY || '',
  __POSTHOG_HOST__: process.env.POSTHOG_HOST || '',
  __DAYLENS_BILLING_API_URL__: process.env.DAYLENS_BILLING_API_URL || '',
  __DAYLENS_ENTITLEMENT_PUBLIC_KEYS__: process.env.DAYLENS_ENTITLEMENT_PUBLIC_KEYS || '{}',
}

function buildDefineShim(source) {
  // Emit each define as a const that prefers a globalThis override when present,
  // falling back to the build default. Tests that need a non-empty value assign
  // globalThis.<name> before importing the module under test; without this a
  // hardcoded const would shadow that global.
  return Object.entries(BUILD_DEFINES)
    .filter(([name]) => source.includes(name))
    .map(([name, value]) => `const ${name} = globalThis.${name} !== undefined ? globalThis.${name} : ${JSON.stringify(value)};`)
}

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
  if (process.env.DAYLENS_LOADER_DEBUG === '1') {
    process.stderr.write(`[loader-real] resolve ${specifier} from ${context.parentURL ?? '(root)'}\n`)
  }
  if (specifier === 'electron') {
    return {
      url: pathToFileURL(path.resolve(projectRoot, 'tests/support/electron-real-stub.mjs')).href,
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
      "import { createRequire as __codexCreateRequire } from 'node:module';",
      'const __filename = __codexFileURLToPath(import.meta.url);',
      'const __dirname = __codexDirname(__filename);',
      'const require = __codexCreateRequire(import.meta.url);',
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
