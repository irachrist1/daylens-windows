const storeData = new Map()

export default class Store {
  get(key, defaultValue = undefined) {
    return storeData.has(key) ? storeData.get(key) : defaultValue
  }

  set(key, value) {
    storeData.set(key, value)
  }
}

export function __getElectronStoreSnapshot() {
  return Object.fromEntries(storeData.entries())
}

export function __resetElectronStore() {
  storeData.clear()
}
