// The Daylens headless CLI: every product surface, driven from the terminal,
// through the same code paths the renderer uses over IPC.
//
//   daylens db snapshot | reset | info      manage the isolated DB copy
//   daylens timeline <date> [--evidence]    day view (blocks, labels, gaps)
//   daylens timeline <date> --week          week summary ending on date
//   daylens timeline <YYYY-MM> --month      month grid
//   daylens apps <date> [appId]             apps view / app detail
//   daylens apps <date> --ids               list canonical app ids
//   daylens wrapped <date> [--regen|--facts]  wrapped narrative (spends a
//                                           model call when none is stored,
//                                           exactly like the app; --regen forces)
//   daylens chat "question" [--thread N]    real agent turn, streamed
//   daylens analyze <date> [--hint "…"]     the Analyze-day pipeline (AI)
//
// Global flags: --json (machine output) · --fresh (reset work DB first)
// · --db <path> (explicit DB file, e.g. a fixture) · --out <file> (tee JSON)
//
// Runs under: ELECTRON_RUN_AS_NODE=1 electron --loader ts-loader-real.mjs
// (see the `daylens` shim at the repo root and `npm run cli`).

import fs from 'node:fs'
import path from 'node:path'
import { openHarness, createSnapshot, resetWorkFromPristine, readSnapshotMeta, snapshotAgeDescription, HARNESS_ROOT } from './context'
import { c, fail, isValidDate, ymd } from './render'

interface ParsedArgs {
  command: string
  positional: string[]
  flags: Map<string, string | boolean>
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv
  const positional: string[] = []
  const flags = new Map<string, string | boolean>()
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = rest[i + 1]
      if (next !== undefined && !next.startsWith('--') && ['db', 'out', 'hint', 'thread'].includes(key)) {
        flags.set(key, next)
        i += 1
      } else {
        flags.set(key, true)
      }
    } else {
      positional.push(arg)
    }
  }
  return { command, positional, flags }
}

function printHelp(): void {
  const source = fs.readFileSync(new URL(import.meta.url).pathname, 'utf8')
  const header = source.split('\n').slice(0, 19).map((line) => line.replace(/^\/\/ ?/, '')).join('\n')
  console.log(header)
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2))
  const { command, positional, flags } = parsed
  const json = flags.get('json') === true
  const outFile = typeof flags.get('out') === 'string' ? String(flags.get('out')) : null

  if (outFile) {
    // Tee stdout into the export file so any command output can be inspected
    // or attached later, without a separate export subcommand per surface.
    // Buffered in memory and flushed synchronously at exit — a write stream
    // would race process.exit and truncate the tail.
    const chunks: Array<string | Uint8Array> = []
    const target = path.resolve(outFile)
    const write = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
      chunks.push(chunk)
      return write(chunk, ...(args as []))
    }) as typeof process.stdout.write
    process.on('exit', () => {
      fs.writeFileSync(target, chunks.map((c) => (typeof c === 'string' ? c : Buffer.from(c).toString())).join(''))
    })
  }

  if (command === 'help' || command === '--help' || flags.get('help') === true) {
    printHelp()
    return
  }

  if (command === 'db') {
    const sub = positional[0] ?? 'info'
    if (sub === 'snapshot') {
      const meta = await createSnapshot()
      console.log(c('green', `Snapshot created from ${meta.sourceDbPath}`))
      console.log(c('dim', `pristine + work staged under ${HARNESS_ROOT}`))
      return
    }
    if (sub === 'reset') {
      resetWorkFromPristine()
      console.log(c('green', 'Work DB reset from pristine snapshot.'))
      return
    }
    if (sub === 'info') {
      const meta = readSnapshotMeta()
      if (!meta) {
        console.log('No snapshot yet. Run: daylens db snapshot')
        return
      }
      console.log(`source:   ${meta.sourceDbPath}`)
      console.log(`taken:    ${meta.snapshotAt} (${snapshotAgeDescription(meta)})`)
      console.log(`root:     ${HARNESS_ROOT}`)
      return
    }
    fail(`unknown db subcommand: ${sub}`)
  }

  const ctx = await openHarness({
    fresh: flags.get('fresh') === true,
    dbPath: typeof flags.get('db') === 'string' ? String(flags.get('db')) : undefined,
  })
  process.stderr.write(c('dim', `[harness] ${ctx.dbPath} · ${snapshotAgeDescription(ctx.snapshotMeta)}\n`))

  switch (command) {
    case 'timeline': {
      const target = positional[0] ?? ymd(new Date())
      if (flags.get('month') === true) {
        if (!/^\d{4}-\d{2}$/.test(target)) fail(`--month needs YYYY-MM, got: ${target}`)
        const { timelineMonth } = await import('./cmdTimeline')
        await timelineMonth(ctx, target, { json })
      } else if (flags.get('week') === true) {
        if (!isValidDate(target)) fail(`--week needs YYYY-MM-DD, got: ${target}`)
        const { timelineWeek } = await import('./cmdTimeline')
        await timelineWeek(ctx, target, { json })
      } else {
        if (!isValidDate(target)) fail(`bad date: ${target} (YYYY-MM-DD)`)
        const { timelineDay } = await import('./cmdTimeline')
        await timelineDay(ctx, target, { json, evidence: flags.get('evidence') === true })
      }
      break
    }
    case 'apps': {
      const date = positional[0] ?? ymd(new Date())
      if (!isValidDate(date)) fail(`bad date: ${date} (YYYY-MM-DD)`)
      const appId = positional[1]
      const { appsForDate, appDetail, appsList } = await import('./cmdApps')
      if (flags.get('ids') === true) await appsList(ctx, date, { json })
      else if (appId) await appDetail(ctx, appId, date, { json })
      else await appsForDate(ctx, date, { json })
      break
    }
    case 'wrapped': {
      const date = positional[0] ?? ymd(new Date())
      if (!isValidDate(date)) fail(`bad date: ${date} (YYYY-MM-DD)`)
      const { wrapped } = await import('./cmdWrapped')
      await wrapped(ctx, date, {
        json,
        regen: flags.get('regen') === true,
        facts: flags.get('facts') === true,
      })
      break
    }
    case 'chat': {
      const question = positional.join(' ').trim()
      if (!question) fail('usage: daylens chat "your question"')
      const threadFlag = flags.get('thread')
      const { chat } = await import('./cmdChat')
      await chat(ctx, question, {
        json,
        stream: flags.get('no-stream') !== true,
        threadId: typeof threadFlag === 'string' ? Number(threadFlag) : null,
      })
      break
    }
    case 'analyze': {
      const date = positional[0]
      if (!date || !isValidDate(date)) fail('usage: daylens analyze YYYY-MM-DD')
      const { analyze } = await import('./cmdAnalyze')
      await analyze(ctx, date, {
        json,
        hint: typeof flags.get('hint') === 'string' ? String(flags.get('hint')) : undefined,
      })
      break
    }
    default:
      printHelp()
      fail(`unknown command: ${command}`)
  }
}

async function shutdown(code: number): Promise<never> {
  // Close the DB before exiting: keytar/better-sqlite3 worker threads abort
  // (SIGABRT, "mutex lock failed") when process.exit tears them down mid-op.
  try {
    const { getDb } = await import('../src/main/services/database')
    getDb()?.close()
  } catch {
    // DB may never have been opened (db snapshot/info paths) — fine.
  }
  await new Promise((resolve) => setTimeout(resolve, 25))
  process.exit(code)
}

main()
  .then(() => shutdown(process.exitCode ?? 0))
  .catch(async (error) => {
    console.error(c('red', String(error?.stack ?? error)))
    await shutdown(1)
  })
