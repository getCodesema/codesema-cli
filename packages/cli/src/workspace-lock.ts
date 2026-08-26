// Single-workspace guard, GLOBAL to the machine: the multi-project workspace
// drives every registered repo from one process, so two codesema workspace
// processes would race on the same global project registry and mark each
// other's running tasks as orphans at boot (see reconcileTasks). A lockfile
// at <globalConfigDir()>/workspace.lock ({pid, port}) makes the second boot
// fail loudly. The lock is advisory and self-healing: a lock whose pid is
// dead (crash, SIGKILL — no release ran) is stolen instead of blocking
// forever.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { globalConfigDir } from './config.js'
import { t } from './i18n.js'

export type WorkspaceLock = { pid: number; port: number }

export function workspaceLockPath(): string {
  return join(globalConfigDir(), 'workspace.lock')
}

/** Parsed lock, or null when absent/corrupt (both mean: nothing holds it). */
export function readWorkspaceLock(): WorkspaceLock | null {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(workspaceLockPath(), 'utf8'))
  } catch {
    return null
  }
  const lock = raw as { pid?: unknown; port?: unknown } | null
  if (!lock || !Number.isInteger(lock.pid) || !Number.isInteger(lock.port)) {
    return null
  }
  return { pid: lock.pid as number, port: lock.port as number }
}

/**
 * Signal 0 probes existence without sending anything. EPERM means the pid is
 * alive but owned by someone else — still alive, so still a real holder.
 * Exported for brain-pidfile.ts's readers (D21): the repo-local brain.pid
 * follows the same "a dead pid blocks nothing" doctrine as this lock.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export type WorkspaceLockHandle = {
  /** Rewrites the lock with the real port once the server picked one. */
  setPort: (port: number) => void
  /** Removes the lock iff this process still owns it. Never throws. */
  release: () => void
}

/**
 * Takes the lock or throws (i18n 'workspace.locked') when a live process
 * holds it. The port is written as 0 first — the lock must exist BEFORE any
 * task store is touched, and the server only picks its port later; call
 * setPort once known. A dead holder's lock is silently stolen.
 */
export function acquireWorkspaceLock(): WorkspaceLockHandle {
  const existing = readWorkspaceLock()
  if (existing && existing.pid !== process.pid && isPidAlive(existing.pid)) {
    throw new Error(
      t('workspace.locked', { pid: existing.pid, port: existing.port, path: workspaceLockPath() }),
    )
  }
  mkdirSync(globalConfigDir(), { recursive: true })
  const write = (port: number): void => {
    writeFileSync(workspaceLockPath(), `${JSON.stringify({ pid: process.pid, port })}\n`)
  }
  write(0)
  return {
    setPort: (port) => write(port),
    release: () => {
      try {
        // Only ever delete our own lock: a stale release (e.g. after another
        // process legitimately stole a lock we crashed on) must not evict it.
        if (readWorkspaceLock()?.pid === process.pid && existsSync(workspaceLockPath())) {
          unlinkSync(workspaceLockPath())
        }
      } catch {
        // Best-effort: a dead pid in a leftover lock is stolen at next boot.
      }
    },
  }
}
