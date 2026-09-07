// Nothing that cannot run before the window is on screen may load before it.
//
// The main process is one CJS bundle, so every eager module load in its graph
// is evaluated before app.whenReady() resolves. Measured on a release build,
// the provider SDKs and the spreadsheet writer cost ~330ms of require between
// the user clicking the icon and Electron being ready — for a launch that may
// never ask a question or export anything.
//
// These modules are now loaded on first use. Putting one back on the launch
// path has no symptom other than a slower cold open, which is exactly the kind
// of regression nobody notices until it has shipped for a month — so the check
// below reads the syntax tree rather than grepping, and knows every form that
// loads a module eagerly, not just `import … from`.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '..', 'src')

// Costed on a release build with `require` timing, worst first.
const DEFERRED_UNTIL_FIRST_USE = [
  'exceljs',
  'openai',
  '@google/genai',
  '@anthropic-ai/sdk',
  '@ai-sdk/anthropic',
  '@ai-sdk/openai',
  '@ai-sdk/google',
  '@ai-sdk/openai-compatible',
]

/** The names a module can be pulled in under. `require` is the CJS bundle's
 *  own; `nodeRequire` is what the lazy accessors bind createRequire to. */
const REQUIRE_NAMES = new Set(['require', 'nodeRequire'])

function watched(specifier: string): string | null {
  return DEFERRED_UNTIL_FIRST_USE.find((name) => (
    specifier === name || specifier.startsWith(`${name}/`)
  )) ?? null
}

function isInsideFunction(node: ts.Node): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (
      ts.isFunctionDeclaration(parent)
      || ts.isFunctionExpression(parent)
      || ts.isArrowFunction(parent)
      || ts.isMethodDeclaration(parent)
      || ts.isConstructorDeclaration(parent)
      || ts.isGetAccessor(parent)
      || ts.isSetAccessor(parent)
    ) return true
  }
  return false
}

/** Every way a source file can load one of the watched modules AT LOAD TIME.
 *  A require inside a function body is the whole point of the change and is
 *  deliberately not reported. */
export function eagerLoadsIn(source: string, fileName = 'file.ts'): string[] {
  const tree = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)
  const found: string[] = []

  const visit = (node: ts.Node): void => {
    // import X from 'm' / import { a } from 'm' / import 'm'
    // `import type` is erased and costs nothing.
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const name = watched(node.moduleSpecifier.text)
      if (name && !node.importClause?.isTypeOnly) found.push(`import '${name}'`)
    }
    // import X = require('m')
    if (
      ts.isImportEqualsDeclaration(node)
      && !node.isTypeOnly
      && ts.isExternalModuleReference(node.moduleReference)
      && ts.isStringLiteral(node.moduleReference.expression)
    ) {
      const name = watched(node.moduleReference.expression.text)
      if (name) found.push(`import = require('${name}')`)
    }
    // require('m') / nodeRequire('m') outside any function body
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && REQUIRE_NAMES.has(node.expression.text)
      && node.arguments.length > 0
      && ts.isStringLiteral(node.arguments[0])
    ) {
      const name = watched(node.arguments[0].text)
      if (name && !isInsideFunction(node)) found.push(`top-level ${node.expression.text}('${name}')`)
    }
    // await import('m') at the top level of a module loads it just as eagerly.
    if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length > 0
      && ts.isStringLiteral(node.arguments[0])
    ) {
      const name = watched(node.arguments[0].text)
      if (name && !isInsideFunction(node)) found.push(`top-level import('${name}')`)
    }
    ts.forEachChild(node, visit)
  }

  visit(tree)
  return found
}

function mainProcessSources(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.ts')) out.push(full)
    }
  }
  // The renderer is a separate process with its own bundle; only the main
  // process pays for these at launch.
  walk(path.join(SRC, 'main'))
  walk(path.join(SRC, 'shared'))
  return out
}

test('the heavy provider and export modules stay off the launch path', () => {
  const offenders: string[] = []
  for (const file of mainProcessSources()) {
    for (const form of eagerLoadsIn(fs.readFileSync(file, 'utf8'), file)) {
      offenders.push(`${path.relative(SRC, file)}: ${form}`)
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'These modules load on first use so they do not run before the window is shown. '
    + "Call them through the file's lazy accessor, or use `import type` if only the types are needed.\n"
    + offenders.join('\n'),
  )
})

test('the scan recognizes every form that loads a module eagerly', () => {
  const eager: Array<[string, string]> = [
    ['default import', "import ExcelJS from 'exceljs'"],
    ['named import', "import { createOpenAI } from '@ai-sdk/openai'"],
    ['side-effect import', "import 'exceljs'"],
    ['subpath import', "import x from '@ai-sdk/openai/internal'\nvoid x"],
    ['import equals', "import OpenAI = require('openai')"],
    ['top-level require', "const ExcelJS = require('exceljs')"],
    ['top-level nodeRequire', "const ExcelJS = nodeRequire('exceljs')"],
    ['top-level dynamic import', "const ExcelJS = await import('exceljs')"],
    ['require inside a top-level block', "if (process.platform === 'darwin') { require('openai') }"],
  ]
  for (const [label, source] of eager) {
    assert.equal(eagerLoadsIn(source).length > 0, true, `${label} must be reported: ${source}`)
  }

  const lazy: Array<[string, string]> = [
    ['type-only import', "import type ExcelJS from 'exceljs'"],
    ['type-only named import', "import type { Content } from '@google/genai'"],
    ['require inside a function', "function load() { return require('exceljs') }"],
    ['nodeRequire inside an arrow', "const load = () => nodeRequire('@ai-sdk/google')"],
    ['dynamic import inside a function', "async function load() { return await import('openai') }"],
    ['an unwatched module', "import { z } from 'zod'"],
  ]
  for (const [label, source] of lazy) {
    assert.deepEqual(eagerLoadsIn(source), [], `${label} must not be reported: ${source}`)
  }
})

test('a lazy accessor still resolves each deferred module', async () => {
  const { createRequire } = await import('node:module')
  const require = createRequire(path.join(SRC, 'main', 'index.ts'))
  for (const moduleName of DEFERRED_UNTIL_FIRST_USE) {
    assert.doesNotThrow(
      () => require.resolve(moduleName),
      `${moduleName} must still resolve from the main process — deferring it must not drop the dependency`,
    )
  }
})
