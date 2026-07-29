import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listLocalBranches, listWorktrees } from './branches.js'

let repo: string
let otherWorktree: string

function run(args: string[]) {
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: repo, stdio: 'ignore' })
}

function commitFile(name: string, content: string, msg: string) {
  writeFileSync(join(repo, name), content)
  run(['add', '-A'])
  run(['commit', '-m', msg])
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'codesema-branches-test-'))
  run(['init', '-b', 'main'])
  commitFile('base.txt', 'a\n', 'init: base')
  run(['checkout', '-b', 'feature/a'])
  commitFile('a.txt', 'a\n', 'feat: a')
  run(['checkout', '-b', 'feature/b', 'main'])
  commitFile('b.txt', 'b\n', 'feat: b')
  run(['checkout', 'main'])

  otherWorktree = mkdtempSync(join(tmpdir(), 'codesema-branches-test-wt-'))
  run(['worktree', 'add', otherWorktree, 'feature/b'])
})

afterAll(() => {
  rmSync(repo, { recursive: true, force: true })
  rmSync(otherWorktree, { recursive: true, force: true })
})

describe('listWorktrees', () => {
  test('lists the main worktree and any linked worktree with their checked-out branch', () => {
    const worktrees = listWorktrees(repo)
    expect(worktrees).toContainEqual({ path: repo, branch: 'main' })
    expect(worktrees).toContainEqual({ path: otherWorktree, branch: 'feature/b' })
  })

  test('returns an empty array outside a git repo', () => {
    expect(listWorktrees(tmpdir())).toEqual([])
  })
})

describe('listLocalBranches', () => {
  test('flags the current branch and branches checked out in another worktree', () => {
    const branches = listLocalBranches(repo)
    const main = branches.find((b) => b.name === 'main')
    const a = branches.find((b) => b.name === 'feature/a')
    const b = branches.find((b) => b.name === 'feature/b')

    expect(main).toMatchObject({ isCurrent: true })
    expect(main?.worktreePath).toBe(repo)
    expect(a).toMatchObject({ isCurrent: false, worktreePath: null })
    expect(b).toMatchObject({ isCurrent: false })
    expect(b?.worktreePath).toBe(otherWorktree)
  })

  test('carries the last commit subject and relative date', () => {
    const branches = listLocalBranches(repo)
    const a = branches.find((b) => b.name === 'feature/a')
    expect(a?.subject).toBe('feat: a')
    expect(a?.lastCommitRelative.length).toBeGreaterThan(0)
  })
})
