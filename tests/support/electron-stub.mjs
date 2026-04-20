import os from 'node:os'

export const app = {
  isPackaged: false,
  getPath(name) {
    if (name === 'userData') return os.tmpdir()
    return os.tmpdir()
  },
  getVersion() {
    return '0.0.0-test'
  },
  async getFileIcon() {
    return {
      isEmpty() {
        return true
      },
      toDataURL() {
        return ''
      },
    }
  },
}

export const nativeImage = {
  createFromPath() {
    return {
      isEmpty() {
        return true
      },
      toDataURL() {
        return ''
      },
    }
  },
}

export const BrowserWindow = {
  getAllWindows() {
    return []
  },
}

export class Notification {
  show() {}
}

export const powerMonitor = {
  on() {},
  removeListener() {},
}
