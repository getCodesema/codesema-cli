// Checks engine: codesema (never the agent) verifies a task's worktree by
// running typecheck/tests/lint inside an EPHEMERAL container mounted on it.
// The agent gains no execution rights — the runner commits, then this engine
// runs the repo's checks in a cage: worktree mounted rw and nothing else, no
// network for check commands, cpu/memory capped, one timeout per check.
// Everything host-side goes through execFile with an argv array: no shell
// interpolation ever happens on the host (the check command itself runs under
// `sh -lc` INSIDE the container, where it can do no harm beyond the mount).
// V1 debt: node_modules live in the worktree (no shared cache volume yet), so
// every run reinstalls dependencies.

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TASK_CHECK_TAIL_MAX, type TaskCheckResult, type TaskChecks } from './contract.js'
import type { ChecksConfig } from './repo-config.js'

/** Per-check wall-clock budget when the repo config does not set one. */
export const DEFAULT_CHECK_TIMEOUT_SECONDS = 300
/** Image used when an explicit config sets commands but no image. */
export const DEFAULT_CHECKS_IMAGE = 'node:22'

/** Combined stdout+stderr capture cap per exec (the persisted tail is far smaller). */
const EXEC_MAX_BUFFER = 10 * 1024 * 1024

export type ExecResult = {
  /** Exit code; null when the process never exited on its own (timeout, spawn failure). */
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** Spawn-level failure message (binary missing, EACCES...), null otherwise. */
  failure: string | null
}

/** Host-side process runner, injectable in tests (unit tests NEVER run docker). */
export type ExecFn = (
  file: string,
  args: string[],
  opts: { timeoutMs: number },
) => Promise<ExecResult>

/**
 * Real exec: execFile only (argv array, no shell), host env inherited — the
 * docker/podman CLIENT needs it (DOCKER_HOST, XDG_RUNTIME_DIR for rootless
 * podman); the CONTAINER still starts from the image's own minimal env
 * because no -e flag ever forwards host variables. Never rejects: every
 * failure mode is folded into the ExecResult.
 */
const defaultExec: ExecFn = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: opts.timeoutMs, killSignal: 'SIGKILL', maxBuffer: EXEC_MAX_BUFFER },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ code: 0, stdout, stderr, timedOut: false, failure: null })
          return
        }
        const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null }
        if (e.killed || e.signal) {
          // execFile kills with killSignal on timeout (and on maxBuffer
          // overflow — close enough to a runaway check to report the same).
          resolve({ code: null, stdout, stderr, timedOut: true, failure: null })
          return
        }
        if (typeof e.code === 'number') {
          resolve({ code: e.code, stdout, stderr, timedOut: false, failure: null })
          return
        }
        // String code (ENOENT...) = the process never ran.
        resolve({ code: null, stdout, stderr, timedOut: false, failure: e.message })
      },
    )
  })

/** 'docker' first (the common case, and podman ships a docker shim), then 'podman'. */
export async function detectContainerRuntime(execFn: ExecFn): Promise<string | null> {
  for (const bin of ['docker', 'podman']) {
    const probe = await execFn(bin, ['--version'], { timeoutMs: 10_000 })
    if (probe.code === 0) {
      return bin
    }
  }
  return null
}

let cachedRuntime: Promise<string | null> | null = null

/** Detection runs ONCE per process for the real exec; injected execFns (tests) always re-probe. */
function containerRuntime(execFn?: ExecFn): Promise<string | null> {
  if (execFn) {
    return detectContainerRuntime(execFn)
  }
  cachedRuntime ??= detectContainerRuntime(defaultExec)
  return cachedRuntime
}

/** What one checks run will do; null = nothing detected/configured ('unconfigured'). */
export type ChecksPlan = {
  image: string
  /** Dependency install step, run first; the only step that may get network. */
  install: string | null
  commands: string[]
  /** True: the INSTALL step runs with network; check commands NEVER do. */
  network: boolean
  timeoutSeconds: number
}

export type DetectChecksInput = {
  /** Top-level entry names of the worktree (plain readdir). */
  files: string[]
  /** Parsed package.json when present. */
  packageJson?: { scripts?: Record<string, unknown> } | null
  /** Raw pyproject.toml content when present. */
  pyproject?: string | null
}

const CHECK_SCRIPT_NAMES = ['typecheck', 'test', 'lint'] as const

function scriptNames(packageJson: DetectChecksInput['packageJson']): Set<string> {
  const scripts = packageJson?.scripts
  if (!scripts || typeof scripts !== 'object') {
    return new Set()
  }
  return new Set(Object.keys(scripts))
}

/**
 * PURE stack detection from a worktree listing. Detected plans grant the
 * install step network access (a registry-less install cannot succeed on a
 * fresh worktree); explicit config keeps its own network flag. Precedence:
 * bun, then npm/yarn lockfiles, then pyproject — first match wins.
 */
export function detectChecks(input: DetectChecksInput): ChecksPlan | null {
  const files = new Set(input.files)
  const scripts = scriptNames(input.packageJson)
  const base = { network: true, timeoutSeconds: DEFAULT_CHECK_TIMEOUT_SECONDS }
  if (files.has('bun.lock') || files.has('bun.lockb')) {
    const commands: string[] = []
    if (scripts.has('typecheck')) {
      commands.push('bun run typecheck')
    }
    // bun has a built-in test runner: a missing test script is not "no tests".
    commands.push(scripts.has('test') ? 'bun run test' : 'bun test')
    if (scripts.has('lint')) {
      commands.push('bun run lint')
    }
    return { image: 'oven/bun:1', install: 'bun install --frozen-lockfile', commands, ...base }
  }
  if (files.has('package-lock.json') || files.has('yarn.lock')) {
    const commands = CHECK_SCRIPT_NAMES.filter((name) => scripts.has(name)).map(
      (name) => `npm run ${name}`,
    )
    // npm has no runnable default: no scripts among the three = nothing to check.
    if (commands.length === 0) {
      return null
    }
    return { image: 'node:22', install: 'npm ci', commands, ...base }
  }
  if (files.has('pyproject.toml')) {
    // Only when the project itself declares pytest; guessing a test runner
    // for an arbitrary python project would fail more than it helps.
    if (!/\bpytest\b/.test(input.pyproject ?? '')) {
      return null
    }
    return { image: 'python:3.12', install: 'pip install -e .', commands: ['pytest'], ...base }
  }
  return null
}

/** Explicit config → plan. Commands are the essence: none = unconfigured. */
export function planFromConfig(config: ChecksConfig): ChecksPlan | null {
  const commands = (config.commands ?? []).filter((command) => command.trim() !== '')
  if (commands.length === 0) {
    return null
  }
  return {
    image: config.image?.trim() || DEFAULT_CHECKS_IMAGE,
    install: config.install ?? null,
    commands,
    network: config.network === true,
    timeoutSeconds:
      Number.isInteger(config.timeoutSeconds) && (config.timeoutSeconds as number) > 0
        ? (config.timeoutSeconds as number)
        : DEFAULT_CHECK_TIMEOUT_SECONDS,
  }
}

/** Disk-reading wrapper around the pure detectChecks; any read failure = unconfigured. */
export function detectChecksFromWorktree(worktree: string): ChecksPlan | null {
  let files: string[]
  try {
    files = readdirSync(worktree)
  } catch {
    return null
  }
  const readIfPresent = (name: string): string | null => {
    if (!files.includes(name)) {
      return null
    }
    try {
      return readFileSync(join(worktree, name), 'utf8')
    } catch {
      return null
    }
  }
  let packageJson: { scripts?: Record<string, unknown> } | null = null
  const rawPackageJson = readIfPresent('package.json')
  if (rawPackageJson) {
    try {
      packageJson = JSON.parse(rawPackageJson) as { scripts?: Record<string, unknown> } | null
    } catch {
      packageJson = null
    }
  }
  return detectChecks({ files, packageJson, pyproject: readIfPresent('pyproject.toml') })
}

export type RunChecksOptions = {
  /** The task's worktree — the ONLY host path the container ever sees. */
  worktree: string
  /** Explicit repo config; null/absent falls back to auto-detection. */
  config?: ChecksConfig | null
  /** Worktree HEAD stamped on the result (recorded, never executed). */
  headSha: string
  /**
   * Progress snapshots: fired once with the initial 'running' state and again
   * after each completed step. The FINAL state is only returned, never fired —
   * the caller persists/broadcasts both, without double writes.
   */
  onUpdate?: (snapshot: TaskChecks) => void
  /** Test seam; the default drives the real docker/podman via execFile. */
  execFn?: ExecFn
}

type StepOutcome = { result: TaskCheckResult; hardError: string | null }

type RunStepInput = {
  exec: ExecFn
  runtime: string
  step: { command: string; network: boolean }
  plan: ChecksPlan
  worktree: string
}

/** One containerized step. Kills the container on timeout (killing the client alone leaves it running). */
async function runStep(input: RunStepInput): Promise<StepOutcome> {
  const { exec, runtime, step, plan, worktree } = input
  // A unique name so a timed-out container can be killed by name; --rm reaps it.
  const name = `codesema-checks-${randomBytes(6).toString('hex')}`
  const args = [
    'run',
    '--rm',
    '--name',
    name,
    '-v',
    `${worktree}:/work:rw`,
    '-w',
    '/work',
    ...(step.network ? [] : ['--network', 'none']),
    '--cpus',
    '2',
    '--memory',
    '2g',
    plan.image,
    'sh',
    '-lc',
    step.command,
  ]
  const startedAt = Date.now()
  const run = await exec(runtime, args, { timeoutMs: plan.timeoutSeconds * 1000 })
  const duration_ms = Date.now() - startedAt
  // Interleaving is lost across the two pipes; stdout-then-stderr keeps the
  // stderr end (where compilers put the verdict) inside the bounded tail.
  const tail = (run.stdout + run.stderr).slice(-TASK_CHECK_TAIL_MAX)
  if (run.timedOut) {
    // Best-effort: the docker client died but the container is still running.
    void exec(runtime, ['kill', name], { timeoutMs: 10_000 }).catch(() => {})
    return {
      result: { command: step.command, status: 'timeout', exit_code: null, duration_ms, tail },
      hardError: null,
    }
  }
  if (run.failure !== null) {
    return {
      result: { command: step.command, status: 'failed', exit_code: null, duration_ms, tail },
      hardError: run.failure,
    }
  }
  return {
    result: {
      command: step.command,
      status: run.code === 0 ? 'passed' : 'failed',
      exit_code: run.code,
      duration_ms,
      tail,
    },
    hardError: null,
  }
}

/**
 * Runs the plan sequentially in ephemeral containers and returns the final
 * TaskChecks (never rejects: engine problems become status 'error' with a
 * readable message). An install failure skips every remaining step (nothing
 * can pass on a broken environment); a failing CHECK does not — later checks
 * still run so one run reports everything.
 */
export async function runChecks(opts: RunChecksOptions): Promise<TaskChecks> {
  const snapshot: TaskChecks = {
    head_sha: opts.headSha,
    started_at: new Date().toISOString(),
    finished_at: null,
    status: 'running',
    checks: [],
    error: null,
  }
  const finish = (status: TaskChecks['status'], error: string | null = null): TaskChecks => ({
    ...snapshot,
    status,
    error,
    finished_at: new Date().toISOString(),
  })
  const plan = opts.config ? planFromConfig(opts.config) : detectChecksFromWorktree(opts.worktree)
  if (!plan) {
    return finish('unconfigured')
  }
  opts.onUpdate?.({ ...snapshot })
  const runtime = await containerRuntime(opts.execFn)
  if (!runtime) {
    return finish(
      'error',
      'no container runtime found: install docker or podman to run checks in a sandbox',
    )
  }
  const exec = opts.execFn ?? defaultExec
  const steps = [
    ...(plan.install ? [{ command: plan.install, network: plan.network, install: true }] : []),
    ...plan.commands.map((command) => ({ command, network: false, install: false })),
  ]
  let skipRest = false
  let hardError: string | null = null
  for (const step of steps) {
    if (skipRest) {
      snapshot.checks.push({
        command: step.command,
        status: 'skipped',
        exit_code: null,
        duration_ms: 0,
        tail: '',
      })
      continue
    }
    const { result, hardError: failure } = await runStep({
      exec,
      runtime,
      step,
      plan,
      worktree: opts.worktree,
    })
    snapshot.checks.push(result)
    if (failure !== null) {
      // Spawn-level breakage (runtime vanished mid-run): the rest cannot run.
      hardError = failure
      skipRest = true
    } else if (step.install && result.status !== 'passed') {
      skipRest = true
    }
    opts.onUpdate?.({ ...snapshot, checks: [...snapshot.checks] })
  }
  if (hardError !== null) {
    return finish('error', hardError)
  }
  const failed = snapshot.checks.some((c) => c.status === 'failed' || c.status === 'timeout')
  return finish(failed ? 'failed' : 'passed')
}
