import { execFile, execFileSync } from 'node:child_process'
import { t } from './i18n.js'

// Set by git itself on the hooks it invokes (this CLI's own pre-commit/pre-push,
// or any enclosing process's), these redirect every git call below away from
// `cwd` and onto whatever repo set them. `cwd` is the only intended source of
// truth here, so exactly these must never propagate. Deliberately NOT a blanket
// GIT_*: user settings like GIT_SSH_COMMAND, GIT_AUTHOR_*/GIT_COMMITTER_* or
// GIT_CONFIG_GLOBAL are legitimate and must reach the subprocess unchanged.
const REPO_LOCATION_ENV_VARS = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_QUARANTINE_PATH',
])

export function subprocessEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => !REPO_LOCATION_ENV_VARS.has(key)),
  )
}

/**
 * Optional per-call budget. Deliberately NOT a default on every git call: the
 * repository's git commands include commits that run the user's own hooks and
 * pushes that talk to a forge, and killing those on a timer would break work
 * that is merely slow. It exists for the callers that run UNATTENDED and can
 * hang on something outside git itself — a suspended network mount under a
 * worktree makes `git status` block forever, which would stall a boot pass
 * nobody is watching with nothing said. Those callers set it explicitly.
 */
export type GitCallOptions = { timeoutMs?: number | undefined }

export function git(args: string[], cwd: string, opts: GitCallOptions = {}): string {
  try {
    // stderr captured, not inherited: failing probes don't pollute the output
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: subprocessEnv(),
      ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
    }).trimEnd()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(t('git.notFound'), { cause: err })
    }
    throw err
  }
}

export function tryGit(args: string[], cwd: string, opts: GitCallOptions = {}): string | null {
  try {
    return git(args, cwd, opts)
  } catch {
    return null
  }
}

/**
 * Budget of ONE probe of an optional external CLI (gh, glab, an agent binary).
 * Shared by tryExec and tryExecAsync: parallelising the boot must not shorten
 * an individual probe, it only stops the probes from queueing behind each other.
 */
export const PROBE_TIMEOUT_MS = 8000

/** Optional external command (gh, glab): null if missing, failing, or too slow. */
export function tryExec(cmd: string, args: string[], cwd: string): string | null {
  try {
    return execFileSync(cmd, args, {
      cwd,
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: subprocessEnv(),
    }).trim()
  } catch {
    return null
  }
}

/**
 * Signature every boot probe is injected through in tests: no test ever runs a
 * real forge or agent binary, it asserts on the argv it was handed.
 */
export type ProbeExecFn = (cmd: string, args: string[], cwd: string) => Promise<string | null>

/**
 * Non-blocking sibling of tryExec, same semantics (null when the binary is
 * missing, fails, or exceeds PROBE_TIMEOUT_MS) and same per-probe budget.
 * It exists because execFileSync makes tryExec structurally sequential: boot
 * probes can only overlap through an async spawn. argv only, never a shell
 * string — no host-side interpolation.
 */
export function tryExecAsync(cmd: string, args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd, encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, env: subprocessEnv() },
      (err, stdout) => {
        resolve(err ? null : stdout.trim())
      },
    )
  })
}

/**
 * Non-blocking sibling of `tryGit` (T2.4, round-2 adversarial review, majeur
 * 5): a plain git read (`remote get-url origin`, say) has no timeout at all
 * on the synchronous path and, worse, `execFileSync` blocks the WHOLE
 * process for its duration — fine for a single call, but fatal to a
 * concurrency-limited pool that means to run several of these at once (each
 * sync call would serialize the others back into a straight line, and a repo
 * whose working tree sits on a dead network mount would freeze the process
 * outright, event loop included). Bounded by the same `PROBE_TIMEOUT_MS`
 * `tryExecAsync` already uses, and same semantics as `tryGit`: `null` on
 * anything that is not a clean, timely read — missing binary, non-zero exit,
 * or the bound exceeded. argv only, never a shell string.
 */
export function tryGitAsync(
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
        env: subprocessEnv(),
        ...(signal ? { signal } : {}),
      },
      (err, stdout) => {
        resolve(err ? null : stdout.trimEnd())
      },
    )
  })
}

export function repoRoot(cwd: string): string {
  return git(['rev-parse', '--show-toplevel'], cwd)
}

export function currentBranch(cwd: string): string {
  return git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
}

/**
 * `opts` exists for the UNATTENDED callers `GitCallOptions` was written for
 * (T3.6): the merge gate reads three refs per auto-shipped turn from inside
 * the workspace process, where an unbounded `execFileSync` on a repository
 * sitting on a suspended network mount freezes the event loop — SSE, HTTP and
 * every other project with it — for as long as the mount stays down. Default
 * unchanged (no bound) for the interactive callers.
 */
export function refExists(ref: string, cwd: string, opts: GitCallOptions = {}): boolean {
  return tryGit(['rev-parse', '--verify', '--quiet', ref], cwd, opts) !== null
}

export function mergeBase(a: string, b: string, cwd: string): string | null {
  return tryGit(['merge-base', a, b], cwd)
}

export function headSha(cwd: string, ref = 'HEAD'): string {
  return git(['rev-parse', ref], cwd)
}

/** Same `opts` contract as `refExists` above: bounded on demand, unbounded by default. */
export function isAncestor(a: string, b: string, cwd: string, opts: GitCallOptions = {}): boolean {
  return tryGit(['merge-base', '--is-ancestor', a, b], cwd, opts) !== null
}

export function revListCount(range: string, cwd: string): number | null {
  const out = tryGit(['rev-list', '--count', range], cwd)
  if (out === null) {
    return null
  }
  const n = Number(out)
  return Number.isFinite(n) ? n : null
}

export type ForgeHint = 'github' | 'gitlab' | 'unknown'

/**
 * The hint rule itself, on a URL that has ALREADY been read. Split out of
 * `detectForgeHint` (T2.7 round-2, majeur 3) because a caller that already
 * holds the origin URL — the workspace probe reads it to answer "is there an
 * origin at all" — must not spawn a second `git remote get-url` to learn the
 * same thing, and must not re-implement the rule either: two ladders that
 * disagree about which CLI a repo needs is exactly the drift the header was
 * announcing.
 */
export function forgeHintOfUrl(url: string): ForgeHint {
  const remote = url.toLowerCase()
  if (remote.includes('github')) {
    return 'github'
  }
  if (remote.includes('gitlab')) {
    return 'gitlab'
  }
  return 'unknown'
}

/**
 * Best-effort forge guess from the origin remote URL, used to skip an
 * irrelevant CLI probe. `opts` for the same reason as `refExists`: the merge
 * gate calls this from the workspace process, and a read that cannot return is
 * a workspace that cannot answer.
 */
export function detectForgeHint(cwd: string, opts: GitCallOptions = {}): ForgeHint {
  return forgeHintOfUrl(tryGit(['remote', 'get-url', 'origin'], cwd, opts) ?? '')
}
