import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import type { TaskRecord } from './contract.js'
import { tryGit } from './git.js'
import type { ExecFn, ExecResult } from './task-checks.js'
import { replayChecksOnDefaultBranch, type GitExecFn } from './task-post-merge-checks.js'

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' })
}

const tempDirs: string[] = []

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * origin (bare) + a clone with `main` pushed, then a further LOCAL-ONLY
 * commit on `cwd`'s own `main` that is never pushed: `mainSha` is the tip
 * BEFORE that local drift, so a test can prove the replay reflects what was
 * FETCHED from origin, not the caller's own local state.
 */
function setupRepo(): { origin: string; cwd: string; mainSha: string } {
  const origin = mkdtempSync(join(tmpdir(), 'codesema-postmerge-origin-'))
  tempDirs.push(origin)
  git(['init', '--bare', '-b', 'main', origin], origin)

  const cwd = mkdtempSync(join(tmpdir(), 'codesema-postmerge-cwd-'))
  tempDirs.push(cwd)
  git(['init', '-b', 'main', cwd], cwd)
  git(['config', 'user.email', 'a@b.c'], cwd)
  git(['config', 'user.name', 'Test'], cwd)
  git(['remote', 'add', 'origin', origin], cwd)
  writeFileSync(join(cwd, 'bun.lock'), '')
  writeFileSync(join(cwd, 'a.txt'), 'base\n')
  git(['add', '.'], cwd)
  git(['commit', '-m', 'init'], cwd)
  git(['push', 'origin', 'main'], cwd)
  const mainSha = execFileSync('git', ['rev-parse', 'main'], { cwd, encoding: 'utf8' }).trim()

  writeFileSync(join(cwd, 'a.txt'), 'local-only\n')
  git(['commit', '-am', 'local only, never pushed'], cwd)

  return { origin, cwd, mainSha }
}

function fakeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const now = new Date().toISOString()
  return {
    version: 1,
    id: 'abcdef123456',
    title: 'a task',
    status: 'shipped',
    base: 'main',
    branch: 'codesema/task-a',
    worktree: '/nowhere/worktree',
    agent_session_id: null,
    turns: [],
    review_ref: null,
    work_ms: 0,
    wait_ms: 0,
    auto_ship: true,
    work_on: false,
    isolation: 'policy',
    created_at: now,
    updated_at: now,
    ...overrides,
  }
}

function worktreeCount(cwd: string): number {
  return (tryGit(['worktree', 'list', '--porcelain'], cwd) ?? '')
    .split('\n\n')
    .filter((s) => s.trim()).length
}

const ok = (over: Partial<ExecResult> = {}): ExecResult => ({
  code: 0,
  stdout: '',
  stderr: '',
  timedOut: false,
  failure: null,
  ...over,
})

type Call = { file: string; args: string[]; timeoutMs: number }

function fakeExec(respond: (call: Call) => ExecResult): { calls: Call[]; exec: ExecFn } {
  const calls: Call[] = []
  const exec: ExecFn = (file, args, opts) => {
    const call = { file, args, timeoutMs: opts.timeoutMs }
    calls.push(call)
    return Promise.resolve(respond(call))
  }
  return { calls, exec }
}

/** Rule: docker exists; every other step (install, checks) answers ok. */
function dockerRig() {
  return fakeExec((call) => {
    if (call.args[0] === '--version') {
      return call.file === 'docker' ? ok({ stdout: 'Docker version 27' }) : ok({ code: 1 })
    }
    return ok()
  })
}

const failingFetch: GitExecFn = (args) => {
  if (args[0] === 'fetch') {
    throw new Error('could not resolve host')
  }
  throw new Error(`unexpected git call in this test: ${args.join(' ')}`)
}

const throwingExec: ExecFn = () => {
  throw new Error('engine vanished mid-probe')
}

describe('replayChecksOnDefaultBranch', () => {
  test('a fetch that cannot reach the remote resolves to null and touches no worktree', async () => {
    const { cwd } = setupRepo()

    const result = await replayChecksOnDefaultBranch({
      cwd,
      task: fakeTask(),
      target: 'main',
      gitExecFn: failingFetch,
    })

    expect(result).toBeNull()
    expect(worktreeCount(cwd)).toBe(1)
  })

  test('fetches the target, runs checks in a disposable worktree at the FETCHED sha, and cleans up', async () => {
    const { cwd, mainSha } = setupRepo()
    const { calls, exec } = dockerRig()

    const result = await replayChecksOnDefaultBranch({
      cwd,
      task: fakeTask({ id: 'aaaaaaaaaaaa' }),
      target: 'main',
      execFn: exec,
    })

    expect(result?.status).toBe('passed')
    // The caller's own LOCAL main has an extra, never-pushed commit (see
    // setupRepo): a head_sha equal to mainSha proves this replay ran on what
    // was FETCHED from origin, not on local state.
    expect(result?.head_sha).toBe(mainSha)

    const testRun = calls.find((c) => c.args.at(-1) === 'bun test')
    expect(testRun).toBeDefined()
    const mountArg = testRun?.args[(testRun.args.indexOf('-v') ?? -1) + 1] ?? ''
    expect(mountArg.startsWith(`${join(tmpdir(), 'codesema-postmerge-aaaaaaaaaaaa-')}`)).toBe(true)

    expect(worktreeCount(cwd)).toBe(1)
  })

  test('the disposable worktree is torn down even when runChecks itself throws', async () => {
    const { cwd } = setupRepo()

    const result = await replayChecksOnDefaultBranch({
      cwd,
      task: fakeTask(),
      target: 'main',
      execFn: throwingExec,
    })

    expect(result).toBeNull()
    expect(worktreeCount(cwd)).toBe(1)
  })

  test('an unresolvable target branch resolves to null rather than throwing', async () => {
    const { cwd } = setupRepo()

    const result = await replayChecksOnDefaultBranch({
      cwd,
      task: fakeTask(),
      target: 'no-such-branch',
    })

    expect(result).toBeNull()
    expect(worktreeCount(cwd)).toBe(1)
  })
})
