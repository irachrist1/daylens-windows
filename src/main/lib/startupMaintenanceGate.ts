// When the database's startup maintenance is allowed to run.
//
// The repairs it schedules heal historical drift: stored identity columns,
// app-identity observations, and block labels the work-name guards now reject.
// They are idempotent, stamped once they finish, and nothing the first paint
// reads is waiting on them.
//
// They used to start on the macrotask after initDb(), which lands before the
// renderer has loaded. On the one launch they actually do work — the first
// after a WORK_NAME_GUARD_VERSION bump, which is the launch right after an
// update — that held the window off screen for eleven seconds on a real
// database, and anyone who gave up and quit got the whole pass again next
// launch, because the stamp is only written at the end.
//
// So a host that owns a window holds the gate until it has one. A caller with
// no window — the tests, the range worker, the CLI — sets no holder and keeps
// the original timing.

interface Hold {
  pending: (() => void) | null
}

let currentHold: Hold | null = null

/**
 * Hold startup maintenance until the returned release is called.
 *
 * The release is safe to call more than once, and a release from a previous
 * hold never opens a newer one: the app releases from several places (the
 * window becoming paintable, the renderer finishing its load, and a timeout
 * behind both) so that a launch where one of them never arrives still gets
 * its maintenance instead of postponing it forever.
 */
export function holdStartupMaintenance(): () => void {
  const hold: Hold = { pending: null }
  currentHold = hold
  return () => {
    if (currentHold !== hold) return
    currentHold = null
    const run = hold.pending
    hold.pending = null
    if (run) setImmediate(run)
  }
}

/** Run `work` when the gate allows it — on the next macrotask when nothing is
 *  holding it, otherwise as soon as the holder releases. */
export function scheduleStartupMaintenance(work: () => void): void {
  if (currentHold) {
    currentHold.pending = work
    return
  }
  setImmediate(work)
}

/** Drop any hold, so one test cannot leave the gate shut for the next. */
export function resetStartupMaintenanceGateForTest(): void {
  currentHold = null
}
