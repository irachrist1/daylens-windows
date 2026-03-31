import { execSync } from 'node:child_process'
import type { ProcessSnapshot } from '@shared/types'

export type { ProcessSnapshot } from '@shared/types'

const PROCESS_POLL_MS = 15_000
const WMIC_COMMAND = 'wmic process get ProcessId,Name,WorkingSetSize,PageFileUsage /format:csv'

let monitorInterval: ReturnType<typeof setInterval> | null = null
let latestSnapshot: ProcessSnapshot[] = []

export function getRunningProcesses(): ProcessSnapshot[] {
  if (process.platform !== 'win32') return []

  try {
    const output = execSync(WMIC_COMMAND, {
      timeout: 5_000,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const now = Date.now()

    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('Node,'))
      .map((line) => {
        const parts = line.split(',')
        const name = parts[1]?.trim() ?? 'Unknown'
        const pid = parseInt(parts[3]?.trim() ?? '0', 10)
        const workingSetSize = parseInt(parts[4]?.trim() ?? '0', 10)

        return {
          pid,
          name: name.replace(/\.exe$/i, ''),
          cpuPercent: 0,
          memoryMb: Math.round(workingSetSize / 1024 / 1024),
          capturedAt: now,
        }
      })
      .filter((process) => process.pid > 0 && process.memoryMb > 0)
  } catch {
    return []
  }
}

export function startProcessMonitor(): void {
  if (process.platform !== 'win32') {
    latestSnapshot = []
    return
  }
  if (monitorInterval) return

  latestSnapshot = getRunningProcesses()
  monitorInterval = setInterval(() => {
    latestSnapshot = getRunningProcesses()
  }, PROCESS_POLL_MS)
}

export function stopProcessMonitor(): void {
  if (!monitorInterval) return
  clearInterval(monitorInterval)
  monitorInterval = null
}

export function getLatestSnapshot(): ProcessSnapshot[] {
  return latestSnapshot
}
