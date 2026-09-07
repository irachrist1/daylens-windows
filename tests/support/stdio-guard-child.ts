// Fixture for consoleStdio.test.ts. The parent spawns this with piped stdio and
// then closes its read ends, so every later write here fails with EPIPE — the
// same class of failure a closed terminal produces with EIO, and reachable
// without a pty.
//
// It reports through a file because the streams under test are the broken ones.
import fs from 'node:fs'
import { installConsoleStdioGuards } from '../../src/shared/consoleStdio'

const mode = process.argv[2]
const reportPath = process.argv[3]

if (mode === 'guarded') installConsoleStdioGuards()

process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  fs.appendFileSync(reportPath, `uncaught ${err.syscall} ${err.code}\n`)
  process.exit(1)
})

setInterval(() => {
  console.log('tick')
  console.error('tick')
}, 25)

fs.appendFileSync(reportPath, 'ready\n')
setTimeout(() => {
  fs.appendFileSync(reportPath, 'survived\n')
  process.exit(0)
}, 800)
