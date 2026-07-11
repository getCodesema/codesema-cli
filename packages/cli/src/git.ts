import { execFileSync } from 'node:child_process'

export function git(args: string[], cwd: string): string {
  try {
    // stderr captured, not inherited: failing probes don't pollute the output
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trimEnd()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('git not found on PATH — install git (https://git-scm.com) and retry')
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

/** Optional external command (gh, glab): null if missing, failing, or too slow. */
export function tryExec(cmd: string, args: string[], cwd: string): string | null {
  try {
    return execFileSync(cmd, args, { cwd, encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
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
  if (out === null) return null
  const n = Number(out)
  return Number.isFinite(n) ? n : null
}
