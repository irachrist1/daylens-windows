// Nothing that cannot run before the window is on screen may load before it.
//
// The main process is one CJS bundle, so every static import in its graph is
// evaluated before app.whenReady() resolves. Measured on a release build, the
// provider SDKs and the spreadsheet writer cost ~330ms of require between the
// user clicking the icon and Electron being ready — for a launch that may
// never ask a question or export anything.
//
// These modules are now loaded on first use. A future static `import` would
// silently put them back on the launch path with no other symptom than a
// slower cold open, which is exactly the kind of regression nobody notices
// until it has been shipped for a month.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '..', 'src')

// Costed on a release build with `require` timing, worst-first.
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

/** Every import statement in a file, as (specifier, typeOnly) pairs. Matching
 *  one statement at a time matters: a pattern that scans for a module name
 *  across the whole file happily spans two adjacent imports and reports the
 *  second one's specifier against the first one's `import` keyword. */
function importsOf(source: string): Array<{ specifier: string; typeOnly: boolean }> {
  const statement = /^import\s+(type\s+)?[\s\S]*?from\s*['"]([^'"]+)['"]/gm
  const found: Array<{ specifier: string; typeOnly: boolean }> = []
  for (const match of source.matchAll(statement)) {
    found.push({ specifier: match[2], typeOnly: Boolean(match[1]) })
  }
  return found
}

function importsAsValue(source: string, moduleName: string): boolean {
  return importsOf(source).some((entry) => (
    !entry.typeOnly
    && (entry.specifier === moduleName || entry.specifier.startsWith(`${moduleName}/`))
  ))
}

test('the heavy provider and export modules stay off the launch path', () => {
  const offenders: string[] = []
  for (const file of mainProcessSources()) {
    const source = fs.readFileSync(file, 'utf8')
    for (const moduleName of DEFERRED_UNTIL_FIRST_USE) {
      if (importsAsValue(source, moduleName)) {
        offenders.push(`${path.relative(SRC, file)} statically imports ${moduleName}`)
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'These modules are loaded on first use so they do not run before the window is shown. '
    + 'Use the module\'s lazy accessor, or `import type` if only the types are needed.\n'
    + offenders.join('\n'),
  )
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
