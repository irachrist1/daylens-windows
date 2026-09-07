// A closed terminal must not take the app down with it.
//
// Started from a terminal — `npm start`, or a packaged binary launched from a
// shell — the process writes its logs to that terminal's pty. Close the
// terminal window and the pty master is gone; every later write to the slave
// fails with EIO. A subprocess whose parent stopped reading its stdio pipe
// fails the same way with EPIPE.
//
// Node reports that failure by emitting 'error' on process.stdout /
// process.stderr on the NEXT TICK. console's own try/catch has returned by
// then and the temporary error listener it installs for the duration of the
// write has already been removed, so console's error-swallowing does not cover
// it. An 'error' event with no listener is thrown — `Error: write EIO`.
//
// That alone would be survivable. What made it fatal is the shape of a crash
// handler: its first act is to log the crash, which writes to the same dead
// stream, which schedules another 'error', which re-enters the handler. In the
// app that meant a modal crash dialog that reappeared every time it was
// dismissed, escapable only by force-quitting.
//
// Attaching a listener is the whole fix: an 'error' event with a listener is
// delivered, not thrown.

type GuardedStream = 'stdout' | 'stderr'

const guarded = new Set<GuardedStream>()

/** True when `error` is a stream write that failed because the other end is
 *  gone: a dead terminal (EIO) or a closed pipe (EPIPE). Losing somewhere to
 *  print is never a reason to crash, relaunch, or interrupt the user. */
export function isStreamWriteError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const { code, syscall } = error as { code?: unknown; syscall?: unknown }
  return syscall === 'write' && (code === 'EIO' || code === 'EPIPE')
}

/** Call before anything can log. `streams` narrows the guard for a process
 *  where a stream carries a protocol rather than logs — the MCP server's
 *  stdout is its JSON-RPC transport, and a transport that has failed should
 *  surface, not be swallowed. */
export function installConsoleStdioGuards(
  streams: readonly GuardedStream[] = ['stdout', 'stderr'],
): void {
  for (const name of streams) {
    if (guarded.has(name)) continue
    const stream = process[name] as NodeJS.WriteStream | undefined
    if (!stream || typeof stream.on !== 'function') continue
    guarded.add(name)
    stream.on('error', () => {
      // Deliberately empty. The stream we would report the failure on is the
      // one that just failed.
    })
  }
}
