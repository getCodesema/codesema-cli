/**
 * The mechanical verification: a fresh VM from the project snapshot, the
 * ticket's worktree attached, `runbook.tests` replayed, `depends_on_files`
 * checked against the validated runbook. The agent's own claim never enters
 * the verdict. Lot C7 implements it.
 */
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { writeJsonAtomic } from './atomic-write.js'
import {
  isTaskId,
  sanitizeTaskVerification,
  TASK_CHECK_TAIL_MAX,
  type RunbookConfig,
  type TaskCheckResult,
  type TaskVerification,
} from './contract.js'
import { tryGit } from './git.js'
import {
  sandboxName,
  type SandboxDriver,
  type SandboxHandle,
  type SandboxSpec,
} from './microsandbox-driver.js'
import { SERVICE_LAUNCH_TIMEOUT_MS, serviceLaunchScript } from './runbook-services.js'
import { taskDir } from './tasks-store.js'

export type VerifyTaskOptions = {
  driver: SandboxDriver
  worktree: string
  projectId: string
  taskId: string
  headSha: string
  runbook: RunbookConfig
  /** sha (16 hex) the hub validated this runbook under. */
  runbookSha: string
  /** Repository commit the runbook was validated against; `depends_on_files` is diffed against this sha's blobs. */
  validatedSha: string
  /** Snapshot to restore; null means a cold boot from `runbook.image` + install. */
  snapshotName: string | null
  /** Per-test timeout. */
  timeoutMs: number
  onProgress?: (line: string) => void
  signal?: AbortSignal
  /** Wall-clock budget of a healthcheck retry loop before the verification errors out; default 60s. */
  healthcheckDeadlineMs?: number
  /** Delay between healthcheck retries; default 1s. */
  healthcheckRetryDelayMs?: number
  /** Best-effort browser proof capture, run after healthchecks pass and before `runbook.tests`; never affects the verdict. */
  captureProof?: (handle: SandboxHandle) => Promise<void>
}

const VERIFY_WORK_DIR = '/work'
const DEFAULT_HEALTHCHECK_DEADLINE_MS = 60_000
const DEFAULT_HEALTHCHECK_RETRY_DELAY_MS = 1_000

/**
 * Compares every `depends_on_files` entry of the worktree with the validated
 * runbook's own view of them (blob shas at `validatedSha`); returns the paths
 * that differ. An entry missing on either side counts as changed.
 */
export function changedDependencyFiles(
  worktree: string,
  runbook: RunbookConfig,
  validatedSha: string,
): string[] {
  const changed: string[] = []
  for (const file of runbook.depends_on_files) {
    const current = tryGit(['hash-object', '--', file], worktree)
    const validated = tryGit(['rev-parse', `${validatedSha}:${file}`], worktree)
    if (current === null || validated === null || current !== validated) {
      changed.push(file)
    }
  }
  return changed
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function maxDurationSeconds(runbook: RunbookConfig, timeoutMs: number): number {
  const steps =
    runbook.install.length +
    runbook.services.host_up.length +
    runbook.healthchecks.length +
    runbook.tests.length
  return Math.max(60, Math.ceil((timeoutMs * Math.max(1, steps + 1)) / 1000))
}

function errorVerdict(
  opts: Pick<VerifyTaskOptions, 'headSha' | 'runbookSha'>,
  startedAt: string,
  checks: TaskCheckResult[],
  error: string,
): TaskVerification {
  return {
    head_sha: opts.headSha,
    runbook_sha: opts.runbookSha,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    status: 'error',
    checks,
    integrity_ok: true,
    changed_dependency_files: [],
    error,
  }
}

export async function verifyTask(opts: VerifyTaskOptions): Promise<TaskVerification> {
  const startedAt = new Date().toISOString()
  const changed = changedDependencyFiles(opts.worktree, opts.runbook, opts.validatedSha)
  if (changed.length > 0) {
    return {
      head_sha: opts.headSha,
      runbook_sha: opts.runbookSha,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      status: 'refused',
      checks: [],
      integrity_ok: false,
      changed_dependency_files: changed,
      error: null,
    }
  }

  const name = sandboxName('verify', opts.taskId)
  const cold = opts.snapshotName === null
  const spec: SandboxSpec = {
    name,
    ...(cold ? { image: opts.runbook.image } : { fromSnapshot: opts.snapshotName as string }),
    cpus: 4,
    memoryMib: 4096,
    maxDurationSeconds: maxDurationSeconds(opts.runbook, opts.timeoutMs),
    // A cold boot needs the runbook's own egress to install; a warm snapshot
    // already carries its install, so a replay of `runbook.tests` never gets
    // network at all — the same discipline the checks engine holds for
    // non-install steps.
    network: { allowedDomains: cold ? opts.runbook.egress : [] },
  }

  let handle: SandboxHandle | null = null
  try {
    handle = await opts.driver.create(spec)
    opts.onProgress?.(`sandbox ${name} created`)
    await handle.copyFromHost(opts.worktree, VERIFY_WORK_DIR)

    if (cold) {
      for (const command of opts.runbook.install) {
        const result = await handle.shell(command, {
          timeoutMs: opts.timeoutMs,
          cwd: VERIFY_WORK_DIR,
          ...(opts.signal ? { signal: opts.signal } : {}),
        })
        if (result.timedOut || result.code !== 0) {
          return errorVerdict(
            opts,
            startedAt,
            [],
            `install step failed: ${command} (${(result.stdout + result.stderr).slice(-TASK_CHECK_TAIL_MAX)})`,
          )
        }
      }
    }

    for (let i = 0; i < opts.runbook.services.host_up.length; i += 1) {
      const command = opts.runbook.services.host_up[i] ?? ''
      const result = await handle.shell(serviceLaunchScript(command, i), {
        timeoutMs: SERVICE_LAUNCH_TIMEOUT_MS,
        cwd: VERIFY_WORK_DIR,
      })
      if (result.timedOut || result.code !== 0) {
        return errorVerdict(
          opts,
          startedAt,
          [],
          `service failed to start: ${command} (${(result.stdout + result.stderr).slice(-TASK_CHECK_TAIL_MAX)})`,
        )
      }
    }

    const healthcheckDeadlineMs = opts.healthcheckDeadlineMs ?? DEFAULT_HEALTHCHECK_DEADLINE_MS
    const healthcheckRetryDelayMs =
      opts.healthcheckRetryDelayMs ?? DEFAULT_HEALTHCHECK_RETRY_DELAY_MS
    for (const command of opts.runbook.healthchecks) {
      const deadline = Date.now() + healthcheckDeadlineMs
      let lastTail = ''
      let ok = false
      for (;;) {
        const result = await handle.shell(command, {
          timeoutMs: opts.timeoutMs,
          cwd: VERIFY_WORK_DIR,
          ...(opts.signal ? { signal: opts.signal } : {}),
        })
        if (!result.timedOut && result.code === 0) {
          ok = true
          break
        }
        lastTail = (result.stdout + result.stderr).slice(-TASK_CHECK_TAIL_MAX)
        if (Date.now() >= deadline) {
          break
        }
        await sleep(healthcheckRetryDelayMs)
      }
      if (!ok) {
        return errorVerdict(
          opts,
          startedAt,
          [],
          `healthcheck never passed: ${command} (${lastTail})`,
        )
      }
    }

    if (opts.captureProof) {
      await opts.captureProof(handle).catch(() => undefined)
    }

    const checks: TaskCheckResult[] = []
    for (const command of opts.runbook.tests) {
      const testStartedAt = Date.now()
      const result = await handle.shell(command, {
        timeoutMs: opts.timeoutMs,
        cwd: VERIFY_WORK_DIR,
        ...(opts.signal ? { signal: opts.signal } : {}),
      })
      checks.push({
        command,
        status: result.timedOut ? 'timeout' : result.code === 0 ? 'passed' : 'failed',
        exit_code: result.code,
        duration_ms: Date.now() - testStartedAt,
        tail: (result.stdout + result.stderr).slice(-TASK_CHECK_TAIL_MAX),
      })
    }
    const failed = checks.some((c) => c.status === 'failed' || c.status === 'timeout')
    return {
      head_sha: opts.headSha,
      runbook_sha: opts.runbookSha,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      status: failed ? 'failed' : 'passed',
      checks,
      integrity_ok: true,
      changed_dependency_files: [],
      error: null,
    }
  } catch (err) {
    return errorVerdict(opts, startedAt, [], err instanceof Error ? err.message : String(err))
  } finally {
    if (handle) {
      await opts.driver.destroy(name).catch(() => {})
    }
  }
}

/**
 * Latest mechanical verification of a task (.codesema/tasks/<id>/verification.json),
 * calque of `readTaskChecks` (tasks-store.ts). Null on unknown id, never-run
 * task, unreadable file or unusable content.
 */
export function readTaskVerification(cwd: string, id: string): TaskVerification | null {
  if (!isTaskId(id)) {
    return null
  }
  const path = join(taskDir(cwd, id), 'verification.json')
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
  return sanitizeTaskVerification(raw)
}

/**
 * Atomic rewrite of verification.json, calque of `writeTaskChecks`: one
 * verification per task, overwritten each run. Sanitized before writing so
 * the file on disk is always bounded; the sanitized copy is returned so the
 * caller broadcasts exactly what was persisted.
 */
export function writeTaskVerification(
  cwd: string,
  id: string,
  verification: TaskVerification,
): TaskVerification {
  if (!isTaskId(id)) {
    throw new Error(`invalid task id: ${id}`)
  }
  const clean = sanitizeTaskVerification(verification)
  if (!clean) {
    throw new Error('invalid task verification')
  }
  writeJsonAtomic(join(taskDir(cwd, id), 'verification.json'), clean)
  return clean
}

/** Erases a task's verification.json, same doctrine as `removeTaskChecks`. */
export function removeTaskVerification(cwd: string, id: string): void {
  if (!isTaskId(id)) {
    return
  }
  rmSync(join(taskDir(cwd, id), 'verification.json'), { force: true })
}
