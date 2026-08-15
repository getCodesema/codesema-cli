import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import type { Finding, ReviewRecord, TaskRecord, Verdict } from './contract.js'
import { archiveRecord } from './record.js'
import {
  buildMrDescription,
  extractMrUrl,
  isMrAlreadyExistsError,
  shipTask,
  type ShipCliOutcome,
  type ShipForgeExecFn,
  type ShipGitExecFn,
} from './task-ship.js'

// --- rig ------------------------------------------------------------------

const cleanups: string[] = []

afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codesema-task-ship-'))
  cleanups.push(dir)
  return dir
}

/** Real git repo whose origin URL steers detectForgeHint. */
function makeRepoWithOrigin(url: string): string {
  const repo = makeDir()
  const run = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  run(['init', '-b', 'main'])
  run(['remote', 'add', 'origin', url])
  return repo
}

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const now = new Date().toISOString()
  return {
    version: 1,
    id: 'abcdef123456',
    title: 'Fix the login flow',
    status: 'review_ok',
    base: 'origin/main',
    branch: 'codesema/task-fix-the-login-flow',
    worktree: '/nowhere/worktree',
    agent_session_id: null,
    turns: [
      {
        prompt: 'fix login',
        response: 'I fixed the login flow and added a regression test.',
        question: null,
        started_at: now,
        ended_at: now,
      },
    ],
    review_ref: null,
    work_ms: 0,
    wait_ms: 0,
    auto_ship: false,
    work_on: false,
    isolation: 'policy',
    created_at: now,
    updated_at: now,
    ...overrides,
  }
}

function fakeReview(verdict: Verdict, findings: Finding[] = []): ReviewRecord {
  return {
    version: 1,
    meta: {
      title: 'task review',
      branch: 'codesema/task-x',
      target: 'main',
      merge_base: 'abc',
      repo_root: '/nowhere',
      created_at: new Date().toISOString(),
    },
    commits: [],
    diff: '',
    review: { verdict, summary: 'summary', findings, narrative: null },
  }
}

type GitCall = { args: string[]; cwd: string }
type ForgeCall = { cli: 'gh' | 'glab'; args: string[]; cwd: string }

function gitExec(outcome: ShipCliOutcome): { calls: GitCall[]; fn: ShipGitExecFn } {
  const calls: GitCall[] = []
  return {
    calls,
    fn: (args, cwd) => {
      calls.push({ args, cwd })
      return Promise.resolve(outcome)
    },
  }
}

function forgeExec(outcomes: { gh?: ShipCliOutcome; glab?: ShipCliOutcome }): {
  calls: ForgeCall[]
  fn: ShipForgeExecFn
} {
  const calls: ForgeCall[] = []
  return {
    calls,
    fn: (cli, args, cwd) => {
      calls.push({ cli, args, cwd })
      return Promise.resolve(outcomes[cli] ?? { kind: 'missing' })
    },
  }
}

// --- extractMrUrl ---------------------------------------------------------

describe('extractMrUrl', () => {
  test('picks the URL gh prints alone on stdout', () => {
    expect(extractMrUrl('https://github.com/o/r/pull/12\n')).toBe('https://github.com/o/r/pull/12')
  })

  test('picks the URL out of glab prose and strips trailing punctuation', () => {
    expect(extractMrUrl('!5 created: https://gitlab.com/o/r/-/merge_requests/5.\nDone.')).toBe(
      'https://gitlab.com/o/r/-/merge_requests/5',
    )
  })

  test('null when the output holds no URL', () => {
    expect(extractMrUrl('created PR #12')).toBeNull()
    expect(extractMrUrl('')).toBeNull()
  })
})

// --- isMrAlreadyExistsError -----------------------------------------------

describe('isMrAlreadyExistsError', () => {
  test('matches the gh and glab wordings, case-insensitively', () => {
    expect(
      isMrAlreadyExistsError('a pull request for branch "x" into branch "main" already exists:'),
    ).toBe(true)
    expect(isMrAlreadyExistsError('merge request Already Exists for this source branch')).toBe(true)
  })

  test('never matches an unrelated failure', () => {
    expect(isMrAlreadyExistsError('API rate limit exceeded')).toBe(false)
    expect(isMrAlreadyExistsError('could not resolve to a Repository')).toBe(false)
    expect(isMrAlreadyExistsError('')).toBe(false)
  })
})

// --- buildMrDescription ---------------------------------------------------

describe('buildMrDescription', () => {
  test('last turn summary + review verdict line + provenance note', () => {
    const repo = makeDir()
    const review_ref = archiveRecord(
      fakeReview('request_changes', [{ file: 'a.ts', severity: 'major', message: 'bug' }]),
      repo,
    )
    const body = buildMrDescription(makeTask({ review_ref }))
    expect(body).toContain('I fixed the login flow and added a regression test.')
    expect(body).toContain('Local codesema review: request_changes (1 finding)')
    expect(body).toContain('Generated by codesema.')
  })

  test('pluralizes the findings count', () => {
    const repo = makeDir()
    const review_ref = archiveRecord(
      fakeReview('approve', [
        { file: 'a.ts', severity: 'minor', message: 'x' },
        { file: 'b.ts', severity: 'minor', message: 'y' },
      ]),
      repo,
    )
    expect(buildMrDescription(makeTask({ review_ref }))).toContain(
      'Local codesema review: approve (2 findings)',
    )
  })

  test('summary comes from the LAST turn that has a response', () => {
    const now = new Date().toISOString()
    const task = makeTask({
      turns: [
        {
          prompt: 'p1',
          response: 'turn one summary',
          question: null,
          started_at: now,
          ended_at: now,
        },
        {
          prompt: 'p2',
          response: 'turn two summary',
          question: null,
          started_at: now,
          ended_at: now,
        },
        { prompt: 'p3', response: null, question: null, started_at: now, ended_at: null },
      ],
    })
    const body = buildMrDescription(task)
    expect(body).toContain('turn two summary')
    expect(body).not.toContain('turn one summary')
  })

  test('missing or corrupt review archive: no verdict line, no crash', () => {
    const noRef = buildMrDescription(makeTask({ review_ref: null }))
    expect(noRef).not.toContain('Local codesema review')
    expect(noRef).toContain('Generated by codesema.')
    const gone = buildMrDescription(makeTask({ review_ref: '/nowhere/missing.json' }))
    expect(gone).not.toContain('Local codesema review')
  })

  test('a huge agent summary is bounded, not shipped verbatim', () => {
    const now = new Date().toISOString()
    const task = makeTask({
      turns: [
        {
          prompt: 'p',
          response: 'x'.repeat(10_000),
          question: null,
          started_at: now,
          ended_at: now,
        },
      ],
    })
    const body = buildMrDescription(task)
    expect(body.length).toBeLessThan(5000)
    expect(body).toContain('…')
  })
})

// --- shipTask -------------------------------------------------------------

describe('shipTask', () => {
  test('pushes -u origin <branch> from the main repo before anything else', async () => {
    const cwd = makeDir()
    const git = gitExec({ kind: 'ok', stdout: '' })
    const forge = forgeExec({})
    const task = makeTask()
    await shipTask({ cwd, task, execGit: git.fn, execForge: forge.fn })
    expect(git.calls).toEqual([{ args: ['push', '-u', 'origin', task.branch], cwd }])
  })

  test('push failure aborts the ship with the git error, no forge CLI touched', async () => {
    const cwd = makeDir()
    const git = gitExec({ kind: 'error', message: 'remote: permission denied' })
    const forge = forgeExec({ gh: { kind: 'ok', stdout: 'https://github.com/o/r/pull/1' } })
    const outcome = await shipTask({ cwd, task: makeTask(), execGit: git.fn, execForge: forge.fn })
    expect(outcome).toEqual({ pushed: false, error: 'git push failed: remote: permission denied' })
    expect(forge.calls).toHaveLength(0)
  })

  test('gh success: MR URL extracted, base stripped of its origin/ prefix', async () => {
    const cwd = makeDir()
    const git = gitExec({ kind: 'ok', stdout: '' })
    const forge = forgeExec({
      gh: { kind: 'ok', stdout: 'https://github.com/o/r/pull/42\n' },
    })
    const task = makeTask({ base: 'origin/develop' })
    const outcome = await shipTask({ cwd, task, execGit: git.fn, execForge: forge.fn })
    expect(outcome).toEqual({
      pushed: true,
      mrUrl: 'https://github.com/o/r/pull/42',
      note: null,
    })
    expect(forge.calls).toHaveLength(1)
    const call = forge.calls[0]!
    expect(call.cli).toBe('gh')
    expect(call.args).toContain('--head')
    expect(call.args).toContain(task.branch)
    expect(call.args[call.args.indexOf('--base') + 1]).toBe('develop')
    expect(call.args[call.args.indexOf('--title') + 1]).toBe(task.title)
  })

  test('no forge CLI at all: push-only ship with an explicit note', async () => {
    const cwd = makeDir()
    const git = gitExec({ kind: 'ok', stdout: '' })
    const forge = forgeExec({}) // both 'missing'
    const outcome = await shipTask({ cwd, task: makeTask(), execGit: git.fn, execForge: forge.fn })
    expect(outcome.pushed).toBe(true)
    if (!outcome.pushed) {
      return
    }
    expect(outcome.mrUrl).toBeNull()
    expect(outcome.note).toContain('no forge CLI')
    // Unknown origin: both CLIs were tried before giving up.
    expect(forge.calls.map((c) => c.cli)).toEqual(['gh', 'glab'])
  })

  test('gh missing, glab creates the MR: glab URL wins', async () => {
    const cwd = makeDir()
    const git = gitExec({ kind: 'ok', stdout: '' })
    const forge = forgeExec({
      glab: { kind: 'ok', stdout: 'https://gitlab.com/o/r/-/merge_requests/7\n' },
    })
    const task = makeTask()
    const outcome = await shipTask({ cwd, task, execGit: git.fn, execForge: forge.fn })
    expect(outcome).toEqual({
      pushed: true,
      mrUrl: 'https://gitlab.com/o/r/-/merge_requests/7',
      note: null,
    })
    const glabCall = forge.calls.find((c) => c.cli === 'glab')!
    expect(glabCall.args[glabCall.args.indexOf('--source-branch') + 1]).toBe(task.branch)
    expect(glabCall.args[glabCall.args.indexOf('--target-branch') + 1]).toBe('main')
    expect(glabCall.args).toContain('--yes')
  })

  test('forge CLI error: still shipped (push done), the error becomes the note', async () => {
    const cwd = makeDir()
    const git = gitExec({ kind: 'ok', stdout: '' })
    const forge = forgeExec({ gh: { kind: 'error', message: 'API rate limit exceeded' } })
    const outcome = await shipTask({ cwd, task: makeTask(), execGit: git.fn, execForge: forge.fn })
    expect(outcome).toEqual({
      pushed: true,
      mrUrl: null,
      note: 'gh failed: API rate limit exceeded',
    })
  })

  test('gh "already exists": degraded success reusing the existing PR URL from the error', async () => {
    const cwd = makeDir()
    const git = gitExec({ kind: 'ok', stdout: '' })
    const forge = forgeExec({
      gh: {
        kind: 'error',
        message:
          'a pull request for branch "codesema/task-fix-the-login-flow" into branch "main" already exists:\nhttps://github.com/o/r/pull/17',
      },
    })
    const outcome = await shipTask({ cwd, task: makeTask(), execGit: git.fn, execForge: forge.fn })
    expect(outcome).toEqual({
      pushed: true,
      mrUrl: 'https://github.com/o/r/pull/17',
      note: 'gh: a merge request already exists for this branch — the push updated it',
    })
  })

  test('glab "already exists" without a URL: degraded success, null URL, honest note', async () => {
    const cwd = makeRepoWithOrigin('https://gitlab.com/o/r.git')
    const git = gitExec({ kind: 'ok', stdout: '' })
    const forge = forgeExec({
      glab: { kind: 'error', message: 'merge request already exists for this source branch' },
    })
    const outcome = await shipTask({ cwd, task: makeTask(), execGit: git.fn, execForge: forge.fn })
    expect(outcome).toEqual({
      pushed: true,
      mrUrl: null,
      note: 'glab: a merge request already exists for this branch — the push updated it',
    })
  })

  test('forge success without a printed URL: shipped with a note, never a fake URL', async () => {
    const cwd = makeDir()
    const git = gitExec({ kind: 'ok', stdout: '' })
    const forge = forgeExec({ gh: { kind: 'ok', stdout: 'created pull request #9' } })
    const outcome = await shipTask({ cwd, task: makeTask(), execGit: git.fn, execForge: forge.fn })
    expect(outcome.pushed).toBe(true)
    if (!outcome.pushed) {
      return
    }
    expect(outcome.mrUrl).toBeNull()
    expect(outcome.note).toContain('printed no URL')
  })

  test('a gitlab origin skips gh entirely (same hint rule as the MR list)', async () => {
    const cwd = makeRepoWithOrigin('https://gitlab.com/o/r.git')
    const git = gitExec({ kind: 'ok', stdout: '' })
    const forge = forgeExec({
      glab: { kind: 'ok', stdout: 'https://gitlab.com/o/r/-/merge_requests/1' },
    })
    await shipTask({ cwd, task: makeTask(), execGit: git.fn, execForge: forge.fn })
    expect(forge.calls.map((c) => c.cli)).toEqual(['glab'])
  })

  test('a github origin skips glab entirely', async () => {
    const cwd = makeRepoWithOrigin('git@github.com:o/r.git')
    const git = gitExec({ kind: 'ok', stdout: '' })
    const forge = forgeExec({}) // gh missing → no fallback on glab
    const outcome = await shipTask({ cwd, task: makeTask(), execGit: git.fn, execForge: forge.fn })
    expect(outcome.pushed).toBe(true)
    expect(forge.calls.map((c) => c.cli)).toEqual(['gh'])
  })
})
