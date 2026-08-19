import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import {
  acquireWorktreeLock,
  readWorktreeLock,
  WORKTREE_LOCK_PID_REUSE_GRACE_MS,
  WORKTREE_LOCK_TIMEOUT_MS,
  WorktreeLockAbortedError,
  WorktreeLockBusyError,
  worktreeLockPath,
  type WorktreeLockHandle,
} from './worktree-lock.js'

const cleanups: string[] = []
const openLocks: WorktreeLockHandle[] = []

function makeRepoDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codesema-wt-lock-'))
  cleanups.push(dir)
  return dir
}

/** A pid that ran and is gone: nothing can be holding a lock in its name. */
function deadPid(): number {
  const done = spawnSync('sh', ['-c', 'exit 0'])
  return done.pid ?? 2_147_483_646
}

/** Writes a lock file straight to disk, as another process would have left it. */
function plantLock(dir: string, content: string): void {
  mkdirSync(join(dir, '.codesema', 'worktrees'), { recursive: true })
  writeFileSync(worktreeLockPath(dir), content)
}

/** Monotonic fake clock: each read moves 10 ms on, so a budget always runs out. */
function fakeClock(): () => number {
  let now = 0
  return () => (now += 10)
}

const noSleep = (): Promise<void> => Promise.resolve()

afterEach(() => {
  for (const lock of openLocks.splice(0)) {
    lock.release()
  }
  for (const dir of cleanups.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('acquireWorktreeLock', () => {
  test('the pid-recycling valve sits an order of magnitude above the wait budget', () => {
    // The valve must be unreachable by patience: any lock young enough to be a
    // caller that is merely waiting (at most one budget) must be far below it,
    // or an ordinary slow operation would be robbed mid-write.
    expect(WORKTREE_LOCK_PID_REUSE_GRACE_MS).toBeGreaterThanOrEqual(10 * WORKTREE_LOCK_TIMEOUT_MS)
  })

  test('takes the lock under .codesema/worktrees and releases it', async () => {
    const dir = makeRepoDir()
    const lock = await acquireWorktreeLock(dir)
    expect(worktreeLockPath(dir)).toBe(join(dir, '.codesema', 'worktrees', '.lock'))
    expect(existsSync(worktreeLockPath(dir))).toBe(true)
    expect(readWorktreeLock(dir)?.pid).toBe(process.pid)
    // The lock lives inside the self-ignoring .codesema/: it must never show up
    // as an untracked file of the repository it guards.
    expect(readFileSync(join(dir, '.codesema', '.gitignore'), 'utf8')).toBe('*\n')
    lock.release()
    expect(existsSync(worktreeLockPath(dir))).toBe(false)
    // Releasing twice is a no-op, not a crash.
    expect(() => lock.release()).not.toThrow()
  })

  test('a second acquisition WAITS for the holder instead of running beside it', async () => {
    const dir = makeRepoDir()
    const first = await acquireWorktreeLock(dir)
    const order: string[] = []
    const second = await acquireWorktreeLock(dir, {
      sleepFn: () => {
        order.push('waited')
        first.release()
        return Promise.resolve()
      },
    })
    openLocks.push(second)
    order.push('acquired')
    // It did not walk in beside the holder: it waited, then took its turn.
    expect(order).toEqual(['waited', 'acquired'])
    expect(readWorktreeLock(dir)?.pid).toBe(process.pid)
  })

  test('waiting never blocks the event loop', async () => {
    const dir = makeRepoDir()
    const first = await acquireWorktreeLock(dir)
    openLocks.push(first)
    // A timer scheduled BEFORE the wait must fire DURING it. With a blocking
    // sleep it could only fire after the whole acquisition had given up.
    let tickedAt = 0
    const timer = setTimeout(() => {
      tickedAt = Date.now()
    }, 5)
    const startedAt = Date.now()
    // Real sleeps, real clock: this is the production path, not a seam.
    await expect(acquireWorktreeLock(dir, { timeoutMs: 120 })).rejects.toThrow(
      WorktreeLockBusyError,
    )
    clearTimeout(timer)
    expect(tickedAt).toBeGreaterThan(0)
    expect(tickedAt - startedAt).toBeLessThan(100)
  })

  test('a holder that never lets go fails with resource_busy, the pid and the age', async () => {
    const dir = makeRepoDir()
    plantLock(dir, JSON.stringify({ pid: process.pid + 1, at: Date.now() - 3_000 }))
    let caught: unknown
    try {
      await acquireWorktreeLock(dir, {
        timeoutMs: 100,
        pidAliveFn: () => true,
        sleepFn: noSleep,
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(WorktreeLockBusyError)
    const busy = caught as WorktreeLockBusyError
    // Retryable by definition: being busy is a state that ends.
    expect(busy.reasonCode).toBe('resource_busy')
    expect(busy.pid).toBe(process.pid + 1)
    expect(busy.ageMs).toBeGreaterThanOrEqual(3_000)
    expect(busy.message).toContain(String(process.pid + 1))
    // The holder still holds: a failed wait never evicts it.
    expect(readWorktreeLock(dir)?.pid).toBe(process.pid + 1)
  })

  test("a crashed holder's lock is stolen, not waited on", async () => {
    const dir = makeRepoDir()
    plantLock(dir, JSON.stringify({ pid: deadPid(), at: Date.now() }))
    const lock = await acquireWorktreeLock(dir, { timeoutMs: 0, sleepFn: noSleep })
    openLocks.push(lock)
    expect(readWorktreeLock(dir)?.pid).toBe(process.pid)
    // Routine self-healing, not a degradation: nothing to report to the human.
    expect(lock.stolen).toBeUndefined()
  })

  test('a LIVE holder is waited on past the old staleness threshold, then refused', async () => {
    const dir = makeRepoDir()
    // Age is not evidence of abandonment: an old lock only means the operation
    // behind it is slow, and a slow holder is still writing the git index.
    // Robbing it would put two writers on that index — the one thing this lock
    // exists to prevent. So: wait, then refuse.
    const holder = { pid: process.pid + 1, at: 0 }
    plantLock(dir, JSON.stringify(holder))
    let now = 0
    let caught: unknown
    try {
      await acquireWorktreeLock(dir, {
        timeoutMs: WORKTREE_LOCK_TIMEOUT_MS,
        pidAliveFn: () => true,
        sleepFn: noSleep,
        nowFn: () => (now += 5_000),
      })
    } catch (err) {
      caught = err
    }
    // The wait really did run far past the 60s staleness budget of the design
    // this replaces — which would have stolen the lock from under a live holder.
    expect(now).toBeGreaterThan(60_000)
    expect(caught).toBeInstanceOf(WorktreeLockBusyError)
    expect((caught as WorktreeLockBusyError).reasonCode).toBe('resource_busy')
    expect(readWorktreeLock(dir)).toEqual(holder)
  })

  test('the pid-recycling valve steals from a live pid, and REPORTS the steal', async () => {
    const dir = makeRepoDir()
    // Alive, but implausibly so: no caller waits fifteen minutes (they give up
    // after 75s), so this pid is almost certainly a recycled one and the lock
    // is the residue of a process that died with the machine. Left alone it
    // would wedge the repository until a human deleted the file by hand.
    const at = Date.now() - 2 * WORKTREE_LOCK_PID_REUSE_GRACE_MS
    plantLock(dir, JSON.stringify({ pid: process.pid + 1, at }))
    const lock = await acquireWorktreeLock(dir, {
      timeoutMs: 0,
      pidAliveFn: () => true,
      sleepFn: noSleep,
    })
    openLocks.push(lock)
    expect(readWorktreeLock(dir)?.pid).toBe(process.pid)
    // Never silent: the caller gets what it needs to say so out loud.
    expect(lock.stolen?.pid).toBe(process.pid + 1)
    expect(lock.stolen?.ageMs).toBeGreaterThanOrEqual(WORKTREE_LOCK_PID_REUSE_GRACE_MS)
  })

  test('a holder that arrives BETWEEN the verdict and the steal is not evicted', async () => {
    const dir = makeRepoDir()
    const crashed = { pid: process.pid + 1, at: Date.now() - 10_000 }
    plantLock(dir, JSON.stringify(crashed))
    const newcomer = { pid: process.pid + 2, at: Date.now() }
    let raced = false
    let caught: unknown
    try {
      await acquireWorktreeLock(dir, {
        timeoutMs: 40,
        sleepFn: noSleep,
        // Called while judging the crashed holder — i.e. exactly in the window
        // between reading the lock and removing it. A third process takes it
        // there, legitimately, and must survive the steal that was about to
        // happen on someone else's identity. It is alive; the crashed one is not.
        pidAliveFn: (pid) => {
          if (!raced) {
            raced = true
            writeFileSync(worktreeLockPath(dir), JSON.stringify(newcomer))
          }
          return pid === newcomer.pid
        },
      })
    } catch (err) {
      caught = err
    }
    expect(raced).toBe(true)
    expect(caught).toBeInstanceOf(WorktreeLockBusyError)
    // The newcomer still holds its lock: nothing was stolen out from under it.
    expect(readWorktreeLock(dir)).toEqual(newcomer)
  })

  test('a spent budget never removes the lock on its way out', async () => {
    const dir = makeRepoDir()
    const holder = { pid: deadPid(), at: Date.now() }
    plantLock(dir, JSON.stringify(holder))
    // The holder IS stealable, but there is no budget left to use the steal.
    // Removing it here and then giving up would leave the repo with no holder
    // at all, and an error naming a pid that holds nothing.
    let caught: unknown
    try {
      await acquireWorktreeLock(dir, { timeoutMs: -1_000, sleepFn: noSleep })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(WorktreeLockBusyError)
    expect(readWorktreeLock(dir)).toEqual(holder)
  })

  test('a corrupt lock file holds nothing', async () => {
    const dir = makeRepoDir()
    plantLock(dir, 'not json at all')
    const lock = await acquireWorktreeLock(dir, { timeoutMs: 0, sleepFn: noSleep })
    openLocks.push(lock)
    expect(readWorktreeLock(dir)?.pid).toBe(process.pid)
  })

  test('our own pid on a lock nothing in this process holds is residue, not a holder', async () => {
    const dir = makeRepoDir()
    // An earlier attempt died between taking the lock and releasing it: waiting
    // on it would be this process waiting on itself, forever.
    plantLock(dir, JSON.stringify({ pid: process.pid, at: Date.now() }))
    const lock = await acquireWorktreeLock(dir, { timeoutMs: 0, sleepFn: noSleep })
    openLocks.push(lock)
    expect(readWorktreeLock(dir)?.pid).toBe(process.pid)
  })

  test('a live foreign holder is waited on, never stolen', async () => {
    const dir = makeRepoDir()
    plantLock(dir, JSON.stringify({ pid: process.pid + 1, at: Date.now() }))
    await expect(
      acquireWorktreeLock(dir, {
        timeoutMs: 5,
        pidAliveFn: () => true,
        sleepFn: noSleep,
        nowFn: fakeClock(),
      }),
    ).rejects.toThrow(WorktreeLockBusyError)
    expect(readWorktreeLock(dir)?.pid).toBe(process.pid + 1)
  })

  test('an already-interrupted caller never even queues', async () => {
    const dir = makeRepoDir()
    const first = await acquireWorktreeLock(dir)
    openLocks.push(first)
    const controller = new AbortController()
    controller.abort()
    let slept = 0
    await expect(
      acquireWorktreeLock(dir, {
        signal: controller.signal,
        timeoutMs: 60_000,
        sleepFn: () => {
          slept++
          return Promise.resolve()
        },
      }),
    ).rejects.toThrow(WorktreeLockAbortedError)
    expect(slept).toBe(0)
  })

  test('an interrupt DURING the wait is obeyed at once, not after the budget', async () => {
    const dir = makeRepoDir()
    const first = await acquireWorktreeLock(dir)
    openLocks.push(first)
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 10)
    const startedAt = Date.now()
    // A budget far longer than the test: only the abort can end this wait.
    await expect(
      acquireWorktreeLock(dir, { signal: controller.signal, timeoutMs: 60_000 }),
    ).rejects.toThrow(WorktreeLockAbortedError)
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    // The holder is untouched: an interrupted waiter never takes anything.
    expect(readWorktreeLock(dir)?.pid).toBe(process.pid)
  })

  test('the lock file is never visible half-written, and leaves no scratch behind', async () => {
    const dir = makeRepoDir()
    const lock = await acquireWorktreeLock(dir)
    openLocks.push(lock)
    // Published atomically: whoever sees the name sees the whole record. An
    // empty file under that name would read as corrupt — therefore abandoned —
    // and a fresh holder would be evicted by the next caller.
    expect(readFileSync(worktreeLockPath(dir), 'utf8').trim()).not.toBe('')
    expect(readWorktreeLock(dir)?.pid).toBe(process.pid)
    expect(readdirSync(join(dir, '.codesema', 'worktrees'))).toEqual(['.lock'])
  })

  test('a lock name that cannot be claimed fails FAST, saying why', async () => {
    const dir = makeRepoDir()
    // A directory squatting the lock's name: no holder will ever release it,
    // and every read of it is "corrupt" — so the wait would burn its whole
    // budget and then blame a holder that never existed ("pid 0 for 0s").
    mkdirSync(join(dir, '.codesema', 'worktrees', '.lock'), { recursive: true })
    const startedAt = Date.now()

    await expect(acquireWorktreeLock(dir, { timeoutMs: 60_000 })).rejects.toThrow(
      /cannot be claimed/,
    )

    expect(Date.now() - startedAt).toBeLessThan(1_000)
  })

  test('release never evicts the lock another holder legitimately took', async () => {
    const dir = makeRepoDir()
    const lock = await acquireWorktreeLock(dir)
    plantLock(dir, JSON.stringify({ pid: process.pid + 1, at: Date.now() }))
    lock.release()
    expect(readWorktreeLock(dir)?.pid).toBe(process.pid + 1)
  })
})
