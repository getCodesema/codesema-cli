import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { refExists, tryGit } from './git.js'
import {
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
    expect(detectTaskBase(repo)).toBe('origin/main')
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
