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

export function git(args: string[], cwd: string): string {
  try {
    // stderr captured, not inherited: failing probes don't pollute the output
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: subprocessEnv(),
    }).trimEnd()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(t('git.notFound'), { cause: err })
    }
    throw err
  }
}

export function tryGit(args: string[], cwd: string): string | null {
  try {
    return git(args, cwd)
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

export function repoRoot(cwd: string): string {
  return git(['rev-parse', '--show-toplevel'], cwd)
}

export function currentBranch(cwd: string): string {
  return git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
}

export function refExists(ref: string, cwd: string): boolean {
  return tryGit(['rev-parse', '--verify', '--quiet', ref], cwd) !== null
}

export function mergeBase(a: string, b: string, cwd: string): string | null {
  return tryGit(['merge-base', a, b], cwd)
}

export function headSha(cwd: string, ref = 'HEAD'): string {
  return git(['rev-parse', ref], cwd)
}

export function isAncestor(a: string, b: string, cwd: string): boolean {
  return tryGit(['merge-base', '--is-ancestor', a, b], cwd) !== null
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

/** Best-effort forge guess from the origin remote URL, used to skip an irrelevant CLI probe. */
export function detectForgeHint(cwd: string): ForgeHint {
  const remote = (tryGit(['remote', 'get-url', 'origin'], cwd) ?? '').toLowerCase()
  if (remote.includes('github')) {
    return 'github'
  }
  if (remote.includes('gitlab')) {
    return 'gitlab'
  }
  return 'unknown'
}
