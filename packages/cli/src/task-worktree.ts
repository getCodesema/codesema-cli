// Git worktree lifecycle for agent tasks: one worktree + one branch per task,
// kept under <repo>/.codesema/worktrees/<task-id>/ (NOT a tmpdir like the MR
// review worktrees) so an interrupted task survives a reboot and can be
// resumed. The parent .codesema/ directory auto-gitignores itself.
//
// DOCTRINE (T1.6): the branch is the deliverable even of a run that failed.
// A worktree is disposable — it is a checkout, rebuilt on demand from the
// branch it names — but a branch that carries a commit of the agent's own is
// the one place that work survives once the checkout is gone. Every function
// here that can make a branch disappear (renameTaskBranch, removeTaskWorktree)
// is read against that rule by its caller: a branch is never deleted, and
// never renamed, without saying so out loud when the attempt is refused or
// when a caller chooses to keep one that carries work.

import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { listWorktrees } from './branches.js'
import { ensureWorkDir, taskWorktreesDir } from './config.js'
import { git, refExists, tryGit } from './git.js'
import { t } from './i18n.js'
import { resolveRef, targetFromOriginHead } from './prep.js'
import {
  acquireWorktreeLock,
  WorktreeLockBusyError,
  type WorktreeLockHandle,
} from './worktree-lock.js'

/** Same candidates and order as prep's target detection heuristic. */
const BASE_CANDIDATES = ['develop', 'main', 'master'] as const

/**
 * ONE identity per branch: 'origin/develop' and 'develop' are the same branch
 * (the remote-tracking ref is transport, not identity). Every branch name a
 * task records or a caller sends is normalized to the SHORT name; resolution
 * back to a concrete ref prefers the local head, then origin.
 */
export function shortBranchName(name: string): string {
  return name.startsWith('origin/') ? name.slice('origin/'.length) : name
}

/** Concrete start ref for a short branch name: local head first, then origin. Null when neither exists. */
export function resolveBranchRef(cwd: string, name: string): string | null {
  if (refExists(`refs/heads/${name}`, cwd)) {
    return `refs/heads/${name}`
  }
  if (refExists(`refs/remotes/origin/${name}`, cwd)) {
    return `refs/remotes/origin/${name}`
  }
  return null
}

/**
 * Where a task's worktree would live, WITHOUT the task-id half — that id is
 * minted by `createTask` and does not exist while a task is only being
 * previewed, which is why the dry-run plan announces the parent directory
 * (T2.6). Re-exported from config.ts, its home since the worktree LOCK turned
 * out to need the same directory and could not import this module (a cycle:
 * this one imports the lock).
 */
export { taskWorktreesDir }

export function taskWorktreePath(cwd: string, taskId: string): string {
  return join(taskWorktreesDir(cwd), taskId)
}

const SLUG_MAX = 40

/** Every branch this tool FORKS for a task starts with it; work-on branches never do. */
export const TASK_BRANCH_PREFIX = 'codesema/task-'

/**
 * The dots and dashes a slug may carry, trimmed to what git accepts in a ref
 * component (git check-ref-format): no leading dot or dash, no '..' run, and
 * no trailing dot, dash or '.lock'. A title ending in a period — "donne-moi
 * des idees pour mon jeu." — otherwise built a branch name git refused
 * outright, failing `git worktree add` before the task ever started.
 */
function refSafeEnds(s: string): string {
  let out = s.replace(/\.{2,}/g, '.').replace(/^[.-]+/, '')
  // Each pass shortens `out`, so this terminates (worst case, on '').
  while (/[.-]$/.test(out) || out.endsWith('.lock')) {
    out = out.replace(/[.-]+$|\.lock$/, '')
  }
  return out
}

/** Same slugging as review archive names (record.ts), with 'task' as last resort. */
export function slug(s: string): string {
  const full = refSafeEnds(
    s
      // NFKD + strip combining marks: "Réponds" → "reponds", not "r-ponds".
      .normalize('NFKD')
      .replace(/\p{M}+/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-'),
  )
  if (full.length <= SLUG_MAX) {
    return full || 'task'
  }
  // Titles are free-form prose: cap the branch name, cutting on a word when one
  // fits, mid-word for a single overlong token.
  const cut = full.slice(0, SLUG_MAX + 1)
  const atDash = cut.lastIndexOf('-')
  return refSafeEnds(atDash > 0 ? cut.slice(0, atDash) : full.slice(0, SLUG_MAX)) || 'task'
}

/**
 * Base ref a new task branches from. A task has no current branch to compare
 * against, so the forge probe and merge-base heuristic of prep's detectTarget
 * don't apply: origin/HEAD names the repo default branch, then the usual
 * candidates (local first, origin/ fallback via resolveRef).
 */
export function detectTaskBase(cwd: string): string {
  const fromHead = targetFromOriginHead(cwd)
  if (fromHead) {
    // origin/HEAD names 'origin/<default>': the record keeps the SHORT identity.
    return shortBranchName(fromHead.target)
  }
  for (const name of BASE_CANDIDATES) {
    const ref = resolveRef(name, cwd)
    if (ref) {
      return shortBranchName(ref)
    }
  }
  throw new Error(t('task.noBase'))
}

/** How many `-n` collision suffixes are tried before the task id is used. */
const BRANCH_SUFFIX_MAX = 99

/** The branch name a fork WOULD take, and whether that name can be promised. */
export type PlannedBranch = {
  /** codesema/task-<slug>, suffixed -2, -3… past a collision. */
  branch: string
  /**
   * True when every `-2`…`-99` suffix is already taken, so `freeBranchName`
   * falls back to appending the task's own id — an id a dry-run cannot know.
   * `branch` is then the family the real branch will belong to, NOT the branch:
   * a caller that ANNOUNCES it must say so rather than promise a name it
   * cannot back.
   */
  collisions_exhausted: boolean
}

/**
 * READ-ONLY name resolution for a forked task branch: enumerates the existing
 * refs, creates none. This is the one place the collision rule lives, called
 * by `freeBranchName` on the materialization path and by the dry-run plan
 * (T2.6) — so "same input, same branch" is a property of construction rather
 * than two implementations that happen to agree today.
 */
export function plannedTaskBranch(cwd: string, title: string): PlannedBranch {
  const wanted = `${TASK_BRANCH_PREFIX}${slug(title)}`
  if (!refExists(`refs/heads/${wanted}`, cwd)) {
    return { branch: wanted, collisions_exhausted: false }
  }
  for (let n = 2; n <= BRANCH_SUFFIX_MAX; n++) {
    const candidate = `${wanted}-${n}`
    if (!refExists(`refs/heads/${candidate}`, cwd)) {
      return { branch: candidate, collisions_exhausted: false }
    }
  }
  return { branch: wanted, collisions_exhausted: true }
}

/**
 * codesema/task-<slug>, suffixed -2, -3… when an earlier task already took the
 * name (the branch outlives its task until shipped or abandoned). The task id
 * is the unconditionally-unique last resort.
 */
function freeBranchName(cwd: string, taskId: string, title: string): string {
  const planned = plannedTaskBranch(cwd, title)
  return planned.collisions_exhausted ? `${planned.branch}-${taskId}` : planned.branch
}

/**
 * Base a FORK starts from, resolved without creating anything: the caller's
 * explicit base when it names an existing branch (local OR origin — same
 * identity), otherwise the detected trunk. Throws exactly what
 * `createForkWorktree` throws, and for the same reason: a typo must leave the
 * repo untouched and be reported before any directory or ref exists.
 *
 * Shared by the materialization and by the dry-run plan (T2.6) so the two can
 * never disagree on where a task branches from.
 */
export function resolveForkBase(cwd: string, base?: string): { base: string; startPoint: string } {
  // 'origin/x' and 'x' are ONE branch; the full-ref qualification inside
  // `resolveBranchRef` also neutralizes option-lookalike names ('-evil').
  //
  // ONE existence check, not two. `createForkWorktree` used to test the
  // explicit base first and the resolved start point again afterwards, with
  // the directory creation between them — the first check was what kept a
  // typo from conjuring `.codesema/worktrees` under the repo. Nothing is
  // created here, so the two tests are the same test on the same string
  // (measured: mutating the first one away leaves the whole suite green,
  // because the second catches it identically). Keeping both would be a guard
  // no behaviour depends on, which is the kind of line a later refactor
  // deletes without ever learning what it was for.
  const explicitBase = base !== undefined ? shortBranchName(base) : undefined
  const resolved = explicitBase ?? detectTaskBase(cwd)
  const startPoint = resolveBranchRef(cwd, resolved)
  if (startPoint === null) {
    throw new Error(t('task.unknownBase', { base: resolved }))
  }
  return { base: resolved, startPoint }
}

/**
 * Why `renameTaskBranch` refused, named for the caller's journal — never
 * silent (T1.6). `not_a_fork` is unreachable from `adoptBranchProposal`
 * today (it only calls this for a non-work-on task, whose branch is always
 * `codesema/task-*` by construction) — kept because the PRIMITIVE has to
 * answer correctly for any caller, present or future, not because this one
 * exercises it.
 */
export type RenameRefusalReason =
  /** Not a codesema/task-* fork: a work-on conversation works on the USER's branch. */
  | 'not_a_fork'
  /** The proposal slugs to nothing usable at all (slug()'s last resort, 'task'). */
  | 'unusable_proposal'
  /** The proposal slugs to the name the branch ALREADY has — nothing to rename. */
  | 'already_named'
  /** Published under refs/remotes/origin/<branch>: an MR may already point at it. */
  | 'already_pushed'
  /** `git branch -m` itself refused (a lock, a filesystem permission, a race). */
  | 'git_refused'

export type RenameBranchResult =
  | { renamed: true; branch: string }
  | { renamed: false; reason: RenameRefusalReason; current: string }

/**
 * Renames a task's FORKED branch to the name the agent proposed on its first
 * turn (the slugged title it was created with says what you typed, not what
 * the task turned out to be — and that name becomes the MR source branch).
 * `git branch -m` keeps the linked worktree's HEAD on the branch, so the task
 * keeps working in place under its new name.
 *
 * Refused, NAMED, in every case where the current name is not ours to change:
 * a branch that is not a codesema/task-* fork (a work-on conversation works on
 * the USER's branch — the caller also checks record.work_on), a branch
 * already pushed (its name is published, an MR may point at it), an unusable
 * proposal, or a git refusal. The reason and the name that stayed are always
 * in the return value — the caller decides whether and how to journal it
 * (T1.6, design.md D-B: this module keeps no journal of its own) — because a
 * cosmetic rename is never worth failing a turn over, but a refusal that
 * nobody can see is exactly the kind of silence this ticket exists to close.
 */
export function renameTaskBranch(
  cwd: string,
  taskId: string,
  current: string,
  proposal: string,
): RenameBranchResult {
  if (!current.startsWith(TASK_BRANCH_PREFIX)) {
    return { renamed: false, reason: 'not_a_fork', current }
  }
  const wanted = slug(proposal)
  // 'task' is slug()'s last resort: nothing usable was in the proposal at all.
  if (wanted === 'task') {
    return { renamed: false, reason: 'unusable_proposal', current }
  }
  // A proposal that slugs to the current name has nothing to rename — a very
  // ORDINARY case (the agent re-proposing the title it already has), not an
  // unusable one. Asking freeBranchName for it would only invent a pointless
  // '-2' suffix.
  if (`${TASK_BRANCH_PREFIX}${wanted}` === current) {
    return { renamed: false, reason: 'already_named', current }
  }
  // Published name: an MR (or a plain push) already refers to this branch.
  // Renaming here would strand the remote ref under the old name.
  if (refExists(`refs/remotes/origin/${current}`, cwd)) {
    return { renamed: false, reason: 'already_pushed', current }
  }
  const next = freeBranchName(cwd, taskId, proposal)
  return tryGit(['branch', '-m', current, next], cwd) === null
    ? { renamed: false, reason: 'git_refused', current }
    : { renamed: true, branch: next }
}

export type TaskWorktree = {
  branch: string
  worktree: string
  base: string
  /**
   * Commit the agent's work is measured FROM: the sha of the point the
   * worktree starts at, resolved BEFORE it is materialized. No commit is ever
   * created for it — the baseline is a fact about where the conversation
   * began, not an artifact — so `baseline..HEAD` is empty the instant the
   * worktree is handed out and holds exactly the agent's work afterwards.
   */
  baseline: string
  /**
   * True when THIS materialization brought the local branch head into
   * existence (every fork, and a work-on conversation on a branch that only
   * existed on origin). False when it adopted a branch that was already there:
   * deleting that one is never ours to decide.
   */
  created_branch: boolean
  /**
   * Uncommitted files in the MAIN repo when the worktree was materialized.
   * They are NOT carried over — the agent starts from `baseline` — and the
   * caller must say so once rather than let the human assume otherwise.
   */
  uncommitted_files: number
  /**
   * Set only when the repo lock had to be taken from a holder whose pid was
   * still alive, past the pid-recycling grace (worktree-lock.ts). A degradation
   * the caller states out loud — the alternative was a repository wedged until
   * a human deleted the lock file by hand.
   */
  lock_stolen?: { pid: number; age_ms: number }
}

/** What a worktree materialization knows on its own, before the repo-wide facts are added. */
type MaterializedWorktree = Omit<TaskWorktree, 'uncommitted_files' | 'lock_stolen'>

/**
 * Thrown when a work-on branch is already checked out in another worktree
 * (the MAIN worktree counts): git refuses the second checkout, and the HTTP
 * layer must render this as a 409, not a 500.
 */
export class BranchInUseError extends Error {
  readonly branch: string
  /** Worktree currently holding the branch. */
  readonly worktreePath: string

  constructor(message: string, branch: string, worktreePath: string) {
    super(message)
    this.name = 'BranchInUseError'
    this.branch = branch
    this.worktreePath = worktreePath
  }
}

/** Path of the worktree `branch` is checked out in (the MAIN worktree counts), null when free. */
export function branchCheckoutPath(cwd: string, branch: string): string | null {
  return listWorktrees(cwd).find((wt) => wt.branch === branch)?.path ?? null
}

/**
 * Work-on mode: checks the EXISTING branch itself out in the task's worktree —
 * no derived branch, the agent's commits land directly on refs/heads/<branch>.
 * Validation order matters: the unknown-branch check has no side effects, then
 * only the task's OWN stale directory (a crashed earlier run of this task id)
 * is cleaned before the in-use check — pruning it may be exactly what frees
 * the branch — and nothing else is created before both checks pass.
 */
function createWorkOnWorktree(cwd: string, taskId: string, branch: string): MaterializedWorktree {
  // The refs/heads/ qualification neutralizes option-lookalike names ('-evil').
  let created = false
  if (!refExists(`refs/heads/${branch}`, cwd)) {
    // Same branch, remote-only so far (a teammate's MR never pulled): create
    // the local tracking head — that IS the branch, origin/ was transport.
    if (refExists(`refs/remotes/origin/${branch}`, cwd)) {
      // --track wants a configured remote; an exotic setup (or a bare
      // remote-tracking ref) still deserves the branch — minus the upstream.
      if (tryGit(['branch', '--track', branch, `origin/${branch}`], cwd) === null) {
        git(['branch', branch, `refs/remotes/origin/${branch}`], cwd)
      }
      // The conversation brought this head into existence: whoever decides
      // later whether it may be deleted needs to know that, and cannot infer
      // it from the branch itself.
      created = true
    } else {
      throw new Error(t('task.unknownBranch', { branch }))
    }
  }
  const worktree = taskWorktreePath(cwd, taskId)
  // Unconditional: a crashed run may have left the directory (remove drops
  // it) OR only a dangling git registration of a deleted directory (prune
  // drops that) — either would keep the branch looking checked out.
  tryGit(['worktree', 'remove', '--force', worktree], cwd)
  tryGit(['worktree', 'prune'], cwd)
  const takenBy = branchCheckoutPath(cwd, branch)
  if (takenBy) {
    throw new BranchInUseError(t('task.branchInUse', { branch, path: takenBy }), branch, takenBy)
  }
  // .codesema/ must exist self-gitignored before git materializes anything in it.
  ensureWorkDir(cwd)
  mkdirSync(taskWorktreesDir(cwd), { recursive: true })
  // Resolved BEFORE the checkout exists: the conversation's anchor is where
  // the branch stood when it took it over, and nothing that happens next can
  // move that fact.
  const baseline = git(['rev-parse', `refs/heads/${branch}`], cwd)
  git(['worktree', 'add', worktree, branch], cwd)
  // base is the caller's concern in work-on mode (the MR target, kept on the
  // record by the server): this layer only knows the branch.
  return { branch, worktree, base: '', baseline, created_branch: created }
}

/**
 * Fork mode: creates the task's branch from the base and checks it out in a
 * fresh worktree. The base is either the caller's explicit LOCAL branch
 * (opts.base, validated to exist before anything is created on disk) or the
 * detected default (detectTaskBase). -b always creates a NEW branch
 * (collisions get a numeric suffix), so this never steals a branch checked out
 * elsewhere.
 */
function createForkWorktree(
  cwd: string,
  taskId: string,
  title: string,
  base?: string,
): MaterializedWorktree {
  // Base and start point are resolved BEFORE any directory or ref is created:
  // a typo (or a repo with no trunk at all) must leave the repo untouched.
  // Same call the dry-run plan makes, so the two can never disagree.
  const { base: resolvedBase, startPoint } = resolveForkBase(cwd, base)
  // .codesema/ must exist self-gitignored before git materializes anything in it.
  ensureWorkDir(cwd)
  mkdirSync(taskWorktreesDir(cwd), { recursive: true })
  const branch = freeBranchName(cwd, taskId, title)
  const worktree = taskWorktreePath(cwd, taskId)
  // Unconditional, for the same reason as the work-on path: a crashed run may
  // have left the DIRECTORY (remove drops it) or only a dangling git
  // registration of a directory that is already gone (prune drops that).
  // Guarding this on existsSync only handles the first, and the second fails
  // the add just as hard — a task whose worktree vanished could never be
  // rebuilt.
  tryGit(['worktree', 'remove', '--force', worktree], cwd)
  tryGit(['worktree', 'prune'], cwd)
  // Resolved BEFORE the worktree exists: the anchor is the start point itself,
  // a commit that already exists and that nothing downstream can move.
  const baseline = git(['rev-parse', startPoint], cwd)
  git(['worktree', 'add', '-b', branch, worktree, startPoint], cwd)
  // A fork always brings its branch into existence, by construction (-b).
  return { branch, worktree, base: resolvedBase, baseline, created_branch: true }
}

/**
 * Files the MAIN repo is carrying uncommitted (modified, staged or untracked)
 * right now. They do NOT travel into the task worktree — the agent starts from
 * a committed point — and the caller states that once, out loud, rather than
 * leaving the human to discover it from a diff that lacks their work.
 */
function countUncommitted(cwd: string): number {
  const status = tryGit(['status', '--porcelain'], cwd)
  return status?.trim() ? status.trim().split('\n').length : 0
}

/**
 * How the repo's worktree lock is taken. The signal is not decoration: a human
 * interrupting a task queued behind another repo operation must be obeyed at
 * once, not after the whole waiting budget.
 */
export type WorktreeLockFn = (
  cwd: string,
  signal?: AbortSignal | undefined,
) => Promise<WorktreeLockHandle>

const defaultLockFn: WorktreeLockFn = (cwd, signal) => acquireWorktreeLock(cwd, { signal })

export type CreateTaskWorktreeOptions = {
  base?: string
  branch?: string
  /** Gives up the wait for the repo lock as soon as the caller is interrupted. */
  signal?: AbortSignal | undefined
  /** Test seam: the repo lock the whole creation runs under. */
  lockFn?: WorktreeLockFn | undefined
}

/**
 * Materializes the task's worktree and hands it out with its BASELINE: the sha
 * of the point it starts from, resolved before the worktree exists. Nothing is
 * committed, nothing is written on any branch — the baseline is a fact, not an
 * artifact — so `baseline..HEAD` starts empty and afterwards holds exactly what
 * the agent did, on a work-on conversation as much as on a fork.
 *
 * The main repo's UNCOMMITTED work is deliberately not carried over: it stays
 * private, in the checkout where the human left it. What travels instead is the
 * count, so the caller can say so once — an agent silently starting from a
 * different state than the one on screen is the kind of surprise this tool
 * exists to remove.
 *
 * opts.branch (exclusive with opts.base) is work-on mode: the conversation
 * works DIRECTLY on that existing branch — see createWorkOnWorktree. A branch
 * checked out anywhere else throws BranchInUseError before anything is created.
 *
 * The whole creation runs under the repo's worktree lock: `worktree add` writes
 * the repo's git index, and a concurrent creation or abandon from another
 * codesema process would race it. Waiting for that lock never blocks the event
 * loop, which is why this is async.
 */
export async function createTaskWorktree(
  cwd: string,
  taskId: string,
  title: string,
  opts: CreateTaskWorktreeOptions = {},
): Promise<TaskWorktree> {
  const lock = await (opts.lockFn ?? defaultLockFn)(cwd, opts.signal)
  try {
    const uncommitted = countUncommitted(cwd)
    const made =
      opts.branch !== undefined
        ? createWorkOnWorktree(cwd, taskId, shortBranchName(opts.branch))
        : createForkWorktree(cwd, taskId, title, opts.base)
    return {
      ...made,
      uncommitted_files: uncommitted,
      ...(lock.stolen ? { lock_stolen: { pid: lock.stolen.pid, age_ms: lock.stolen.ageMs } } : {}),
    }
  } finally {
    lock.release()
  }
}

/**
 * Best-effort cleanup (pattern of the MR review runner): a failed removal must
 * never turn the caller's outcome into an error. The branch is only deleted on
 * explicit abandon — a shipped task keeps its branch.
 *
 * Serialized behind the same repo lock as the creation: `worktree remove`
 * writes the same git index. A lock that cannot be taken WITHIN ITS BUDGET
 * does not cancel the cleanup — waiting that long means the holder is stuck,
 * and a worktree stranded forever is worse than an unserialized removal, which
 * git's own index lock still guards. That fallback is REPORTED, never silent:
 * the caller gets `serialized: false` with the holder it lost to, and says so
 * where it can be read. Any other lock failure is a real fault and propagates.
 */
export type WorktreeRemoval = {
  /**
   * Did the worktree ACTUALLY go away?
   *
   * T1.9 review round 4, MAJEUR 2: this used to be unknowable — the
   * `git worktree remove --force` below is a `tryGit`, whose null return was
   * thrown away, so every caller was told `{serialized:true}` whether git had
   * succeeded or refused. Two realistic refusals: a `git worktree lock`, and
   * a file owned by root that a rootful containerized turn wrote into the
   * worktree and the host user cannot unlink (EACCES). Under either, a caller
   * that also drops the task record — retention does exactly that — leaves a
   * worktree on disk that NO record names any more: a permanent orphan no
   * future pass can find, which is precisely the disk space the pass existed
   * to reclaim.
   *
   * True also when there was nothing to remove (the path is already gone):
   * "the worktree is not there" is the outcome callers act on, and a git
   * failure on a worktree that no longer exists is not a failure to remove
   * it.
   */
  worktree_removed: boolean
  /** False when the cleanup ran without the repo lock (its wait ran out). */
  serialized: boolean
  /** Pid that was holding the lock, when the wait ran out. */
  holder_pid?: number
  /** How long that holder had been holding, in ms. */
  holder_age_ms?: number
  /** Same degradation as TaskWorktree.lock_stolen, on the removal side. */
  lock_stolen?: { pid: number; age_ms: number }
}

/**
 * The primitive `abandon()` decides on (T1.6, design.md D-A): does `branch`
 * still stand exactly on `anchor`, the commit its conversation started from?
 * Equal means no commit of the task's own sits on it — the branch is
 * disposable exactly like the worktree. Anything else — the tip moved, the
 * branch is gone, or the caller could not even name an anchor — answers TRUE:
 * "cannot prove this branch is empty" and "provably carries work" get the
 * same, safe answer, because the doctrine above only lets a branch go once
 * its emptiness is certain.
 *
 * Both sides are resolved to their OBJECT id with `^{commit}` before they are
 * compared — never compared as the raw strings they arrived as. `baseline_sha`
 * is stored ABBREVIATED (7 to 64 hex chars, `BASELINE_SHA_RE` in the
 * contract): a string comparison against `rev-parse`'s always-full sha would
 * never match, so every task whose anchor happens to be stored short would
 * read as carrying a commit it never made — the exact false "has own commits"
 * this primitive exists to rule out.
 */
export function branchHasOwnCommits(cwd: string, branch: string, anchor: string | null): boolean {
  if (anchor === null) {
    return true
  }
  const anchorObj = tryGit(['rev-parse', `${anchor}^{commit}`], cwd)
  const tip = tryGit(['rev-parse', `refs/heads/${branch}^{commit}`], cwd)
  return anchorObj === null || tip === null || tip !== anchorObj
}

export async function removeTaskWorktree(
  cwd: string,
  taskId: string,
  branch: string,
  // No signal here on purpose: an abandon has no controller to be cancelled
  // by, and a half-removed worktree is not a state worth offering. Only the
  // CREATION is abortable, because a human interrupting a task that is still
  // queueing for the lock must be obeyed at once.
  opts: { deleteBranch: boolean; lockFn?: WorktreeLockFn | undefined },
): Promise<WorktreeRemoval> {
  let lock: WorktreeLockHandle | null = null
  let lockState: Omit<WorktreeRemoval, 'worktree_removed'> = { serialized: true }
  try {
    lock = await (opts.lockFn ?? defaultLockFn)(cwd)
    if (lock.stolen) {
      lockState = {
        serialized: true,
        lock_stolen: { pid: lock.stolen.pid, age_ms: lock.stolen.ageMs },
      }
    }
  } catch (err) {
    // ONLY a wait that ran out is survivable here. Anything else (an
    // unwritable .codesema, a bug) is a real fault and must reach the caller
    // rather than be swallowed into an unserialized removal.
    if (!(err instanceof WorktreeLockBusyError)) {
      throw err
    }
    lockState = { serialized: false, holder_pid: err.pid, holder_age_ms: err.ageMs }
  }
  const path = taskWorktreePath(cwd, taskId)
  let removed: boolean
  try {
    // The one call whose outcome a caller may not assume (see
    // WorktreeRemoval.worktree_removed). `tryGit` answers null on refusal;
    // the disk has the last word, because git also fails when there is
    // nothing left to remove — an already-gone worktree IS removed.
    removed = tryGit(['worktree', 'remove', '--force', path], cwd) !== null || !existsSync(path)
    tryGit(['worktree', 'prune'], cwd)
    if (opts.deleteBranch && branch) {
      tryGit(['branch', '-D', branch], cwd)
    }
  } finally {
    lock?.release()
  }
  return { ...lockState, worktree_removed: removed }
}
