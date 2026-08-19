// Per-REPOSITORY guard on git worktree operations, at
// <repo>/.codesema/worktrees/.lock. Same doctrine as workspace-lock.ts
// (advisory JSON lockfile, self-healing when its holder is gone) but a
// different scope, and deliberately so: the global workspace lock guarantees
// ONE workspace process per machine, which says nothing about two operations
// racing on ONE repository's git index — `worktree add` and `worktree remove`
// both write it, and a second writer (another codesema process, a `codesema`
// command run by hand next to the workspace) can land between the creation of
// one worktree and the removal of another.
//
// Two differences with the workspace lock, both on purpose:
//
//   - what a busy lock MEANS. Booting twice is a mistake to refuse, whereas
//     two worktree operations are both legitimate and merely have to take
//     turns. So this one WAITS and only fails when the wait runs out.
//   - waiting is ASYNCHRONOUS. The workspace is a live HTTP server with SSE
//     streams open; a synchronous wait would freeze every other task, every
//     request and every heartbeat for as long as it lasted. Nothing here ever
//     blocks the event loop.

import { randomBytes } from 'node:crypto'
import { linkSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureWorkDir } from './config.js'
import type { ReasonCode } from './contract.js'
import { t } from './i18n.js'

export type WorktreeLock = {
  pid: number
  /** Epoch ms the lock was taken: the only way to tell a hung holder from a live one. */
  at: number
}

export function worktreeLockPath(cwd: string): string {
  return join(cwd, '.codesema', 'worktrees', '.lock')
}

/**
 * How long a caller waits for its turn before giving up.
 *
 * Age alone NEVER makes a lock stealable: only a holder that is gone is (see
 * `stealReason`). A live holder is waited for, and the wait ends in a plain
 * `resource_busy` refusal — never in a second writer on the same git index.
 */
export const WORKTREE_LOCK_TIMEOUT_MS = 75_000
/**
 * Last-resort valve against PID RECYCLING, and nothing else. `alive(pid)` can
 * answer "yes" about a completely unrelated process that inherited the pid of
 * the one that crashed holding the lock; without this valve such a lock would
 * wedge the repository until a human deleted the file by hand.
 *
 * It is deliberately an ORDER OF MAGNITUDE above WORKTREE_LOCK_TIMEOUT_MS (12x):
 * a lock this old cannot be a caller that is merely being patient, since every
 * caller gives up long before. Crossing it is a degradation, not a routine
 * self-heal — the steal is reported on the handle so the caller can journal it.
 */
export const WORKTREE_LOCK_PID_REUSE_GRACE_MS = 900_000
/** Poll interval while waiting: short enough to feel instant, long enough not to spin. */
const RETRY_MS = 25

/**
 * Locks this PROCESS is holding right now, by path. The file alone cannot
 * answer that question: a lock carrying our own pid is either us, holding it,
 * or the residue of an earlier attempt whose release never ran — and stealing
 * the first would be a silent double-entry, while waiting on the second would
 * deadlock the process against itself.
 */
const held = new Set<string>()

/**
 * A worktree operation that never got its turn. Typed, and carrying the code
 * that names the degradation: the machine was busy with something it would not
 * let go of, which is exactly `resource_busy` — retryable by definition.
 */
export class WorktreeLockBusyError extends Error {
  // camelCase, like every other producer in the codebase (ShipOutcome.reasonCode):
  // `reason_code` is the WIRE spelling, for the journal and the contract, and a
  // producer that borrowed it made the same field look like two. Consumers read
  // this through reasonCodeOf(), which still tolerates both.
  readonly reasonCode: ReasonCode = 'resource_busy'
  /** Pid the lock named when the wait ran out; 0 when it named nothing readable. */
  readonly pid: number
  /** How long that holder had been holding, in ms; 0 when unknown. */
  readonly ageMs: number
  readonly lockPath: string

  constructor(message: string, lockPath: string, pid: number, ageMs: number) {
    super(message)
    this.name = 'WorktreeLockBusyError'
    this.lockPath = lockPath
    this.pid = pid
    this.ageMs = ageMs
  }
}

/** Parsed lock, or null when absent/corrupt/unreadable (all mean: nothing holds it). */
export function readWorktreeLock(cwd: string): WorktreeLock | null {
  return readLockFile(worktreeLockPath(cwd))
}

function readLockFile(path: string): WorktreeLock | null {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
  const lock = raw as { pid?: unknown; at?: unknown } | null
  if (!lock || !Number.isInteger(lock.pid)) {
    return null
  }
  return { pid: lock.pid as number, at: Number.isInteger(lock.at) ? (lock.at as number) : 0 }
}

/** Signal 0 probes existence; EPERM means alive but owned by someone else. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Claims the lock name atomically, and never publishes it half-written.
 *
 * `open(…, 'wx')` would be atomic too, but it makes the file visible under its
 * final name BEFORE its content is written: a reader landing in that window
 * parses an empty file, reads it as corrupt — therefore as abandoned — and can
 * evict a holder that had just legitimately taken it. So the content is
 * written to a private temp file first and only the NAME is claimed, by a hard
 * link that fails with EEXIST when someone already holds it. The file is
 * complete the instant it exists.
 */
function tryCreateLock(path: string, at: number): boolean {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}`
  try {
    writeFileSync(tmp, `${JSON.stringify({ pid: process.pid, at })}\n`)
    linkSync(tmp, path)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // EEXIST is the ordinary answer — somebody holds it, wait your turn.
    // Anything else means the NAME cannot be claimed at all: a filesystem
    // without hard links, a directory nobody can write. Waiting fixes none of
    // that, and spending the whole budget only to then blame a holder that
    // never existed ("pid 0 for 0s") is a lie. Fail now, saying why.
    if (code !== 'EEXIST') {
      throw new Error(t('task.worktreeLockUnusable', { path, detail: code ?? String(err) }), {
        cause: err,
      })
    }
    // EEXIST on something that is not a regular file (a directory left at that
    // name) is just as hopeless: no holder will ever release it. A stat that
    // fails means the entry vanished under us — that IS a normal retry.
    let entry: ReturnType<typeof statSync> | null = null
    try {
      entry = statSync(path)
    } catch {
      entry = null
    }
    if (entry && !entry.isFile()) {
      throw new Error(t('task.worktreeLockUnusable', { path, detail: 'not a regular file' }), {
        cause: err,
      })
    }
    return false
  } finally {
    try {
      // The link (when it succeeded) holds the content: the temp name is done.
      unlinkSync(tmp)
    } catch {
      // Never created, or already gone.
    }
  }
}

/** Same holder, byte for byte as far as identity goes. Two unreadable locks count as the same nothing. */
function sameHolder(a: WorktreeLock | null, b: WorktreeLock | null): boolean {
  if (a === null || b === null) {
    return a === b
  }
  return a.pid === b.pid && a.at === b.at
}

/**
 * Removes the lock ONLY if it is still the exact one that was judged
 * abandoned. Between that judgement and this call another process may have
 * taken the lock legitimately, and evicting it would be precisely the
 * corruption the lock exists to prevent — so the file is re-read immediately
 * before the unlink and left alone on any mismatch.
 *
 * The remaining window (re-read → unlink) cannot be closed without OS-level
 * locking, and it does not need to be: nothing is ever built on top of a
 * successful steal. The atomic name claim of the next round (tryCreateLock) is
 * what actually grants the lock, only one caller can win it, and git's own
 * index lock is the net under all of it.
 */
function stealIfUnchanged(path: string, expected: WorktreeLock | null): boolean {
  if (!sameHolder(readLockFile(path), expected)) {
    return false
  }
  try {
    unlinkSync(path)
    return true
  } catch {
    return false
  }
}

/** Sleeps, but wakes IMMEDIATELY on abort: a Ctrl-C must not wait out the poll interval. */
const sleepAsync = (ms: number, signal?: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const done = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })

/**
 * Thrown when the human stopped the operation while it queued for the lock.
 * Distinct from WorktreeLockBusyError on purpose: nothing went wrong and
 * nothing is worth retrying automatically — someone asked it to stop.
 */
export class WorktreeLockAbortedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorktreeLockAbortedError'
  }
}

export type WorktreeLockOptions = {
  timeoutMs?: number | undefined
  /** Overrides WORKTREE_LOCK_PID_REUSE_GRACE_MS. Not a staleness budget: see there. */
  pidReuseGraceMs?: number | undefined
  /**
   * Gives up the wait the moment the caller is interrupted. Without it a
   * Ctrl-C on a task queued behind another repo operation would sit through
   * the whole budget before anything could react.
   */
  signal?: AbortSignal | undefined
  /** Test seams — the defaults use the real clock, a real timer and real pids. */
  nowFn?: (() => number) | undefined
  sleepFn?: ((ms: number) => Promise<void>) | undefined
  pidAliveFn?: ((pid: number) => boolean) | undefined
}

export type WorktreeLockHandle = {
  /** Removes the lock iff this process still owns it. Idempotent, never throws. */
  release: () => void
  /**
   * Set ONLY when this acquisition took the lock away from a holder whose pid
   * was still alive, past the pid-recycling grace. It is a degradation the
   * caller MUST surface (invariant 2): everything else — a dead holder, our own
   * residue — is routine self-healing and leaves this undefined.
   */
  stolen?: { pid: number; ageMs: number }
}

/**
 * Why this lock can be taken from under its holder — `null` to wait for it.
 *
 * A LIVE holder is never robbed on age: the only thing an old lock proves is
 * that the operation behind it is slow, and a "slow" holder is still writing to
 * the git index. Two processes writing that index is exactly the corruption
 * this lock exists to prevent, so patience is the only safe answer, and the
 * wait ends in a refusal (WorktreeLockBusyError), not in a race.
 */
type StealReason = 'own_residue' | 'dead_holder' | 'pid_reuse' | null

function stealReason(
  lock: WorktreeLock,
  now: number,
  pidReuseGraceMs: number,
  alive: (pid: number) => boolean,
): StealReason {
  // Our own pid on a lock `held` does not know about: residue of an attempt
  // whose release never ran. Waiting on it would be waiting on ourselves.
  if (lock.pid === process.pid) {
    return 'own_residue'
  }
  if (!alive(lock.pid)) {
    return 'dead_holder'
  }
  // Alive, but implausibly so — see WORKTREE_LOCK_PID_REUSE_GRACE_MS.
  return now - lock.at >= pidReuseGraceMs ? 'pid_reuse' : null
}

/**
 * Takes the repo's worktree lock, waiting (up to `timeoutMs`, without ever
 * blocking the event loop) for whoever holds it. Rejects with a
 * WorktreeLockBusyError when the wait runs out — a refusal to start, never a
 * silent second writer on the git index. Every caller MUST release in a
 * `finally`: a lock left behind by a crash is self-healed (its pid is gone),
 * one left behind by a live process that forgot to release is not — it is
 * waited for, then refused. Age is not evidence of abandonment.
 */
export async function acquireWorktreeLock(
  cwd: string,
  opts: WorktreeLockOptions = {},
): Promise<WorktreeLockHandle> {
  const now = opts.nowFn ?? Date.now
  const signal = opts.signal
  const sleep = opts.sleepFn ?? ((ms: number) => sleepAsync(ms, signal))
  const alive = opts.pidAliveFn ?? isPidAlive
  const timeoutMs = opts.timeoutMs ?? WORKTREE_LOCK_TIMEOUT_MS
  const pidReuseGraceMs = opts.pidReuseGraceMs ?? WORKTREE_LOCK_PID_REUSE_GRACE_MS
  const path = worktreeLockPath(cwd)
  // The lock lives INSIDE the self-ignoring .codesema/: its directory (and the
  // '*' .gitignore ensureWorkDir writes) must exist before the file does, or
  // the lock would show up as an untracked file of the very repo it guards.
  ensureWorkDir(cwd)
  mkdirSync(join(cwd, '.codesema', 'worktrees'), { recursive: true })

  const deadline = now() + timeoutMs
  // Carried out of the loop: the degradation belongs to the acquisition that
  // performed the steal, and the handle is the only thing it hands back.
  let stolen: { pid: number; ageMs: number } | null = null
  for (;;) {
    if (signal?.aborted) {
      throw new WorktreeLockAbortedError(t('task.worktreeLockAborted'))
    }
    if (tryCreateLock(path, now())) {
      held.add(path)
      let released = false
      return {
        ...(stolen ? { stolen } : {}),
        release: () => {
          if (released) {
            return
          }
          released = true
          held.delete(path)
          try {
            // Only ever delete OUR lock: a stale release must not evict the
            // holder that legitimately stole it after a crash.
            if (readLockFile(path)?.pid === process.pid) {
              unlinkSync(path)
            }
          } catch {
            // Best-effort: an orphan is stolen by the next caller.
          }
        },
      }
    }
    const holder = readLockFile(path)
    const reason: StealReason =
      holder === null
        ? 'dead_holder' // Vanished under us: nothing to wait for, retry at once.
        : held.has(path)
          ? null
          : stealReason(holder, now(), pidReuseGraceMs, alive)
    // A holder that is gone is not a wait: take the lock (identity checked) and
    // retry straight away. The deadline still bounds the retry — one window past
    // it — so a pathological ping-pong gives up instead of spinning forever.
    // The budget is checked BEFORE the steal, never after: `&&` short-circuits
    // left to right, so testing it last would remove the lock file and THEN
    // give up, leaving no holder at all and an error naming a pid that no
    // longer holds anything.
    if (reason !== null && now() < deadline + RETRY_MS && stealIfUnchanged(path, holder)) {
      if (reason === 'pid_reuse' && holder) {
        stolen = { pid: holder.pid, ageMs: Math.max(0, now() - holder.at) }
      }
      continue
    }
    if (now() >= deadline) {
      const pid = holder?.pid ?? 0
      const ageMs = holder ? Math.max(0, now() - holder.at) : 0
      throw new WorktreeLockBusyError(
        t('task.worktreeLocked', { path, pid, seconds: Math.round(ageMs / 1000) }),
        path,
        pid,
        ageMs,
      )
    }
    await sleep(RETRY_MS)
  }
}
