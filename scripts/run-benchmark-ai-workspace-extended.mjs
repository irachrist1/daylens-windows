import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const tmpDir = path.join(rootDir, '.tmp-benchmark')
const sharedTypesSource = path.join(tmpDir, 'src', 'shared', 'types.js')
const sharedTypesTargetDir = path.join(tmpDir, 'node_modules', '@shared')
const sharedTypesTarget = path.join(sharedTypesTargetDir, 'types.js')
const entry = path.join(tmpDir, 'scripts', 'benchmark-ai-workspace-extended.js')

await fs.mkdir(sharedTypesTargetDir, { recursive: true })
await fs.copyFile(sharedTypesSource, sharedTypesTarget)
await import(pathToFileURL(entry).href)
