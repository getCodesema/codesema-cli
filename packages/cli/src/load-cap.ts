// Machine-wide load cap (T1.3, decision D4): a semaphore over every HEAVY
// process this workspace ever runs — agent turns, end-of-turn reviews and
// containerized checks — confounded in ONE budget, not three. Before this
// module, only the agent turn was gated (by the now-inert TaskSlotPool,
// task-runner.ts) and the review agent and the checks containers ran
// "outside" whatever cap existed: on a modest machine, a review plus a
// checks run plus two agent turns could pin four heavy processes at once
// with nothing that ever named the fifth as "waiting for the machine" rather
// than just "waiting".
//
// ── Why a process-memory semaphore, not a file lock (design.md Decision 1) ──
//
// D1 already guarantees ONE workspace process per machine (the global
// workspace.lock, workspace-lock.ts). A semaphore that lived on disk would
// protect nothing a second writer doesn't already threaten in far worse ways
// (the task store itself has no such protection either), and would pay an
// I/O round trip on every acquisition for that non-existent protection. The
// day a second writer legitimately appears, D1 says to revisit the store
// itself — this module goes with it, not around it.
//
// ── Two admission paths, one FIFO (design.md Decision 3) ────────────────────
//
// `acquire(kind)` is the path for a consumer with nowhere else to wait: the
// end-of-turn reviewer and the checks runner have no queue of their own, so
// they simply await a Promise that resolves once a slot is free, joining the
// SAME FIFO as everyone else regardless of `kind` — the spec is explicit that
// turns, reviews and checks are one budget, not three lanes.
//
// `tryAcquire(kind)` is the SYNCHRONOUS, non-blocking half: it either takes a
// free slot on the spot or returns null, and it NEVER queues. It exists
// because task-runner.ts's launch() must reserve its slot before its first
// `await` — the same property the project's admission claim already carries
// (task-queue.ts) — and an `await acquire()` at the top of launch() would
// break that outright. The invariant that makes this safe: the FIFO is only
// ever non-empty when occupied === max (every acquire either takes a free
// slot immediately or joins the queue, and a release either hands the slot
// straight to the head of the queue or, when the queue is empty, decrements
// occupied), so "occupied < max" and "someone is queued" can never both be
// true — `tryAcquire` therefore never has to consult the queue to stay fair.
export type LoadCapKind = 'turn' | 'review' | 'checks'

/** Frees the slot it was handed. Idempotent: a second call is a no-op. */
export type Release = () => void

export type LoadCapSnapshot = {
  /** Slots currently held. */
  occupied: number
  /** The configured plafond (maxConcurrentAgents, D4). */
  max: number
  /**
   * Requests parked in THIS module's own FIFO — `acquire()` callers with
   * nowhere else to wait (the review agent, a checks run). Deliberately NOT a
   * count of every consumer stuck on the cap: `tryAcquire` NEVER queues (see
   * the invariant above), so a task-runner turn refused a slot manages its
   * own retry entirely outside this module (task-runner.ts's `machineWaiting`
   * set, itself surfaced through `queue.json` and the task's own `reason` —
   * never through this field). Reading this as "how many things are waiting
   * on the machine cap right now" undercounts by exactly that population.
   */
  queued: number
}

export type LoadCap = {
  /**
   * Resolves once a slot is held — immediately when one is free, or once the
   * FIFO reaches this request. Never rejects.
   *
   * `signal`, when given, makes the WAIT itself interruptible: if it aborts
   * while this request is still parked in the FIFO, the request is REMOVED
   * from the queue (never handed a slot later that nobody would release —
   * that would be a permanent leak) and the promise resolves with a no-op
   * Release. Immediate grants (a free slot on the spot) are NOT affected by an
   * already-aborted signal: the caller owns a real slot either way and is
   * responsible for releasing it, same as `tryAcquire`.
   *
   * The safe contract (adversarial review round 3, MINEUR — the previous
   * wording invited a leak): a caller ALWAYS calls the returned `Release` in a
   * `finally`, real slot or no-op alike — the no-op is deliberately
   * inoffensive to call. Checking `signal.aborted` right after the await to
   * decide "a real slot or not, therefore call release() or not" is
   * INDECIDABLE: a real grant can land in the same tick as the caller's own
   * abort (a release already resolved the waiter before `onAbort` even runs —
   * see the resolver below), so `signal.aborted === true` does not tell "I was
   * let go without one" from "I got a real slot right as my own signal fired".
   * A caller that skips `release()` on that read leaks the slot for good.
   */
  acquire(kind: LoadCapKind, signal?: AbortSignal): Promise<Release>
  /**
   * Non-blocking: takes a free slot and returns its Release, or returns null
   * without ever joining the FIFO. The only call a caller may make BEFORE its
   * first `await` and still be certain of the answer.
   */
  tryAcquire(kind: LoadCapKind): Release | null
  /** Current occupation, for `task_meta` and for tests. */
  snapshot(): LoadCapSnapshot
  /**
   * Fires after EVERY release, whether or not the freed slot was handed
   * straight to a queued waiter. The runner's own queue (task-queue.ts) has
   * no seat in this module's FIFO — a task blocked on the machine cap is
   * still visibly `queued` in its project's own queue.json — so this is how
   * its `pump()` learns "try again", the same role `TaskSlotPool.pumps` used
   * to play before T1.2 made that pool inert. Returns an unsubscribe.
   */
  onSlotFreed(listener: () => void): () => void
}

/** D4's default: four heavy processes machine-wide, configurable via `maxConcurrentAgents`. */
export const DEFAULT_MAX_CONCURRENT_AGENTS = 4

/** Grants nothing and frees nothing: what an aborted wait resolves with. */
const NOOP_RELEASE: Release = () => {}

type Waiter = { resolve: (release: Release) => void }

/**
 * Builds one semaphore instance. Deliberately NOT a module-level singleton —
 * every caller (a runner under test, the real workspace) gets its own budget,
 * so two tests never share occupancy by accident and the real workspace's
 * single instance is built once and threaded through every consumer
 * (task-server.ts), exactly the injectable seam § 0.4 asks every I/O-adjacent
 * module to expose.
 */
export function createLoadCap(max: number = DEFAULT_MAX_CONCURRENT_AGENTS): LoadCap {
  let occupied = 0
  const queue: Waiter[] = []
  const freedListeners = new Set<() => void>()

  const notifyFreed = (): void => {
    for (const listener of freedListeners) {
      try {
        listener()
      } catch {
        // Observers only: one throwing must never stop the others from
        // learning a slot came back, nor unwind into the release itself.
      }
    }
  }

  const makeRelease = (): Release => {
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      const next = queue.shift()
      if (next) {
        // Handed straight to the head of the line: occupancy is unchanged,
        // the invariant ("queue non-empty implies occupied === max") holds.
        next.resolve(makeRelease())
      } else {
        occupied -= 1
      }
      notifyFreed()
    }
  }

  const tryAcquire = (_kind: LoadCapKind): Release | null => {
    // By the invariant above, occupied < max here implies the queue is
    // already empty — nothing is jumped.
    if (occupied >= max) {
      return null
    }
    occupied += 1
    return makeRelease()
  }

  return {
    tryAcquire,
    acquire(kind, signal) {
      const immediate = tryAcquire(kind)
      if (immediate) {
        // A real slot either way: an already-aborted signal does not un-grant
        // it, exactly like `tryAcquire` never asks. The caller is on the hook
        // to release it (its own post-await abort check settles that).
        return Promise.resolve(immediate)
      }
      if (signal?.aborted) {
        // Never join the FIFO for a request that is already cancelled: a
        // waiter nobody is still waiting for would sit there until SOME
        // unrelated release happened to reach it, then hold a slot forever
        // with nobody left to free it.
        return Promise.resolve(NOOP_RELEASE)
      }
      return new Promise<Release>((resolvePromise) => {
        // `settled` makes the two ways this promise can resolve — a real slot
        // handed to `waiter.resolve` by some future `release()`, or an abort
        // caught by `onAbort` below — mutually exclusive. Both are plain
        // synchronous callbacks with no `await` between "decide" and "act", so
        // there is no interleaving to race: whichever fires first wins, and
        // the guard only exists to make the SECOND one (should the caller's
        // signal fire a tick after a release already handed a real slot) a
        // no-op instead of a double resolution or a double queue-removal.
        let settled = false
        let removeAbortListener: () => void = () => {}
        const waiter: Waiter = {
          resolve: (release) => {
            if (settled) {
              return
            }
            settled = true
            removeAbortListener()
            resolvePromise(release)
          },
        }
        queue.push(waiter)
        if (signal) {
          const onAbort = (): void => {
            if (settled) {
              // A release already shifted this waiter out and handed it a
              // real slot (synchronously, no gap an abort could land in) —
              // that slot is the caller's now, to release like any other.
              return
            }
            settled = true
            const idx = queue.indexOf(waiter)
            if (idx !== -1) {
              // Still parked: pull it out. Leaving it in the FIFO would mean a
              // LATER release() hands a slot to a waiter nobody is awaiting
              // any more — occupied would climb and never come back down,
              // since the no-op Release below never frees it. A permanent
              // leak, for the one gesture (Ctrl-C) that most needs the
              // machine to recover cleanly.
              queue.splice(idx, 1)
            }
            resolvePromise(NOOP_RELEASE)
          }
          signal.addEventListener('abort', onAbort, { once: true })
          removeAbortListener = () => signal.removeEventListener('abort', onAbort)
        }
      })
    },
    snapshot: () => ({ occupied, max, queued: queue.length }),
    onSlotFreed(listener) {
      freedListeners.add(listener)
      return () => freedListeners.delete(listener)
    },
  }
}
