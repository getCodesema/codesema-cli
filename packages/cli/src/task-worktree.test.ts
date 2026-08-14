import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { refExists, tryGit } from './git.js'
import {
  branchCheckoutPath,
  BranchInUseError,
  createTaskWorktree,
  detectTaskBase,
  removeTaskWorktree,
  taskWorktreePath,
} from './task-worktree.js'

const cleanups: string[] = []

function makeRepo(defaultBranch = 'main'): string {
  const repo = mkdtempSync(join(tmpdir(), 'codesema-task-wt-'))
  cleanups.push(repo)
  const run = (args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
      cwd: repo,
      stdio: 'ignore',
    })
  run(['init', '-b', defaultBranch])
  writeFileSync(join(repo, 'base.txt'), 'a\n')
  run(['add', '-A'])
  run(['commit', '-m', 'init: base'])
  return repo
}

afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('detectTaskBase', () => {
  test('origin/HEAD wins when the remote default branch is known', () => {
    const repo = makeRepo('main')
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'main'], { cwd: repo })
    execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], {
      cwd: repo,
    })
    // Identity is the SHORT name: origin/HEAD names origin/main, the base is 'main'.
    expect(detectTaskBase(repo)).toBe('main')
  })

  test('falls back to develop before main', () => {
    const repo = makeRepo('main')
    execFileSync('git', ['branch', 'develop'], { cwd: repo })
    expect(detectTaskBase(repo)).toBe('develop')
  })

  test('plain main-only repo resolves to main', () => {
    expect(detectTaskBase(makeRepo('main'))).toBe('main')
  })

  test('throws a readable error when no candidate exists', () => {
    const repo = makeRepo('trunk')
    expect(() => detectTaskBase(repo)).toThrow(/base branch/)
  })
})

describe('createTaskWorktree', () => {
  test('creates the branch from the base and checks it out under .codesema/worktrees/<id>', () => {
    const repo = makeRepo('main')
    const wt = createTaskWorktree(repo, 'aaaabbbbcccc', 'Fix the bug!')
    expect(wt.base).toBe('main')
    expect(wt.branch).toBe('codesema/task-fix-the-bug')
    expect(wt.worktree).toBe(taskWorktreePath(repo, 'aaaabbbbcccc'))
    expect(existsSync(join(wt.worktree, 'base.txt'))).toBe(true)
    expect(refExists('refs/heads/codesema/task-fix-the-bug', repo)).toBe(true)
    // The main worktree keeps its checkout: the task branch is only in the task worktree.
    expect(tryGit(['rev-parse', '--abbrev-ref', 'HEAD'], repo)).toBe('main')
    expect(tryGit(['rev-parse', '--abbrev-ref', 'HEAD'], wt.worktree)).toBe(
      'codesema/task-fix-the-bug',
    )
  })

  test('an unusable title still yields a branch name', () => {
    const repo = makeRepo('main')
    const wt = createTaskWorktree(repo, 'aaaabbbbcccc', '!!! ???')
    expect(wt.branch).toBe('codesema/task-task')
  })

  test('a branch name collision gets a numeric suffix', () => {
    const repo = makeRepo('main')
    execFileSync('git', ['branch', 'codesema/task-fix-the-bug'], { cwd: repo })
    execFileSync('git', ['branch', 'codesema/task-fix-the-bug-2'], { cwd: repo })
    const wt = createTaskWorktree(repo, 'aaaabbbbcccc', 'Fix the bug')
    expect(wt.branch).toBe('codesema/task-fix-the-bug-3')
  })

  test('an explicit base branches from IT, not from the detected default', () => {
    const repo = makeRepo('main')
    const run = (args: string[]) =>
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
        cwd: repo,
        stdio: 'ignore',
      })
    // A branch whose content diverges from main, checked back out of.
    run(['checkout', '-b', 'feature'])
    writeFileSync(join(repo, 'feature.txt'), 'f\n')
    run(['add', '-A'])
    run(['commit', '-m', 'feat: feature file'])
    run(['checkout', 'main'])
    const featureSha = execFileSync('git', ['rev-parse', 'feature'], { cwd: repo })
      .toString()
      .trim()

    const wt = createTaskWorktree(repo, 'aaaabbbbcccc', 'from feature', { base: 'feature' })
    expect(wt.base).toBe('feature')
    // The worktree starts at feature's commit: its extra file is there and
    // the task branch head IS the feature head.
    expect(existsSync(join(wt.worktree, 'feature.txt'))).toBe(true)
    expect(tryGit(['rev-parse', 'HEAD'], wt.worktree)).toBe(featureSha)

    // Auto-detection is untouched: without a base the task branches from main,
    // which never had the feature file.
    const auto = createTaskWorktree(repo, 'ddddeeeeffff', 'from default')
    expect(auto.base).toBe('main')
    expect(existsSync(join(auto.worktree, 'feature.txt'))).toBe(false)
  })

  test('an unknown explicit base throws BEFORE anything is created', () => {
    const repo = makeRepo('main')
    expect(() => createTaskWorktree(repo, 'aaaabbbbcccc', 'nope task', { base: 'nope' })).toThrow(
      /nope/,
    )
    expect(existsSync(taskWorktreePath(repo, 'aaaabbbbcccc'))).toBe(false)
    expect(refExists('refs/heads/codesema/task-nope-task', repo)).toBe(false)
  })

  test('an option-lookalike base never reaches git as a flag', () => {
    const repo = makeRepo('main')
    // refs/heads/-evil does not exist: the refExists guard throws first.
    expect(() => createTaskWorktree(repo, 'aaaabbbbcccc', 'evil', { base: '-evil' })).toThrow()
    expect(existsSync(taskWorktreePath(repo, 'aaaabbbbcccc'))).toBe(false)
  })

  test('two tasks with the same title get distinct branches and worktrees', () => {
    const repo = makeRepo('main')
    const first = createTaskWorktree(repo, 'aaaabbbbcccc', 'same title')
    const second = createTaskWorktree(repo, 'ddddeeeeffff', 'same title')
    expect(first.branch).toBe('codesema/task-same-title')
    expect(second.branch).toBe('codesema/task-same-title-2')
    expect(first.worktree).not.toBe(second.worktree)
    expect(existsSync(second.worktree)).toBe(true)
  })
})

/** A repo with a 'feature' branch that is NOT checked out anywhere. */
function makeRepoWithFeature(): { repo: string; featureSha: string } {
  const repo = makeRepo('main')
  const run = (args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
      cwd: repo,
      stdio: 'ignore',
    })
  run(['checkout', '-b', 'feature'])
  writeFileSync(join(repo, 'feature.txt'), 'f\n')
  run(['add', '-A'])
  run(['commit', '-m', 'feat: feature file'])
  run(['checkout', 'main'])
  const featureSha = execFileSync('git', ['rev-parse', 'feature'], { cwd: repo }).toString().trim()
  return { repo, featureSha }
}

describe('branchCheckoutPath', () => {
  test('the MAIN worktree counts; a free branch is null', () => {
    const { repo } = makeRepoWithFeature()
    expect(branchCheckoutPath(repo, 'main')).not.toBeNull()
    expect(branchCheckoutPath(repo, 'feature')).toBeNull()
  })
})

describe('createTaskWorktree (work-on mode)', () => {
  test('checks the branch ITSELF out: commits in the worktree land on refs/heads/<branch>', () => {
    const { repo, featureSha } = makeRepoWithFeature()
    const wt = createTaskWorktree(repo, 'aaaabbbbcccc', 'Work on feature', { branch: 'feature' })
    expect(wt.branch).toBe('feature')
    expect(wt.worktree).toBe(taskWorktreePath(repo, 'aaaabbbbcccc'))
    // The worktree IS the branch: no derived codesema/task-* ref anywhere.
    expect(tryGit(['rev-parse', '--abbrev-ref', 'HEAD'], wt.worktree)).toBe('feature')
    expect(tryGit(['rev-parse', 'HEAD'], wt.worktree)).toBe(featureSha)
    expect(refExists('refs/heads/codesema/task-work-on-feature', repo)).toBe(false)
    // A commit made in the worktree (as the runner does at end of turn)
    // advances the branch itself, visible from the main repo.
    writeFileSync(join(wt.worktree, 'work.txt'), 'w\n')
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], {
      cwd: wt.worktree,
      stdio: 'ignore',
    })
    execFileSync(
      'git',
      ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'task: work'],
      { cwd: wt.worktree, stdio: 'ignore' },
    )
    expect(tryGit(['rev-parse', 'refs/heads/feature'], repo)).toBe(
      tryGit(['rev-parse', 'HEAD'], wt.worktree),
    )
    expect(tryGit(['rev-parse', 'refs/heads/feature'], repo)).not.toBe(featureSha)
  })

  test('an unknown branch throws BEFORE anything is created', () => {
    const repo = makeRepo('main')
    expect(() => createTaskWorktree(repo, 'aaaabbbbcccc', 'nope', { branch: 'ghost' })).toThrow(
      /ghost/,
    )
    expect(existsSync(taskWorktreePath(repo, 'aaaabbbbcccc'))).toBe(false)
  })

  test('a branch checked out in the MAIN worktree is a typed conflict, no residue', () => {
    const repo = makeRepo('main')
    let caught: unknown
    try {
      createTaskWorktree(repo, 'aaaabbbbcccc', 'steal main', { branch: 'main' })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(BranchInUseError)
    expect((caught as BranchInUseError).branch).toBe('main')
    // Compared through the same lens (git may print a resolved tmpdir path).
    expect((caught as BranchInUseError).worktreePath).toBe(branchCheckoutPath(repo, 'main') ?? '')
    expect(existsSync(taskWorktreePath(repo, 'aaaabbbbcccc'))).toBe(false)
  })

  test('a branch checked out in a SECONDARY worktree conflicts too, no residue', () => {
    const { repo } = makeRepoWithFeature()
    const other = join(repo, '.codesema', 'other-checkout')
    execFileSync('git', ['worktree', 'add', other, 'feature'], { cwd: repo, stdio: 'ignore' })
    expect(() =>
      createTaskWorktree(repo, 'aaaabbbbcccc', 'busy branch', { branch: 'feature' }),
    ).toThrow(BranchInUseError)
    expect(existsSync(taskWorktreePath(repo, 'aaaabbbbcccc'))).toBe(false)
  })

  test("the task's OWN stale worktree does not block re-materialization on the same branch", () => {
    const { repo } = makeRepoWithFeature()
    const first = createTaskWorktree(repo, 'aaaabbbbcccc', 'Work on feature', {
      branch: 'feature',
    })
    // Simulate a crash: the directory vanishes but git still registers it —
    // the branch would look checked out without the stale cleanup.
    rmSync(first.worktree, { recursive: true, force: true })
    const again = createTaskWorktree(repo, 'aaaabbbbcccc', 'Work on feature', {
      branch: 'feature',
    })
    expect(tryGit(['rev-parse', '--abbrev-ref', 'HEAD'], again.worktree)).toBe('feature')
  })
})

describe('removeTaskWorktree', () => {
  test('removes the worktree, keeps the branch by default', () => {
    const repo = makeRepo('main')
    const wt = createTaskWorktree(repo, 'aaaabbbbcccc', 'cleanup me')
    removeTaskWorktree(repo, 'aaaabbbbcccc', wt.branch, { deleteBranch: false })
    expect(existsSync(wt.worktree)).toBe(false)
    expect(refExists(`refs/heads/${wt.branch}`, repo)).toBe(true)
  })

  test('deleteBranch also drops the branch', () => {
    const repo = makeRepo('main')
    const wt = createTaskWorktree(repo, 'aaaabbbbcccc', 'cleanup me')
    removeTaskWorktree(repo, 'aaaabbbbcccc', wt.branch, { deleteBranch: true })
    expect(refExists(`refs/heads/${wt.branch}`, repo)).toBe(false)
  })

  test('best-effort: removing a task that never had a worktree does not throw', () => {
    const repo = makeRepo('main')
    expect(() =>
      removeTaskWorktree(repo, 'ffffffffffff', 'codesema/task-none', { deleteBranch: true }),
    ).not.toThrow()
  })
})

describe('branch identity unification (origin/x === x)', () => {
  test("an explicit base 'origin/<name>' normalizes to the short identity", () => {
    const repo = makeRepo()
    const made = createTaskWorktree(repo, 'aaaaaaaaaaa1', 'from origin base', {
      base: 'origin/main',
    })
    // No refs/remotes here: 'origin/main' resolves to the LOCAL main head.
    expect(made.base).toBe('main')
    expect(made.branch.startsWith('codesema/task-')).toBe(true)
  })

  test('work-on a remote-only branch creates the local tracking head, same identity', () => {
    const repo = makeRepo()
    // Simulate a teammate's branch never pulled: a remote-tracking ref only.
    execFileSync('git', ['update-ref', 'refs/remotes/origin/feature/remote-only', 'main'], {
      cwd: repo,
    })
    const made = createTaskWorktree(repo, 'aaaaaaaaaaa2', 'work on remote', {
      branch: 'feature/remote-only',
    })
    expect(made.branch).toBe('feature/remote-only')
    expect(refExists('refs/heads/feature/remote-only', repo)).toBe(true)
  })

  test('fork from a remote-only base works too', () => {
    const repo = makeRepo()
    execFileSync('git', ['update-ref', 'refs/remotes/origin/only-remote', 'main'], { cwd: repo })
    const made = createTaskWorktree(repo, 'aaaaaaaaaaa3', 'fork remote base', {
      base: 'only-remote',
    })
    expect(made.base).toBe('only-remote')
  })
})
