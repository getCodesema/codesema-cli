// Repo-local pidfile for the runner daemon (D21): <cwd>/.codesema/runner.pid,
// distinct from the machine-wide <globalConfigDir()>/workspace.lock
// (workspace-lock.ts). The two answer different questions: the workspace
// lock guarantees ONE workspace process per machine, while this file just
// lets `codesema runner stop`/`runner status`, run later from a different
// process, find the daemon this repo is running, whether it was started
// attached (`codesema runner serve`, a systemd unit) or detached (`--detach`).
//
// Same self-healing doctrine as workspace-lock.ts: a pid nothing is holding
// anymore (a crash, or a SIGKILL with no shutdown handler run) is never a
// permanent blocker. Unlike the workspace lock there is no "acquire" step to
// steal: writing always overwrites, and callers that read a dead pid clean
// up the file themselves (see runner-commands.ts's `runnerStop`/`runnerStatus`).

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type RunnerPidfile = { pid: number; port: number; started_at: string }

export function runnerPidfilePath(cwd: string): string {
  return join(cwd, '.codesema', 'runner.pid')
}

function legacyPidfilePath(cwd: string): string {
  return join(cwd, '.codesema', 'brain.pid')
}

// Pre-rename `brain.pid` is migrated to `runner.pid` on first access; failure leaves the legacy file in place.
function migrateLegacyPidfile(cwd: string): void {
  const legacyPath = legacyPidfilePath(cwd)
  const path = runnerPidfilePath(cwd)
  if (existsSync(legacyPath) && !existsSync(path)) {
    try {
      renameSync(legacyPath, path)
    } catch {
      // Best-effort: an unwritable directory just leaves the legacy file in place.
    }
  }
}

/** Parsed pidfile, or null when absent/corrupt (both mean: nothing holds it). */
export function readRunnerPidfile(cwd: string): RunnerPidfile | null {
  migrateLegacyPidfile(cwd)
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(runnerPidfilePath(cwd), 'utf8'))
  } catch {
    return null
  }
  const pidfile = raw as { pid?: unknown; port?: unknown; started_at?: unknown } | null
  if (
    !pidfile ||
    !Number.isInteger(pidfile.pid) ||
    !Number.isInteger(pidfile.port) ||
    typeof pidfile.started_at !== 'string'
  ) {
    return null
  }
  return {
    pid: pidfile.pid as number,
    port: pidfile.port as number,
    started_at: pidfile.started_at,
  }
}

export function writeRunnerPidfile(cwd: string, pid: number, port: number): void {
  migrateLegacyPidfile(cwd)
  const path = runnerPidfilePath(cwd)
  mkdirSync(dirname(path), { recursive: true })
  const content: RunnerPidfile = { pid, port, started_at: new Date().toISOString() }
  writeFileSync(path, `${JSON.stringify(content)}\n`)
}

/**
 * Removes the pidfile iff it still names `expectedPid`: defaults to our own
 * pid, the shutdown-handler case (mirrors `WorkspaceLockHandle.release()`).
 * `runnerStop`/`runnerStatus` pass the pid they just found dead instead: those
 * run in a THIRD process, so `process.pid` would never match, and the check
 * still guards against unlinking a fresh pidfile a new daemon wrote in the
 * gap between that read and this delete. Never throws.
 */
export function removeRunnerPidfile(cwd: string, expectedPid: number = process.pid): void {
  try {
    const path = runnerPidfilePath(cwd)
    if (readRunnerPidfile(cwd)?.pid === expectedPid && existsSync(path)) {
      unlinkSync(path)
    }
  } catch {
    // Best-effort: a dead pid in a leftover pidfile is cleaned up next time
    // runnerStop/runnerStatus reads it, or overwritten by the next boot anyway.
  }
}
