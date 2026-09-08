// Best-effort localStorage access: privacy modes throw, SSR tests have no window.

export function readStorageItem(key: string): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writeStorageItem(key: string, value: string): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, value)
    }
  } catch {
    // The caller re-seeds the value on next launch.
  }
}

export function removeStorageItem(key: string): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(key)
    }
  } catch {
    // Nothing to recover: the key simply stays.
  }
}
