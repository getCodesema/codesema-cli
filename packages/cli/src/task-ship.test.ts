import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import type { RecapRecord, TaskRecord } from './contract.js'
import type {
  SandboxDriver,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxHandle,
  SandboxMetrics,
  SandboxProbe,
  SandboxSpec,
  SnapshotInfo,
} from './microsandbox-driver.js'
import { readTaskRecap, renderRecapMarkdown } from './task-recap.js'
import {
  boundCodePoints,
  buildMrDescription,
  extractMrUrl,
  GITOPS_IMAGE,
  isMrAlreadyExistsError,
  MR_BODY_SUMMARY_MAX,
  shipTask,
  toHttpsRemoteUrl,
  type ShipCliOutcome,
  type ShipForgeExecFn,
  type ShipGitExecFn,
  type ShipTaskOptions,
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

function makeRecap(overrides: Partial<RecapRecord> = {}): RecapRecord {
  return {
    version: 1,
    summary: 'Rewired the login flow.',
    changes: ['auth: a single entry point'],
    decisions: [],
    files: ['src/auth.ts'],
    tests: [{ command: 'bun test', status: 'passed' }],
    branch: 'codesema/task-fix-the-login-flow',
    ...overrides,
  }
}

/**
 * A recap whose markdown rendering is EXACTLY `length` code points. Sized
 * against the real renderer rather than a guessed constant: every character
 * added to a single-line summary adds exactly one code point to the document.
 */
function recapRenderingExactly(length: number): RecapRecord {
  const overhead = Array.from(renderRecapMarkdown(makeRecap({ summary: 'x' }))).length - 1
  return makeRecap({ summary: 'x'.repeat(length - overhead) })
}

/** The part of the description that is not the provenance note. */
function recapPart(body: string): string {
  return body.slice(0, body.lastIndexOf('\n\n---\n'))
}

type GitCall = { args: string[]; cwd: string }
type ForgeCall = { cli: 'gh' | 'glab'; args: string[]; cwd: string }

/**
 * `outcome` answers the PUSH; `remote` answers the `remote get-url origin`
 * probe the ship runs before it (D9). They are separate because collapsing
 * them would turn every push-failure test into a no-remote test, and the two
 * refusals are exactly what T2.7 makes distinguishable.
 */
function gitExec(
  outcome: ShipCliOutcome,
  remote: ShipCliOutcome = { kind: 'ok', stdout: 'git@github.com:o/r.git\n' },
): { calls: GitCall[]; fn: ShipGitExecFn } {
  const calls: GitCall[] = []
  return {
    calls,
    fn: (args, cwd) => {
      calls.push({ args, cwd })
      return Promise.resolve(args[0] === 'remote' ? remote : outcome)
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
  test('the description IS the recap markdown, consumed without reformatting', () => {
    const recap = makeRecap()
    const body = buildMrDescription({ kind: 'recap', recap })
    // Not "contains the same words": the rendering is carried through
    // character for character, which is what "no reformatting decision left to
    // make" means (T3.4 design § 5).
    expect(recapPart(body)).toBe(renderRecapMarkdown(recap))
    expect(body).toContain('## Summary')
    expect(body).toContain('## Tests')
  })

  test('the provenance note closes the description, behind its separator', () => {
    const body = buildMrDescription({ kind: 'recap', recap: makeRecap() })
    expect(body.endsWith('\n\n---\nGenerated by codesema.')).toBe(true)
  })

  test('a rendering at the bound is sent whole', () => {
    const body = buildMrDescription({
      kind: 'recap',
      recap: recapRenderingExactly(MR_BODY_SUMMARY_MAX),
    })
    expect(Array.from(recapPart(body))).toHaveLength(MR_BODY_SUMMARY_MAX)
    expect(recapPart(body)).not.toContain('…')
  })

  test('one code point past the bound is truncated, with the ellipsis last', () => {
    const body = buildMrDescription({
      kind: 'recap',
      recap: recapRenderingExactly(MR_BODY_SUMMARY_MAX + 1),
    })
    const part = Array.from(recapPart(body))
    expect(part).toHaveLength(MR_BODY_SUMMARY_MAX)
    expect(part.at(-1)).toBe('…')
  })

  test('the bound is 4 000 code points, whatever the constant is set to', () => {
    // Sized from a LITERAL 6 000, not from MR_BODY_SUMMARY_MAX: a test that
    // measures its input against the very constant it is checking cannot tell
    // a bound of 4 000 from a bound of 40 000 (both leave a 6 000-point
    // rendering untouched at one, truncated at the other).
    const body = buildMrDescription({ kind: 'recap', recap: recapRenderingExactly(6000) })
    expect(Array.from(recapPart(body))).toHaveLength(4000)
  })

  test('the note is added AFTER the truncation, so a long recap can never eat it', () => {
    const body = buildMrDescription({
      kind: 'recap',
      recap: recapRenderingExactly(MR_BODY_SUMMARY_MAX * 3),
    })
    expect(body).toContain('Generated by codesema.')
    expect(Array.from(body).length).toBeGreaterThan(MR_BODY_SUMMARY_MAX)
  })

  test('truncation cuts code points, never a surrogate pair in half', () => {
    const body = buildMrDescription({
      kind: 'recap',
      recap: makeRecap({ summary: '😀'.repeat(MR_BODY_SUMMARY_MAX) }),
    })
    const lone = Array.from(body).filter((ch) => {
      const code = ch.codePointAt(0) ?? 0
      return code >= 0xd800 && code <= 0xdfff
    })
    expect(lone).toEqual([])
  })

  test('no recap: the description says so, and nothing is thrown', () => {
    const body = buildMrDescription({ kind: 'missing' })
    expect(body).toContain('No recap could be produced')
    expect(body).toContain('Generated by codesema.')
    expect(body).not.toContain('## Summary')
  })

  test('a recap held back by the secret scan says THAT, not "no recap"', () => {
    const blocked = buildMrDescription({ kind: 'blocked' })
    expect(blocked).toContain('carries a secret')
    expect(blocked).not.toBe(buildMrDescription({ kind: 'missing' }))
  })
})

describe('boundCodePoints', () => {
  test('leaves anything at or under the bound untouched', () => {
    expect(boundCodePoints('abcd', 4)).toBe('abcd')
    expect(boundCodePoints('abc', 4)).toBe('abc')
  })

  test('never returns more than the bound, ellipsis included', () => {
    expect(boundCodePoints('abcde', 4)).toBe('abc…')
    expect(Array.from(boundCodePoints('😀'.repeat(10), 4))).toHaveLength(4)
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
    expect(git.calls).toEqual([
      // D9: the remote is confirmed BEFORE the push, so "no remote" is a named
      // refusal rather than whatever words git puts on a failed push.
      { args: ['remote', 'get-url', 'origin'], cwd },
      { args: ['push', '-u', 'origin', task.branch], cwd },
    ])
  })

  test('no origin remote: the ship is REFUSED and named, and git is never asked to push', async () => {
    const cwd = makeDir()
    const git = gitExec(
      { kind: 'ok', stdout: '' },
      // Exit code 2 is what "there is no remote by that name" IS: git's own
      // sentence is localised, the code is not (measured, git 2.53.0).
      { kind: 'error', message: "no such remote 'origin'", status: 2 },
    )
    const forge = forgeExec({ gh: { kind: 'ok', stdout: 'https://github.com/o/r/pull/1' } })
    const outcome = await shipTask({ cwd, task: makeTask(), execGit: git.fn, execForge: forge.fn })
    expect(outcome.pushed).toBe(false)
    if (outcome.pushed) {
      return
    }
    expect(outcome.reasonCode).toBe('forge_unreachable')
    // The motif verbatim, never a reworded sentence, and never confusable
    // with the two CLI motifs.
    expect(outcome.detail).toBe('no-remote')
    // The readable half is still there, and it says what is missing.
    expect(outcome.error).toContain('origin remote')
    // Nothing was pushed and no forge CLI was launched.
    expect(git.calls.map((c) => c.args[0])).toEqual(['remote'])
    expect(forge.calls).toHaveLength(0)
  })

  test('an EMPTY origin URL is no remote either, not a silent success', async () => {
    const cwd = makeDir()
    const git = gitExec({ kind: 'ok', stdout: '' }, { kind: 'ok', stdout: '  \n' })
    const outcome = await shipTask({
      cwd,
      task: makeTask(),
      execGit: git.fn,
      execForge: forgeExec({}).fn,
    })
    expect(outcome.pushed).toBe(false)
    expect(outcome.pushed === false && outcome.detail).toBe('no-remote')
  })

  test('push failure aborts the ship with the git error, no forge CLI touched', async () => {
    const cwd = makeDir()
    const git = gitExec({ kind: 'error', message: 'remote: permission denied' })
    const forge = forgeExec({ gh: { kind: 'ok', stdout: 'https://github.com/o/r/pull/1' } })
    const outcome = await shipTask({ cwd, task: makeTask(), execGit: git.fn, execForge: forge.fn })
    // A push that was REFUSED by the remote is not a forge codesema could not
    // reach: no code, no motif — that separation is the whole point of the
    // pre-push probe.
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

  test('no forge CLI: the push-only ship names itself forge_unreachable', async () => {
    const cwd = makeDir()
    const git = gitExec({ kind: 'ok', stdout: '' })
    const forge = forgeExec({}) // both 'missing'
    const outcome = await shipTask({ cwd, task: makeTask(), execGit: git.fn, execForge: forge.fn })
    expect(outcome.pushed).toBe(true)
    if (!outcome.pushed) {
      return
    }
    // The code is ADDED to the note, which keeps saying the same thing in words.
    expect(outcome.reasonCode).toBe('forge_unreachable')
    expect(outcome.detail).toBe('no-cli')
    expect(outcome.note).toContain('no forge CLI')
  })

  test('a forge CLI that ran and failed is named too — cli-error, never no-cli', async () => {
    const cwd = makeDir()
    const git = gitExec({ kind: 'ok', stdout: '' })
    const forge = forgeExec({ gh: { kind: 'error', message: 'API rate limit exceeded' } })
    const outcome = await shipTask({ cwd, task: makeTask(), execGit: git.fn, execForge: forge.fn })
    expect(outcome.pushed).toBe(true)
    if (!outcome.pushed) {
      return
    }
    // T2.7 overturns "the forge answered, so it is not unreachable": D2 spells
    // out `forge_unreachable` as covering "an API that refused", and leaving
    // this one uncoded made the likeliest forge degradation the only one no
    // machine could see.
    expect(outcome.reasonCode).toBe('forge_unreachable')
    // ...and the motif is what keeps it from being read as a missing binary.
    expect(outcome.detail).toBe('cli-error')
    expect(outcome.detail).not.toBe('no-cli')
    // The CLI's own words are untouched.
    expect(outcome.note).toBe('gh failed: API rate limit exceeded')
  })

  test('a ship that opened its MR claims no degradation at all', async () => {
    const cwd = makeDir()
    const git = gitExec({ kind: 'ok', stdout: '' })
    const forge = forgeExec({ gh: { kind: 'ok', stdout: 'https://github.com/o/r/pull/42\n' } })
    const outcome = await shipTask({ cwd, task: makeTask(), execGit: git.fn, execForge: forge.fn })
    expect(outcome.pushed && outcome.reasonCode).toBeUndefined()
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
      reasonCode: 'forge_unreachable',
      detail: 'cli-error',
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

// --- the recap the ship generates (T3.5) ------------------------------------
//
// The ship is the ONE place a recap is produced: T3.4 shipped the generator
// with no caller at all, so `.codesema/tasks/<id>/recap.json` was never
// written by anything. These tests drive the REAL generator and the REAL
// store — only git, gh and glab are injected.

const recapPath = (cwd: string, task: TaskRecord) =>
  join(cwd, '.codesema', 'tasks', task.id, 'recap.json')

describe('shipTask writes the task recap', () => {
  test('recap.json lands on disk and the MR description is built from it', async () => {
    const cwd = makeDir()
    const task = makeTask()
    const git = gitExec({ kind: 'ok', stdout: '' })
    // Deliberately a forge that prints NO url, so the url back-write below is
    // not what puts recap.json on disk: this test is about the write the ship
    // does before it composes the description at all.
    const forge = forgeExec({ gh: { kind: 'ok', stdout: 'created pull request #9' } })
    const outcome = await shipTask({ cwd, task, execGit: git.fn, execForge: forge.fn })
    expect(outcome.pushed).toBe(true)
    const written = readTaskRecap(cwd, task.id)
    expect(written).not.toBeNull()
    expect(written?.branch).toBe(task.branch)
    // The agent's last summary is the one prose source the ship path has, and
    // the renderer quotes it.
    expect(written?.summary).toBe('I fixed the login flow and added a regression test.')
    const body = forge.calls[0]?.args[forge.calls[0].args.indexOf('--body') + 1] ?? ''
    expect(body).toContain('## Summary')
    expect(body).toContain('> I fixed the login flow and added a regression test.')
  })

  test('the description rides argv as a VALUE, on --body for gh and --description for glab', async () => {
    const cwd = makeDir()
    const git = gitExec({ kind: 'ok', stdout: '' })
    const forge = forgeExec({}) // both missing: gh then glab are both built
    await shipTask({ cwd, task: makeTask(), execGit: git.fn, execForge: forge.fn })
    const gh = forge.calls.find((c) => c.cli === 'gh')!
    const glab = forge.calls.find((c) => c.cli === 'glab')!
    expect(gh.args[gh.args.indexOf('--body') + 1]).toContain('## Summary')
    expect(glab.args[glab.args.indexOf('--description') + 1]).toContain('## Summary')
    // Never promoted to a flag, never interpolated into a shell string.
    expect(gh.args.filter((a) => a.startsWith('--body='))).toEqual([])
  })

  test('the MR url is written back onto the recap once the MR exists', async () => {
    const cwd = makeDir()
    const task = makeTask()
    const git = gitExec({ kind: 'ok', stdout: '' })
    const forge = forgeExec({ gh: { kind: 'ok', stdout: 'https://github.com/o/r/pull/9\n' } })
    await shipTask({ cwd, task, execGit: git.fn, execForge: forge.fn })
    expect(readTaskRecap(cwd, task.id)?.mr_url).toBe('https://github.com/o/r/pull/9')
  })

  test('a ship that opened no MR leaves the recap without an invented url', async () => {
    const cwd = makeDir()
    const task = makeTask()
    const git = gitExec({ kind: 'ok', stdout: '' })
    const forge = forgeExec({})
    await shipTask({ cwd, task, execGit: git.fn, execForge: forge.fn })
    expect(readTaskRecap(cwd, task.id)?.mr_url).toBeUndefined()
  })

  test('a failed push produces no recap at all', async () => {
    const cwd = makeDir()
    const task = makeTask()
    const git = gitExec({ kind: 'error', message: 'permission denied' })
    const forge = forgeExec({})
    await shipTask({ cwd, task, execGit: git.fn, execForge: forge.fn })
    expect(existsSync(recapPath(cwd, task))).toBe(false)
  })

  test('a generator that refuses: honest description, note added, ship still succeeds', async () => {
    const cwd = makeDir()
    const git = gitExec({ kind: 'ok', stdout: '' })
    const forge = forgeExec({ gh: { kind: 'ok', stdout: 'https://github.com/o/r/pull/9' } })
    const outcome = await shipTask({
      cwd,
      task: makeTask(),
      execGit: git.fn,
      execForge: forge.fn,
      generateRecapFn: () => ({
        recap: null,
        degradations: [{ field: 'branch', reason: 'task record has no usable branch' }],
      }),
    })
    expect(outcome.pushed).toBe(true)
    expect(outcome.pushed && outcome.note).toContain('no recap: task record has no usable branch')
    const body = forge.calls[0]?.args[forge.calls[0].args.indexOf('--body') + 1] ?? ''
    expect(body).toContain('No recap could be produced')
    expect(body).toContain('Generated by codesema.')
  })

  test('a generator that throws does not take the ship down with it', async () => {
    const cwd = makeDir()
    const git = gitExec({ kind: 'ok', stdout: '' })
    const forge = forgeExec({ gh: { kind: 'ok', stdout: 'https://github.com/o/r/pull/9' } })
    const outcome = await shipTask({
      cwd,
      task: makeTask(),
      execGit: git.fn,
      execForge: forge.fn,
      generateRecapFn: () => {
        throw new Error('git exploded')
      },
    })
    expect(outcome).toMatchObject({ pushed: true, mrUrl: 'https://github.com/o/r/pull/9' })
    expect(outcome.pushed && outcome.note).toBe('no recap: git exploded')
  })

  test('a store that refuses to persist the recap is said, and the ship still lands', async () => {
    const cwd = makeDir()
    const git = gitExec({ kind: 'ok', stdout: '' })
    const forge = forgeExec({ gh: { kind: 'ok', stdout: 'https://github.com/o/r/pull/9' } })
    const outcome = await shipTask({
      cwd,
      task: makeTask(),
      execGit: git.fn,
      execForge: forge.fn,
      writeTaskRecapFn: () => {
        throw new Error('read-only file system')
      },
    })
    expect(outcome.pushed).toBe(true)
    expect(outcome.pushed && outcome.note).toContain('read-only file system')
  })

  test('the recap note is ADDED to the MR note, it never replaces it', async () => {
    const cwd = makeDir()
    const git = gitExec({ kind: 'ok', stdout: '' })
    const forge = forgeExec({}) // no forge CLI: createMr has its own note
    const outcome = await shipTask({
      cwd,
      task: makeTask(),
      execGit: git.fn,
      execForge: forge.fn,
      generateRecapFn: () => {
        throw new Error('git exploded')
      },
    })
    expect(outcome.pushed).toBe(true)
    if (!outcome.pushed) {
      return
    }
    expect(outcome.note).toContain('no recap: git exploded')
    expect(outcome.note).toContain('no forge CLI')
    // The D2 code createMr posed is untouched by the recap degradation.
    expect(outcome.reasonCode).toBe('forge_unreachable')
  })

  test('a secret in the recap keeps it off the merge request — and on disk', async () => {
    const cwd = makeDir()
    const task = makeTask({
      turns: [
        {
          prompt: 'p',
          response: 'the key is AKIAIOSFODNN7EXAMPLE',
          question: null,
          started_at: new Date().toISOString(),
          ended_at: new Date().toISOString(),
        },
      ],
    })
    const git = gitExec({ kind: 'ok', stdout: '' })
    const forge = forgeExec({ gh: { kind: 'ok', stdout: 'https://github.com/o/r/pull/9' } })
    const outcome = await shipTask({ cwd, task, execGit: git.fn, execForge: forge.fn })
    const body = forge.calls[0]?.args[forge.calls[0].args.indexOf('--body') + 1] ?? ''
    expect(body).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(body).toContain('carries a secret')
    expect(outcome.pushed && outcome.note).toContain('an AWS access key id')
    // Nothing is lost: the recap is on disk, with the secret, for a human.
    expect(readFileSync(recapPath(cwd, task), 'utf8')).toContain('AKIAIOSFODNN7EXAMPLE')
  })

  // MAJEUR 1, ship side. Every secret fixture on this surface planted the
  // secret in the last turn's response, which reaches `summary` and only
  // `summary` — so `prepareRecap` scanning the FULL rendering rather than one
  // field was true of the code and untested. The recap is injected here
  // rather than generated, because the ship's own generator can fill exactly
  // one of the seven fields from a task record.
  describe('the ship scans every field the recap renders, not only its summary', () => {
    const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE'
    const FIELDS: readonly {
      field: string
      overrides: Partial<RecapRecord>
      survivesOnDisk?: boolean
    }[] = [
      { field: 'summary', overrides: { summary: `the key is ${AWS_KEY}` } },
      { field: 'changes[]', overrides: { changes: [`auth: rotate ${AWS_KEY}`] } },
      { field: 'decisions[]', overrides: { decisions: [`kept ${AWS_KEY} out of the env file`] } },
      { field: 'files[]', overrides: { files: [`src/${AWS_KEY}.ts`] } },
      {
        field: 'tests[].command',
        // The one a REPO can fill: `.codesema/config.json`'s `checks.commands[]`
        // reaches the recap with no newline filter of its own.
        overrides: {
          tests: [{ command: `AWS_ACCESS_KEY_ID=${AWS_KEY} bun test`, status: 'passed' }],
        },
      },
      { field: 'branch', overrides: { branch: `codesema/task-${AWS_KEY}` } },
      // `mr_url` is the ONE field the ship writes back over (attachMrUrl), so
      // it is also the one whose secret does not survive on disk: the real
      // merge-request URL replaces it. Said here rather than left as an
      // exception a reader would take for a bug.
      {
        field: 'mr_url',
        overrides: { mr_url: `https://forge.example/mr/${AWS_KEY}` },
        survivesOnDisk: false,
      },
    ]

    const shipWithRecap = async (recap: RecapRecord) => {
      const cwd = makeDir()
      const task = makeTask()
      const git = gitExec({ kind: 'ok', stdout: '' })
      const forge = forgeExec({ gh: { kind: 'ok', stdout: 'https://github.com/o/r/pull/9' } })
      const outcome = await shipTask({
        cwd,
        task,
        execGit: git.fn,
        execForge: forge.fn,
        generateRecapFn: () => ({ recap, degradations: [] }),
      })
      const body = forge.calls[0]?.args[forge.calls[0].args.indexOf('--body') + 1] ?? ''
      return { cwd, task, outcome, body }
    }

    test('the base recap this suite mutates goes through untouched', async () => {
      const { outcome, body } = await shipWithRecap(makeRecap())
      expect(body).toContain('## Summary')
      expect(body).not.toContain('carries a secret')
      expect(outcome.pushed && outcome.note).toBeNull()
      expect(outcome.pushed && outcome.recapState).toBeUndefined()
    })

    for (const { field, overrides, survivesOnDisk = true } of FIELDS) {
      test(`a secret in ${field} keeps the recap off the merge request`, async () => {
        const { cwd, task, outcome, body } = await shipWithRecap(makeRecap(overrides))
        expect(body).not.toContain(AWS_KEY)
        expect(body).toContain('carries a secret')
        expect(outcome.pushed && outcome.note).toContain('an AWS access key id')
        expect(outcome.pushed && outcome.recapState).toBe('recap_blocked_secrets')
        // Nothing is lost: the recap is on disk, with the secret, for a human.
        const onDisk = readFileSync(recapPath(cwd, task), 'utf8')
        expect(onDisk.includes(AWS_KEY)).toBe(survivesOnDisk)
      })
    }

    test('a blocked recap keeps its CONTENTS on disk, and gains the MR url all the same', async () => {
      const { cwd, task } = await shipWithRecap(makeRecap({ summary: `the key is ${AWS_KEY}` }))
      const written = readTaskRecap(cwd, task.id)
      expect(written?.summary).toContain(AWS_KEY)
      // Not "intact" in the byte-for-byte sense the CHANGELOG used to claim:
      // `attachMrUrl` still runs on a blocked ship, on purpose — the link
      // belongs on the record whatever became of the publication.
      expect(written?.mr_url).toBe('https://github.com/o/r/pull/9')
    })
  })

  // m1: `scanRecapSecretsFn` had TWO occurrences in the whole repo — its
  // declaration and its one call — no test, no caller. The rule this ticket
  // set for `generateRecapFn` and `writeTaskRecapFn` (a throw must never take
  // down a push that already landed) was posed on two seams out of three.
  describe('the secret-scan seam', () => {
    const shipWithScan = (scanRecapSecretsFn: ShipTaskOptions['scanRecapSecretsFn']) => {
      const cwd = makeDir()
      const git = gitExec({ kind: 'ok', stdout: '' })
      const forge = forgeExec({ gh: { kind: 'ok', stdout: 'https://github.com/o/r/pull/9' } })
      return shipTask({
        cwd,
        task: makeTask(),
        execGit: git.fn,
        execForge: forge.fn,
        ...(scanRecapSecretsFn ? { scanRecapSecretsFn } : {}),
      }).then((outcome) => ({
        outcome,
        body: forge.calls[0]?.args[forge.calls[0].args.indexOf('--body') + 1] ?? '',
      }))
    }

    test('it IS the scan: what it reports is what holds the recap back', async () => {
      const { outcome, body } = await shipWithScan(() => [
        { file: 'recap.md', reason: 'content', detail: 'an Anthropic API key' },
      ])
      expect(body).toContain('carries a secret')
      expect(body).not.toContain('## Summary')
      expect(outcome.pushed && outcome.note).toContain('an Anthropic API key')
      expect(outcome.pushed && outcome.recapState).toBe('recap_blocked_secrets')
    })

    test('it is handed the RENDERING that would be published, not the record', async () => {
      const seen: string[] = []
      await shipWithScan((markdown) => {
        seen.push(markdown)
        return []
      })
      expect(seen).toHaveLength(1)
      expect(seen[0]).toContain('## Summary')
      expect(seen[0]).toContain('> I fixed the login flow and added a regression test.')
    })

    test('a scan that THROWS fails closed, and never fails the push that already landed', async () => {
      const { outcome, body } = await shipWithScan(() => {
        throw new Error('regex engine exploded')
      })
      // Fail closed: nothing cleared the document, so nothing derived from it
      // is sent. Before the guard, this throw escaped a prepareRecap
      // documented "Never throws" and task-server.ts turned it into
      // `pushed: false` — a "git push failed" for a push that had succeeded.
      expect(outcome).toMatchObject({ pushed: true, mrUrl: 'https://github.com/o/r/pull/9' })
      expect(body).not.toContain('## Summary')
      expect(outcome.pushed && outcome.note).toContain('secret scan could not run')
      expect(outcome.pushed && outcome.note).toContain('regex engine exploded')
      expect(outcome.pushed && outcome.recapState).toBe('recap_unscanned')
    })

    test('"nobody looked" is not said as "a secret was found"', async () => {
      const unscanned = buildMrDescription({ kind: 'unscanned' })
      const blocked = buildMrDescription({ kind: 'blocked' })
      expect(unscanned).not.toBe(blocked)
      expect(unscanned).not.toContain('carries a secret')
      expect(unscanned).toContain('could not run')
      expect(unscanned).toContain('Generated by codesema.')
    })

    test('the default seam is the real scan: no injection, same block', async () => {
      const cwd = makeDir()
      const task = makeTask({
        turns: [
          {
            prompt: 'p',
            response: 'the key is AKIAIOSFODNN7EXAMPLE',
            question: null,
            started_at: new Date().toISOString(),
            ended_at: new Date().toISOString(),
          },
        ],
      })
      const git = gitExec({ kind: 'ok', stdout: '' })
      const forge = forgeExec({ gh: { kind: 'ok', stdout: 'https://github.com/o/r/pull/9' } })
      const outcome = await shipTask({ cwd, task, execGit: git.fn, execForge: forge.fn })
      expect(outcome.pushed && outcome.recapState).toBe('recap_blocked_secrets')
    })
  })

  // m2: not a violation of invariant 2 — the URL survives on the `shipped`
  // event and in the merge request — but "silent by design" is a shape this
  // repo has nowhere else, and the clause costs nothing.
  test('an MR url that could not be written back onto the recap is SAID', async () => {
    const cwd = makeDir()
    const git = gitExec({ kind: 'ok', stdout: '' })
    const forge = forgeExec({ gh: { kind: 'ok', stdout: 'https://github.com/o/r/pull/9' } })
    let writes = 0
    const outcome = await shipTask({
      cwd,
      task: makeTask(),
      execGit: git.fn,
      execForge: forge.fn,
      // The FIRST write lands (the recap has to exist for the back-write to
      // be attempted at all); the second one — the url — does not.
      writeTaskRecapFn: (_cwd, _id, recap) => {
        writes += 1
        if (writes > 1) {
          throw new Error('read-only file system')
        }
        return recap
      },
    })
    expect(writes).toBe(2)
    expect(outcome).toMatchObject({ pushed: true, mrUrl: 'https://github.com/o/r/pull/9' })
    expect(outcome.pushed && outcome.note).toContain('could not be written back onto the recap')
    expect(outcome.pushed && outcome.note).toContain('read-only file system')
    // A confort degradation, not a named one: nothing about the ship became
    // unknowable, so no state is posed for the journal.
    expect(outcome.pushed && outcome.recapState).toBeUndefined()
  })

  test('a back-write that had nothing to do says nothing at all', async () => {
    const cwd = makeDir()
    const git = gitExec({ kind: 'ok', stdout: '' })
    // No URL printed: there is no url to write back, hence no failure to name.
    const forge = forgeExec({ gh: { kind: 'ok', stdout: 'created pull request #9' } })
    const outcome = await shipTask({ cwd, task: makeTask(), execGit: git.fn, execForge: forge.fn })
    expect(outcome.pushed && outcome.note).toBe('gh created the merge request but printed no URL')
  })

  // MAJEUR 2, the CLI half: the three things the ship has to say about a recap
  // it did not carry are now NAMED, not only noted.
  test('each way of landing short of a recap gets its own name, the nominal ship none', async () => {
    const cwd = makeDir()
    const git = gitExec({ kind: 'ok', stdout: '' })
    const run = (extra: Partial<ShipTaskOptions>) =>
      shipTask({
        cwd,
        task: makeTask(),
        execGit: git.fn,
        execForge: forgeExec({ gh: { kind: 'ok', stdout: 'https://github.com/o/r/pull/9' } }).fn,
        ...extra,
      })
    const missing = await run({
      generateRecapFn: () => ({
        recap: null,
        degradations: [{ field: 'branch', reason: 'task record has no usable branch' }],
      }),
    })
    const blocked = await run({
      scanRecapSecretsFn: () => [
        { file: 'recap.md', reason: 'content', detail: 'an AWS access key id' },
      ],
    })
    const unscanned = await run({
      scanRecapSecretsFn: () => {
        throw new Error('boom')
      },
    })
    const nominal = await run({})
    expect([missing, blocked, unscanned, nominal].map((o) => o.pushed && o.recapState)).toEqual([
      'recap_missing',
      'recap_blocked_secrets',
      'recap_unscanned',
      undefined,
    ])
  })

  test('there is no --force escape hatch: a second identical ship is blocked too', async () => {
    const cwd = makeDir()
    const task = makeTask({
      turns: [
        {
          prompt: 'p',
          response: 'the key is AKIAIOSFODNN7EXAMPLE',
          question: null,
          started_at: new Date().toISOString(),
          ended_at: new Date().toISOString(),
        },
      ],
    })
    const git = gitExec({ kind: 'ok', stdout: '' })
    for (const _ of [1, 2]) {
      const forge = forgeExec({ gh: { kind: 'ok', stdout: 'https://github.com/o/r/pull/9' } })
      await shipTask({ cwd, task, execGit: git.fn, execForge: forge.fn })
      const body = forge.calls[0]?.args[forge.calls[0].args.indexOf('--body') + 1] ?? ''
      expect(body).not.toContain('AKIAIOSFODNN7EXAMPLE')
    }
  })
})

// --- gitops sandbox (lot C9, 'microvm' isolation) --------------------------

const OK: SandboxExecResult = { code: 0, stdout: '', stderr: '', timedOut: false }

class FakeGitopsHandle implements SandboxHandle {
  readonly name: string
  private readonly driver: FakeGitopsDriver
  constructor(driver: FakeGitopsDriver) {
    this.driver = driver
    this.name = driver.spec?.name ?? 'codesema-gitops-fake'
  }

  exec(
    command: string,
    args: readonly string[],
    opts: SandboxExecOptions,
  ): Promise<SandboxExecResult> {
    this.driver.log.push(`exec:${command}`)
    this.driver.execCalls.push({ command, args: [...args], opts })
    return Promise.resolve(this.driver.forgeResult)
  }

  shell(script: string, opts: SandboxExecOptions): Promise<SandboxExecResult> {
    const isPush = script.startsWith('git push')
    this.driver.log.push(isPush ? 'shell:push' : `shell:${script.split(' ')[0]}`)
    this.driver.shellCalls.push({ script, opts })
    return Promise.resolve(isPush ? this.driver.pushResult : OK)
  }

  copyFromHost(hostPath: string, guestPath: string): Promise<void> {
    this.driver.copyFromHostCalls.push({ hostPath, guestPath })
    return Promise.resolve()
  }

  copyToHost(): Promise<void> {
    return Promise.resolve()
  }

  writeFile(guestPath: string, content: string): Promise<void> {
    this.driver.writeFileCalls.push({ guestPath, content })
    return Promise.resolve()
  }

  readFile(): Promise<string> {
    return Promise.resolve('')
  }

  metrics(): Promise<SandboxMetrics> {
    return Promise.resolve({ memoryHostResidentBytes: null, memoryBytes: null, cpuPercent: null })
  }

  stop(): Promise<void> {
    return Promise.resolve()
  }
}

/** Minimal SandboxDriver fake, local to this file: lot C1's FakeSandboxDriver is not implemented yet. */
class FakeGitopsDriver implements SandboxDriver {
  readonly kind = 'fake' as const
  spec: SandboxSpec | null = null
  destroyed: string[] = []
  log: string[] = []
  execCalls: { command: string; args: string[]; opts: SandboxExecOptions }[] = []
  shellCalls: { script: string; opts: SandboxExecOptions }[] = []
  copyFromHostCalls: { hostPath: string; guestPath: string }[] = []
  writeFileCalls: { guestPath: string; content: string }[] = []
  pushResult: SandboxExecResult = OK
  forgeResult: SandboxExecResult = {
    code: 0,
    stdout: 'https://github.com/o/r/pull/1',
    stderr: '',
    timedOut: false,
  }

  probe(): Promise<SandboxProbe> {
    return Promise.reject(new Error('not used by shipTask'))
  }

  create(spec: SandboxSpec): Promise<SandboxHandle> {
    this.spec = spec
    return Promise.resolve(new FakeGitopsHandle(this))
  }

  snapshot(): Promise<SnapshotInfo> {
    return Promise.reject(new Error('not used by shipTask'))
  }

  listSandboxes(): Promise<string[]> {
    return Promise.resolve([])
  }

  listSnapshots(): Promise<SnapshotInfo[]> {
    return Promise.resolve([])
  }

  destroy(sandboxName: string): Promise<void> {
    this.destroyed.push(sandboxName)
    return Promise.resolve()
  }

  removeSnapshot(): Promise<void> {
    return Promise.reject(new Error('not used by shipTask'))
  }

  ensureVolume(): Promise<void> {
    return Promise.resolve()
  }

  removeVolume(): Promise<void> {
    return Promise.resolve()
  }
}

describe('shipTask with a gitops sandbox driver (lot C9)', () => {
  test('network policy is the forge host (+ its API host) and the alpine CDN only', async () => {
    const cwd = makeRepoWithOrigin('https://github.com/o/r.git')
    const driver = new FakeGitopsDriver()
    const outcome = await shipTask({
      cwd,
      task: makeTask(),
      driver,
      forgeToken: 'tok-123',
      forgeHost: 'github.com',
    })
    expect(outcome.pushed).toBe(true)
    expect(driver.spec?.image).toBe(GITOPS_IMAGE)
    expect((driver.spec?.network.allowedDomains ?? []).toSorted()).toEqual(
      ['github.com', 'api.github.com', 'dl-cdn.alpinelinux.org'].toSorted(),
    )
  })

  test('the forge token is declared as a secret, never placed in argv or in the plain env map', async () => {
    const cwd = makeRepoWithOrigin('https://gitlab.example.com/o/r.git')
    const driver = new FakeGitopsDriver()
    driver.forgeResult = {
      code: 0,
      stdout: 'https://gitlab.example.com/o/r/-/merge_requests/9',
      stderr: '',
      timedOut: false,
    }
    await shipTask({
      cwd,
      task: makeTask(),
      driver,
      forgeToken: 'super-secret-token',
      forgeHost: 'gitlab.example.com',
    })
    expect(driver.spec?.secrets).toEqual([
      { env: 'GITLAB_TOKEN', value: 'super-secret-token', allowedHosts: ['gitlab.example.com'] },
    ])
    // Never in the plain env map (which the guest process can dump straight to stdout).
    expect(driver.spec?.env).toBeUndefined()
    for (const call of [
      ...driver.shellCalls.map((c) => c.script),
      ...driver.execCalls.flatMap((c) => c.args),
    ]) {
      expect(call).not.toContain('super-secret-token')
    }
  })

  test('the worktree (cwd, not the task worktree) is copied into /work', async () => {
    const cwd = makeRepoWithOrigin('https://github.com/o/r.git')
    const driver = new FakeGitopsDriver()
    const task = makeTask({ worktree: '/somewhere/else/not-copied' })
    await shipTask({ cwd, task, driver, forgeToken: 't', forgeHost: 'github.com' })
    expect(driver.copyFromHostCalls).toEqual([{ hostPath: cwd, guestPath: '/work' }])
  })

  test('push happens before the forge MR-create call, both inside the sandbox', async () => {
    const cwd = makeRepoWithOrigin('https://github.com/o/r.git')
    const driver = new FakeGitopsDriver()
    await shipTask({ cwd, task: makeTask(), driver, forgeToken: 't', forgeHost: 'github.com' })
    const pushIndex = driver.log.indexOf('shell:push')
    const forgeIndex = driver.log.indexOf('exec:gh')
    expect(pushIndex).toBeGreaterThanOrEqual(0)
    expect(forgeIndex).toBeGreaterThan(pushIndex)
  })

  test('a failed push in the sandbox yields pushed:false with the error, and no forge call', async () => {
    const cwd = makeRepoWithOrigin('https://github.com/o/r.git')
    const driver = new FakeGitopsDriver()
    driver.pushResult = {
      code: 1,
      stdout: '',
      stderr: 'remote: permission denied',
      timedOut: false,
    }
    const outcome = await shipTask({
      cwd,
      task: makeTask(),
      driver,
      forgeToken: 't',
      forgeHost: 'github.com',
    })
    expect(outcome.pushed).toBe(false)
    expect(outcome.pushed === false && outcome.error).toContain('permission denied')
    expect(driver.execCalls).toHaveLength(0)
  })

  test('the sandbox is destroyed in finally, on both success and push failure', async () => {
    const cwdOk = makeRepoWithOrigin('https://github.com/o/r.git')
    const okDriver = new FakeGitopsDriver()
    await shipTask({
      cwd: cwdOk,
      task: makeTask(),
      driver: okDriver,
      forgeToken: 't',
      forgeHost: 'github.com',
    })
    expect(okDriver.destroyed).toEqual(okDriver.spec ? [okDriver.spec.name] : [])
    expect(okDriver.destroyed).toHaveLength(1)

    const cwdFail = makeRepoWithOrigin('https://github.com/o/r.git')
    const failDriver = new FakeGitopsDriver()
    failDriver.pushResult = { code: 1, stdout: '', stderr: 'denied', timedOut: false }
    await shipTask({
      cwd: cwdFail,
      task: makeTask(),
      driver: failDriver,
      forgeToken: 't',
      forgeHost: 'github.com',
    })
    expect(failDriver.destroyed).toEqual(failDriver.spec ? [failDriver.spec.name] : [])
    expect(failDriver.destroyed).toHaveLength(1)
  })

  test('no sandbox is ever created when the ship never gets past the no-remote gate', async () => {
    const cwd = makeDir()
    execFileSync('git', ['init', '-b', 'main'], { cwd, stdio: 'ignore' })
    const driver = new FakeGitopsDriver()
    const outcome = await shipTask({
      cwd,
      task: makeTask(),
      driver,
      forgeToken: 't',
      forgeHost: 'github.com',
    })
    expect(outcome.pushed).toBe(false)
    expect(driver.spec).toBeNull()
    expect(driver.destroyed).toEqual([])
  })

  test('an origin URL with embedded credentials is stripped before it reaches the sandbox shell', async () => {
    const cwd = makeRepoWithOrigin('https://git-user:s3cr3t-forge-token@github.com/o/r.git')
    const driver = new FakeGitopsDriver()
    await shipTask({
      cwd,
      task: makeTask(),
      driver,
      forgeToken: 't',
      forgeHost: 'github.com',
    })
    for (const call of [
      ...driver.shellCalls.map((c) => c.script),
      ...driver.execCalls.flatMap((c) => c.args),
    ]) {
      expect(call).not.toContain('s3cr3t-forge-token')
      expect(call).not.toContain('git-user')
    }
    const pushCall = driver.shellCalls.find((c) => c.script.startsWith('git push'))
    expect(pushCall?.script).toContain("'https://github.com/o/r.git'")
  })

  test('host git config that could carry credentials (credential.helper, http.*.extraheader) is neutralized before the placeholder helper is installed', async () => {
    const cwd = makeRepoWithOrigin('https://github.com/o/r.git')
    const driver = new FakeGitopsDriver()
    await shipTask({ cwd, task: makeTask(), driver, forgeToken: 't', forgeHost: 'github.com' })
    const scripts = driver.shellCalls.map((c) => c.script)
    const stripIndex = scripts.findIndex(
      (s) => s.includes('unset-all credential.helper') && s.includes('extraheader'),
    )
    const globalHelperIndex = scripts.findIndex((s) =>
      s.includes('git config --global credential.helper'),
    )
    expect(stripIndex).toBeGreaterThanOrEqual(0)
    expect(globalHelperIndex).toBeGreaterThan(stripIndex)
  })

  test('an ambiguous (self-hosted) forge host declares both GH_TOKEN and GITLAB_TOKEN, matching the two-CLI probe forgeCandidates runs on the same hint', async () => {
    const cwd = makeRepoWithOrigin('https://git.company.com/o/r.git')
    const driver = new FakeGitopsDriver()
    await shipTask({
      cwd,
      task: makeTask(),
      driver,
      forgeToken: 'ambiguous-token',
      forgeHost: 'git.company.com',
    })
    expect(driver.spec?.secrets).toEqual([
      { env: 'GH_TOKEN', value: 'ambiguous-token', allowedHosts: ['git.company.com'] },
      { env: 'GITLAB_TOKEN', value: 'ambiguous-token', allowedHosts: ['git.company.com'] },
    ])
  })

  test('a provided execGit/execForge test seam wins over the driver: the sandbox is never touched', async () => {
    const cwd = makeDir()
    const git = gitExec({ kind: 'ok', stdout: '' })
    const forge = forgeExec({ gh: { kind: 'ok', stdout: 'https://github.com/o/r/pull/1' } })
    const driver = new FakeGitopsDriver()
    const outcome = await shipTask({
      cwd,
      task: makeTask(),
      driver,
      forgeToken: 't',
      forgeHost: 'github.com',
      execGit: git.fn,
      execForge: forge.fn,
    })
    expect(outcome.pushed).toBe(true)
    expect(driver.spec).toBeNull()
    expect(git.calls.some((c) => c.args[0] === 'push')).toBe(true)
  })

  test('without a driver, shipTask behaves exactly as before (host git/forge, no sandbox concepts)', async () => {
    const cwd = makeDir()
    const git = gitExec({ kind: 'ok', stdout: '' })
    const forge = forgeExec({ gh: { kind: 'ok', stdout: 'https://github.com/o/r/pull/1' } })
    const outcome = await shipTask({ cwd, task: makeTask(), execGit: git.fn, execForge: forge.fn })
    expect(outcome).toMatchObject({ pushed: true, mrUrl: 'https://github.com/o/r/pull/1' })
  })
})

describe('toHttpsRemoteUrl', () => {
  test('leaves an https URL untouched', () => {
    expect(toHttpsRemoteUrl('https://github.com/o/r.git')).toBe('https://github.com/o/r.git')
  })

  test('converts an scp-style ssh origin (git@host:path)', () => {
    expect(toHttpsRemoteUrl('git@github.com:o/r.git')).toBe('https://github.com/o/r.git')
  })

  test('converts an ssh:// origin', () => {
    expect(toHttpsRemoteUrl('ssh://git@gitlab.example.com:2222/o/r.git')).toBe(
      'https://gitlab.example.com/o/r.git',
    )
  })

  test('null on something unreadable as either shape', () => {
    expect(toHttpsRemoteUrl('')).toBeNull()
  })

  test('strips embedded userinfo credentials from an https origin', () => {
    expect(toHttpsRemoteUrl('https://git-user:s3cr3t-token@github.com/o/r.git')).toBe(
      'https://github.com/o/r.git',
    )
  })

  test('leaves an https origin with no userinfo untouched', () => {
    expect(toHttpsRemoteUrl('https://gitlab.example.com/o/r.git')).toBe(
      'https://gitlab.example.com/o/r.git',
    )
  })
})
