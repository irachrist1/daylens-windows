// Typed accessor for the contextBridge surface
// Usage: import { ipc } from '@/lib/ipc'
import type { DaylensAPI } from '../../preload/index'

declare global {
  interface Window {
    daylens: DaylensAPI
  }
}

export const ipc = window.daylens
