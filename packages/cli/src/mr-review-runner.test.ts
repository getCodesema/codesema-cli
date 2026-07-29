import { afterAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ForgeMr, ForgeMrsResult } from './forge-mrs.js'
import { tryGit } from './git.js'
import { createMrReviewRunner } from './mr-review-runner.js'
import { createSession } from './serve.js'

const REVIEW = '{"verdict":"approve","summary":"ok","findings":[]}'

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' })
}

const tempDirs: string[] = []

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

/** origin (bare) + a clone with a `main` branch and a `feature/x` branch pushed to origin. */
function setupMrRepo(): { origin: string; cwd: string; mr: ForgeMr } {
  const origin = mkdtempSync(join(tmpdir(), 'codesema-mr-origin-'))
  tempDirs.push(origin)
  git(['init', '--bare', '-b', 'main', origin], origin)

  const cwd = mkdtempSync(join(tmpdir(), 'codesema-mr-cwd-'))
  tempDirs.push(cwd)
  git(['init', '-b', 'main', cwd], cwd)
  git(['config', 'user.email', 'a@b.c'], cwd)
  git(['config', 'user.name', 'Test'], cwd)
  git(['remote', 'add', 'origin', origin], cwd)
  writeFileSync(join(cwd, 'a.txt'), 'base\n')
  git(['add', '.'], cwd)
  git(['commit', '-m', 'init'], cwd)
  git(['push', 'origin', 'main'], cwd)

  git(['checkout', '-b', 'feature/x'], cwd)
  writeFileSync(join(cwd, 'a.txt'), 'changed\n')
  git(['commit', '-am', 'feat: change'], cwd)
  git(['push', 'origin', 'feature/x'], cwd)
  git(['checkout', 'main'], cwd)

  const mr: ForgeMr = {
    number: 1,
    title: 'feat: change',
    author: 'test',
    sourceBranch: 'feature/x',
    targetBranch: 'main',
    updatedAt: new Date().toISOString(),
    url: 'https://example.com/mr/1',
  }
  return { origin, cwd, mr }
}

/** A plain repo (no remote) with `main` and a `feature/y` branch, both local only. */
function setupBranchRepo(): { cwd: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'codesema-branch-cwd-'))
  tempDirs.push(cwd)
  git(['init', '-b', 'main'], cwd)
  git(['config', 'user.email', 'a@b.c'], cwd)
  git(['config', 'user.name', 'Test'], cwd)
  writeFileSync(join(cwd, 'a.txt'), 'base\n')
  git(['add', '.'], cwd)
  git(['commit', '-m', 'init'], cwd)
  git(['checkout', '-b', 'feature/y'], cwd)
  writeFileSync(join(cwd, 'a.txt'), 'changed\n')
  git(['commit', '-am', 'feat: change'], cwd)
  git(['checkout', 'main'], cwd)
  return { cwd }
}

function agentScriptFor(cwd: string, payload: string, exitCode = 0): string {
  const script = join(cwd, 'agent.sh')
  writeFileSync(script, `#!/bin/sh\ncat > /dev/null\nprintf '%s' '${payload}'\nexit ${exitCode}\n`)
  return `sh "${script}"`
}

async function waitForPhase(
  runner: ReturnType<typeof createMrReviewRunner>,
  phase: 'idle' | 'running' | 'done' | 'error',
  timeoutMs = 15000,
): Promise<void> {
  const startedAt = Date.now()
  while (runner.status().phase === 'running') {
    if (Date.now() - startedAt > timeoutMs) throw new Error('timed out waiting for the run to settle')
    await new Promise((r) => setTimeout(r, 20))
  }
  expect(runner.status().phase).toBe(phase)
}

function worktreeCount(cwd: string): number {
  return (tryGit(['worktree', 'list', '--porcelain'], cwd) ?? '').split('\n\n').filter((s) => s.trim()).length
}

describe('createMrReviewRunner (MR source)', () => {
  test('rejects an invalid mode without touching git', async () => {
    const { cwd, mr } = setupMrRepo()
    const runner = createMrReviewRunner({
      cwd,
      session: createSession(),
      agentCommand: agentScriptFor(cwd, REVIEW),
      timeoutMs: 15000,
      listMrs: async (): Promise<ForgeMrsResult> => ({ available: true, mrs: [mr] }),
    })

    const result = await runner.start({ kind: 'mr', number: mr.number }, 'bogus' as never)
    expect(result).toMatchObject({ ok: false, code: 400 })
    expect(runner.status()).toEqual({ available: true, phase: 'idle' })
  })

  test('404s when the MR number is not among the open ones', async () => {
    const { cwd, mr } = setupMrRepo()
    const runner = createMrReviewRunner({
      cwd,
      session: createSession(),
      agentCommand: agentScriptFor(cwd, REVIEW),
      timeoutMs: 15000,
      listMrs: async (): Promise<ForgeMrsResult> => ({ available: true, mrs: [mr] }),
    })

    const result = await runner.start({ kind: 'mr', number: 999 }, 'simple')
    expect(result).toMatchObject({ ok: false, code: 404 })
  })

  test('404s when the forge listing is unavailable', async () => {
    const { cwd, mr } = setupMrRepo()
    const runner = createMrReviewRunner({
      cwd,
      session: createSession(),
      agentCommand: agentScriptFor(cwd, REVIEW),
      timeoutMs: 15000,
      listMrs: async (): Promise<ForgeMrsResult> => ({ available: false, reason: 'no-remote' }),
    })

    const result = await runner.start({ kind: 'mr', number: mr.number }, 'simple')
    expect(result).toMatchObject({ ok: false, code: 404 })
  })

  test('fetches the source branch, reviews it in a disposable worktree, archives in the main repo, and always cleans up', async () => {
    const { cwd, mr } = setupMrRepo()
    const session = createSession()
    const runner = createMrReviewRunner({
      cwd,
      session,
      agentCommand: agentScriptFor(cwd, REVIEW),
      timeoutMs: 15000,
      listMrs: async (): Promise<ForgeMrsResult> => ({ available: true, mrs: [mr] }),
    })

    expect(runner.status()).toEqual({ available: true, phase: 'idle' })
    const started = await runner.start({ kind: 'mr', number: mr.number }, 'simple')
    expect(started).toEqual({ ok: true })
    expect(runner.status().phase).toBe('running')

    await waitForPhase(runner, 'done')

    expect(session.record()?.review.verdict).toBe('approve')
    expect(session.record()?.meta.branch).toBe('feature/x')
    expect(session.record()?.meta.target).toBe('main')

    const reviewsDir = join(cwd, '.codesema', 'reviews')
    expect(existsSync(reviewsDir)).toBe(true)
    expect(readdirSync(reviewsDir).some((name) => name.startsWith('feature-x-'))).toBe(true)

    expect(worktreeCount(cwd)).toBe(1)
  }, 20000)

  test('cleans up the worktree even when the agent run fails', async () => {
    const { cwd, mr } = setupMrRepo()
    const session = createSession()
    const runner = createMrReviewRunner({
      cwd,
      session,
      agentCommand: agentScriptFor(cwd, '', 1),
      timeoutMs: 15000,
      listMrs: async (): Promise<ForgeMrsResult> => ({ available: true, mrs: [mr] }),
    })

    await runner.start({ kind: 'mr', number: mr.number }, 'simple')
    await waitForPhase(runner, 'error')

    expect(session.status().phase).toBe('error')
    expect(worktreeCount(cwd)).toBe(1)
  }, 20000)

  test('only one review runs at a time', async () => {
    const { cwd, mr } = setupMrRepo()
    const runner = createMrReviewRunner({
      cwd,
      session: createSession(),
      agentCommand: agentScriptFor(cwd, REVIEW),
      timeoutMs: 15000,
      listMrs: async (): Promise<ForgeMrsResult> => ({ available: true, mrs: [mr] }),
    })

    const first = await runner.start({ kind: 'mr', number: mr.number }, 'simple')
    expect(first.ok).toBe(true)
    const second = await runner.start({ kind: 'mr', number: mr.number }, 'dual')
    expect(second).toMatchObject({ ok: false, code: 409 })

    await waitForPhase(runner, 'done')
  }, 20000)
})

describe('createMrReviewRunner (branch source)', () => {
  test('rejects a branch name starting with a dash without touching git', async () => {
    const { cwd } = setupBranchRepo()
    const runner = createMrReviewRunner({ cwd, session: createSession(), agentCommand: agentScriptFor(cwd, REVIEW), timeoutMs: 15000 })

    const result = await runner.start({ kind: 'branch', name: '-x' }, 'simple')
    expect(result).toMatchObject({ ok: false, code: 400 })
    expect(runner.status()).toEqual({ available: true, phase: 'idle' })
  })

  test('404s when the local branch does not exist', async () => {
    const { cwd } = setupBranchRepo()
    const runner = createMrReviewRunner({ cwd, session: createSession(), agentCommand: agentScriptFor(cwd, REVIEW), timeoutMs: 15000 })

    const result = await runner.start({ kind: 'branch', name: 'nope' }, 'simple')
    expect(result).toMatchObject({ ok: false, code: 404 })
  })

  test('reviews a non-checked-out local branch in a disposable worktree, no fetch needed', async () => {
    const { cwd } = setupBranchRepo()
    const session = createSession()
    const runner = createMrReviewRunner({ cwd, session, agentCommand: agentScriptFor(cwd, REVIEW), timeoutMs: 15000 })

    const started = await runner.start({ kind: 'branch', name: 'feature/y' }, 'simple')
    expect(started).toEqual({ ok: true })
    await waitForPhase(runner, 'done')

    expect(session.record()?.meta.branch).toBe('feature/y')
    expect(session.record()?.meta.target).toBe('main')
    expect(worktreeCount(cwd)).toBe(1)
  }, 20000)

  test('reviews the currently checked-out branch using a detached worktree', async () => {
    const { cwd } = setupBranchRepo()
    git(['checkout', 'feature/y'], cwd)
    const session = createSession()
    const runner = createMrReviewRunner({ cwd, session, agentCommand: agentScriptFor(cwd, REVIEW), timeoutMs: 15000 })

    const started = await runner.start({ kind: 'branch', name: 'feature/y' }, 'simple')
    expect(started).toEqual({ ok: true })
    await waitForPhase(runner, 'done')

    expect(session.record()?.meta.branch).toBe('feature/y')
    expect(worktreeCount(cwd)).toBe(1)
  }, 20000)

  test('reviews a branch already checked out in another worktree using a detached worktree', async () => {
    const { cwd } = setupBranchRepo()
    const otherWorktree = mkdtempSync(join(tmpdir(), 'codesema-branch-other-wt-'))
    tempDirs.push(otherWorktree)
    git(['worktree', 'add', otherWorktree, 'feature/y'], cwd)

    const session = createSession()
    const runner = createMrReviewRunner({ cwd, session, agentCommand: agentScriptFor(cwd, REVIEW), timeoutMs: 15000 })

    const started = await runner.start({ kind: 'branch', name: 'feature/y' }, 'simple')
    expect(started).toEqual({ ok: true })
    await waitForPhase(runner, 'done')

    expect(session.record()?.meta.branch).toBe('feature/y')
    // The pre-existing worktree for feature/y plus the disposable one, cleaned back to just the pre-existing one.
    expect(worktreeCount(cwd)).toBe(2)

    tryGit(['worktree', 'remove', '--force', otherWorktree], cwd)
  }, 20000)
})
