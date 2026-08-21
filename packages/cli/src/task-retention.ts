// Retention of TERMINATED tasks (T1.9): a project's task store grows forever
// otherwise — every shipped/failed task keeps its full worktree AND its
// .codesema/tasks/<id>/ directory, neither of which is ever removed anywhere
// else (ship never touches the worktree; abandon removes ITS OWN task's
// worktree but a shipped task's worktree survives untouched). Retention keeps
// the N most recently updated terminated tasks per project exactly as they
// are, and PURGES the rest: worktree, HOME volume, and the task's own
// directory (task.json, events.jsonl, checks.json).
//
// Established on purpose (design.md Risk 3, verified against the actual code
// before this file existed): the purge DOES remove the task directory, not
// only the worktree. That is precisely why its outcome is never journaled
// through appendTaskEvent (DP9) — see removeTaskDir's own doc comment for the
// mkdirSync proof. Everything this module does is reported through the
// caller's notice channel instead.
//
// DP16 (T1.6 > T1.9): the worktree removal underneath this pass is
// `git worktree remove --force`, and `--force` is exactly what makes it
// destructive — it discards uncommitted changes rather than refusing on
// them. Before it runs, this pass reads `git status --porcelain` on the
// worktree; a dirty one is left standing, named, never purged (see
// `uncommittedCount` below). An automatic pass nobody asked to run at this
// moment must not be more destructive than an explicit human abandon.

import { statSync } from 'node:fs'
import { type TaskRecord } from './contract.js'
import { tryGit } from './git.js'
import { agentHomeVolume, releaseAgentHome, type IsolationExecFn } from './task-isolation.js'
import { removeTaskWorktree, type WorktreeLockFn, type WorktreeRemoval } from './task-worktree.js'
import { listTasks, removeTaskDir } from './tasks-store.js'

/**
 * Historical default, chosen for consistency with the OTHER V1 retention
 * bound already in the codebase: MR review archives are capped at 20 per
 * branch (record.ts). Configurable via `taskRetentionCount` — see config.ts —
 * so nothing here forces a workspace to keep exactly this many.
 */
export const DEFAULT_TASK_RETENTION = 20

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * Budget of the ONE git call this pass makes before deciding to destroy
 * something. Generous — a large worktree's status is not instant — but
 * finite: this runs at boot with nobody watching it.
 */
const STATUS_TIMEOUT_MS = 60_000

/** Statuses eligible for retention: the terminal ones, and ONLY those. */
function isTerminated(record: TaskRecord): boolean {
  return record.status === 'shipped' || record.status === 'failed'
}

/**
 * DP16 (T1.6 > T1.9, project/03-ecarts/openspec/DECISIONS.md): retention is
 * unattended background housekeeping nobody asked for AT THIS MOMENT, and
 * `removeTaskWorktree` below runs `git worktree remove --force` — the one
 * operation in this whole pass that can destroy data no other copy holds. A
 * turn whose commit failed (missing git identity, a rejected hook, the
 * process dying mid-turn — exactly the case T1.6 made retrievable by naming
 * `worktree` and `branch` on the error event) leaves real work sitting
 * uncommitted in the worktree, and `deleteBranch: false` protects only the
 * BRANCH: nothing protects what never made it onto a commit. This reads the
 * worktree's status BEFORE that removal, never after.
 *
 * Returns `null`, never a guess, when the status could not be determined at
 * all: a `git status` failure that is NOT simply "the worktree is already
 * gone" (which `statSync` rules out first, and answers with a clean 0 — there
 * is nothing left to protect). A destructive pass that cannot prove a
 * worktree is clean does not get to assume it is — same doctrine as Risque 1's
 * "an inventory we could not read completely forbids the sweep rather than
 * widening it" (design.md).
 *
 * T1.9 review round 4, CRITIQUE: the question this asks git has a
 * USER-CONFIGURABLE answer, and its two dangerous settings are both
 * documented, common on large repositories, and silent.
 * `status.showUntrackedFiles=no` makes `git status --porcelain` say NOTHING
 * about untracked files — which is exactly the T1.6 case this guard exists
 * for, a commit that failed leaving behind files the agent never got to
 * `git add`. `diff.ignoreSubmodules=all` hides a submodule's uncommitted
 * content the same way. Read as an empty status, either one turns this guard
 * into a rubber stamp for `--force`. `--untracked-files=all` and
 * `--ignore-submodules=none` override both on the command line (verified on
 * git 2.53.0), and `-uall` additionally counts untracked files ONE BY ONE
 * instead of folding a whole directory into a single entry, so the count the
 * notice reports is the number of files actually at stake.
 *
 * The `statSync` (rather than `existsSync`) shape is the round-3 critique's
 * own rule, applied here too: only ENOENT/ENOTDIR mean "there is nothing
 * left to protect". Every other stat error — EACCES on a parent, an
 * unmounted path, an EIO — is "could not find out", and must reach the
 * caller as `null` rather than as a clean 0 that clears the way for
 * `--force`.
 */
function uncommittedCount(worktree: string): number | null {
  try {
    statSync(worktree)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return 0
    }
    return null
  }
  const status = tryGit(
    ['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'],
    worktree,
    // Unattended pass: a worktree sitting on a hung mount would otherwise
    // block the whole boot housekeeping forever, with nothing said. A budget
    // that runs out surfaces as `null` — "could not determine" — which keeps
    // the worktree, exactly like any other unreadable status.
    { timeoutMs: STATUS_TIMEOUT_MS },
  )
  if (status === null) {
    return null
  }
  return status.trim() ? status.trim().split('\n').length : 0
}

export type TaskRetentionOptions = {
  /** Main repo root of the project this retention pass applies to. */
  cwd: string
  /** How many of the most-recently-updated terminated tasks survive untouched. */
  keep: number
  /** Test seams — production drives the real IsolationExecFn / worktree lock. */
  execFn?: IsolationExecFn
  worktreeLockFn?: WorktreeLockFn
}

export type TaskRetentionOutcome = {
  /** Task ids fully purged: worktree removed, HOME volume released (when relevant), directory gone. */
  purged: string[]
  /** One readable line per purge and per failure, for the caller's notice channel — never a task journal. */
  notices: string[]
}

/**
 * Applies retention to ONE project. Tasks are sorted by `updated_at`
 * (listTasks' own order, most recent first): the first `keep` terminated
 * ones are left exactly as they are, everything past that is purged.
 *
 * Active and 'interrupted' (possibly reprenable) tasks are never candidates
 * at all — `isTerminated` excludes them BEFORE the keep/purge split, so a
 * task with pending resume never loses its worktree to this pass regardless
 * of how far it sorts behind the retention window (spec requirement: active
 * and reprenable tasks are always spared).
 *
 * Never throws: a worktree that cannot be removed for one task is reported
 * and that task is skipped (its directory is left standing too — a partial
 * purge that dropped the record while the worktree lingered would orphan a
 * worktree with no task.json to explain it), the pass continues with the
 * rest. "Cannot be removed" covers both ways it happens: an exception on the
 * way to the removal, and — since T1.9 review round 4, MAJEUR 2 — a
 * `git worktree remove --force` git simply REFUSED.
 */
export async function applyTaskRetention(
  opts: TaskRetentionOptions,
): Promise<TaskRetentionOutcome> {
  const terminated = listTasks(opts.cwd).filter(isTerminated)
  const beyond = terminated.slice(opts.keep)
  const purged: string[] = []
  const notices: string[] = []
  for (const record of beyond) {
    // DP16: read BEFORE the destructive `--force` removal below, never after.
    const dirty = uncommittedCount(record.worktree)
    if (dirty === null) {
      notices.push(
        `task ${record.id}: worktree kept, its git status could not be determined — left untouched`,
      )
      continue
    }
    if (dirty > 0) {
      notices.push(`task ${record.id}: worktree kept, it carries ${dirty} uncommitted change(s)`)
      continue
    }
    let removal: WorktreeRemoval
    try {
      removal = await removeTaskWorktree(opts.cwd, record.id, record.branch, {
        // T1.9 review round 1, Critique 4: retention is AUTOMATIC, unattended
        // background housekeeping, not an explicit human abandon — it has no
        // way to know whether a branch carries a real commit worth keeping,
        // and design.md never asked it to delete branches at all. The
        // worktree alone is what recovers the disk space this pass exists
        // for; the branch is always left standing, unconditionally, whether
        // or not this conversation created it.
        deleteBranch: false,
        ...(opts.worktreeLockFn ? { lockFn: opts.worktreeLockFn } : {}),
      })
    } catch (err) {
      notices.push(
        `task ${record.id}: retention could not remove its worktree (${errorMessage(err)}) — left untouched`,
      )
      continue
    }
    // T1.9 review round 4, MAJEUR 2: `git worktree remove --force` can be
    // REFUSED — a `git worktree lock`, or a file a rootful containerized turn
    // wrote as root that this host user cannot unlink — and removeTaskWorktree
    // used to swallow that. Purging the record on top of a worktree still
    // standing turns it into a PERMANENT orphan: no record names it any more,
    // so no future retention pass will ever look at it again, and the disk
    // space this whole pass exists to reclaim is lost for good. Same shape as
    // the `removeTaskDir` failure a few lines below: skip the task entirely,
    // keep its directory, name it, and let the next boot try again.
    if (!removal.worktree_removed) {
      notices.push(
        `task ${record.id}: its worktree could not be removed — task kept, retried on the next pass`,
      )
      continue
    }
    // Same degradations task-runner's own abandon() names rather than lets
    // ride silently: a removal that went ahead without the repo lock, or one
    // that ran behind a stolen lock. Retention keeps no per-task journal (see
    // the file-level comment: appendTaskEvent would resurrect a directory
    // this same pass may be about to remove), so both are said on the notice
    // line instead — the only channel this module has.
    let lockNote = ''
    if (removal.lock_stolen) {
      lockNote += ` (its worktree lock had been stolen from pid ${removal.lock_stolen.pid}, held ${Math.round(removal.lock_stolen.age_ms / 1000)}s)`
    }
    if (!removal.serialized) {
      lockNote += ` (worktree removal proceeded WITHOUT the repo lock — held by pid ${removal.holder_pid ?? 0} for ${Math.round((removal.holder_age_ms ?? 0) / 1000)}s)`
    }
    let volumeNote = ''
    if (record.isolation === 'container') {
      const release = await releaseAgentHome({
        taskId: record.id,
        ...(opts.execFn ? { execFn: opts.execFn } : {}),
      })
      volumeNote = release.released
        ? `, HOME volume ${agentHomeVolume(record.id)} released`
        : `, HOME volume ${agentHomeVolume(record.id)} NOT released (${release.reason === 'no-runtime' ? 'no container runtime detected' : release.detail})`
    }
    // T1.9 review round 1, Majeur 1: removeTaskDir's boolean is the only
    // signal that the directory actually went away — a task-traversal-shaped
    // id, an EACCES, a lingering open handle all return false rather than
    // throw (see its own doc comment), and reporting "task directory
    // removed" regardless would be exactly the kind of notice invariant 2
    // forbids: one that says a resource is gone when it is not. `purged`
    // (and the id this pass will never look at again next run) is reserved
    // for the case that actually happened.
    const dirRemoved = removeTaskDir(opts.cwd, record.id)
    if (dirRemoved) {
      purged.push(record.id)
      notices.push(
        `task ${record.id}: worktree removed${volumeNote}, task directory removed (beyond the ${opts.keep} most recent terminated tasks kept)${lockNote}`,
      )
    } else {
      notices.push(
        `task ${record.id}: worktree removed${volumeNote}, but its task directory could NOT be removed — left standing, retried on the next pass${lockNote}`,
      )
    }
  }
  return { purged, notices }
}
