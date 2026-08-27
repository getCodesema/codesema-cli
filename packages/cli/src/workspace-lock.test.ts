import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  acquireWorkspaceLock,
  isPidAlive,
  readWorkspaceLock,
  workspaceLockPath,
} from './workspace-lock.js'

// The lock is GLOBAL (one workspace process per machine): it lives in
// globalConfigDir(), redirected to a fresh tmpdir per test via
// CODESEMA_CONFIG_DIR so tests never touch the real ~/.config/codesema.

let configDir: string
const previousConfigDir = process.env.CODESEMA_CONFIG_DIR

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'codesema-workspace-lock-'))
  process.env.CODESEMA_CONFIG_DIR = configDir
})

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true })
  if (previousConfigDir === undefined) {
    delete process.env.CODESEMA_CONFIG_DIR
  } else {
    process.env.CODESEMA_CONFIG_DIR = previousConfigDir
  }
})

/** A pid that is certainly dead: a child that already ran to completion. */
function deadPid(): number {
  const child = spawnSync('true')
  expect(child.pid).toBeGreaterThan(0)
  return child.pid
}

/** Pre-seeds a lock file as a previous process would have left it. */
function seedLock(content: string): void {
  mkdirSync(configDir, { recursive: true })
  writeFileSync(workspaceLockPath(), content)
}

describe('acquireWorkspaceLock', () => {
  test('the lock lives in the global config dir, not in any repo', () => {
    expect(workspaceLockPath()).toBe(join(configDir, 'workspace.lock'))
  })

  test('takes the lock with our pid, setPort rewrites it, release removes it', () => {
    const lock = acquireWorkspaceLock()
    expect(readWorkspaceLock()).toEqual({ pid: process.pid, port: 0 })

    lock.setPort(4407)
    expect(readWorkspaceLock()).toEqual({ pid: process.pid, port: 4407 })

    lock.release()
    expect(existsSync(workspaceLockPath())).toBe(false)
  })

  test('refuses when a live process holds the lock', () => {
    acquireWorkspaceLock() // held by this very-much-alive test process
    // Simulate a second `codesema workspace` boot: same machine, foreign pid.
    // pid 1 is always alive (init/systemd), and kill(1, 0) yields EPERM for
    // an unprivileged test — the exact "alive but not ours" case.
    seedLock(JSON.stringify({ pid: 1, port: 4400 }))
    expect(() => acquireWorkspaceLock()).toThrow(/pid 1.*port 4400/)
  })

  test('steals a lock whose pid is dead', () => {
    seedLock(JSON.stringify({ pid: deadPid(), port: 4400 }))
    const lock = acquireWorkspaceLock()
    expect(readWorkspaceLock()).toEqual({ pid: process.pid, port: 0 })
    lock.release()
  })

  test('a corrupt or half-written lock never blocks the boot', () => {
    seedLock('{"pid": 12')
    acquireWorkspaceLock()
    expect(readWorkspaceLock()?.pid).toBe(process.pid)
  })

  test('re-acquiring our own leftover lock (crash then restart, recycled pid) succeeds', () => {
    seedLock(JSON.stringify({ pid: process.pid, port: 4400 }))
    acquireWorkspaceLock()
    expect(readWorkspaceLock()).toEqual({ pid: process.pid, port: 0 })
  })

  test('release never evicts a lock another process took over', () => {
    const lock = acquireWorkspaceLock()
    // Another workspace legitimately stole the lock (e.g. after our crash).
    writeFileSync(workspaceLockPath(), JSON.stringify({ pid: 1, port: 4409 }))
    lock.release()
    expect(readWorkspaceLock()).toEqual({ pid: 1, port: 4409 })
  })

  test('readWorkspaceLock: absent file and non-numeric fields are both null', () => {
    expect(readWorkspaceLock()).toBeNull()
    acquireWorkspaceLock()
    writeFileSync(workspaceLockPath(), JSON.stringify({ pid: 'x', port: 1 }))
    expect(readWorkspaceLock()).toBeNull()
  })
})

// Exported for runner-pidfile.ts (D21): runner.pid follows the same "a dead
// pid is never a permanent blocker" doctrine as this lock, and reuses this
// exact check rather than a second copy of it.
describe('isPidAlive', () => {
  test('true for our own, very much alive, pid', () => {
    expect(isPidAlive(process.pid)).toBe(true)
  })

  test('false for a pid that already ran to completion', () => {
    expect(isPidAlive(deadPid())).toBe(false)
  })

  test('true for pid 1 (EPERM: alive, just not ours)', () => {
    expect(isPidAlive(1)).toBe(true)
  })
})
