import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { listLocalBranches } from './branches.js'
import { subprocessEnv, tryGit } from './git.js'

let repo: string

function run(args: string[], date?: string) {
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd: repo,
    stdio: 'ignore',
    env: date
      ? { ...subprocessEnv(), GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
      : subprocessEnv(),
  })
}

function commitFile(name: string, content: string, msg: string, date?: string) {
  writeFileSync(join(repo, name), content)
  run(['add', '-A'])
  run(['commit', '-m', msg], date)
}

// Fixture: three branches committed at strictly increasing dates so the
// -committerdate sort listLocalBranches asks for is deterministic (newest tip
// first): feature/x, then develop, then main.
//
// realpathSync on the mkdtemp path is the whole point of this file: on macOS
// os.tmpdir() returns /var/folders/... which is a symlink to /private/var/...,
// and git resolves it, so the raw mkdtemp path never equals git's own output.
beforeAll(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'codesema-branches-')))
  run(['init', '-b', 'main'])
  commitFile('base.txt', 'a\n', 'chore: base', '2026-01-01T00:00:00')
  run(['checkout', '-b', 'develop'])
  commitFile('dev.txt', 'dev\n', 'feat: develop work', '2026-02-01T00:00:00')
  run(['checkout', '-b', 'feature/x'])
  commitFile('feat.txt', 'x\n', 'feat: feature work', '2026-03-01T00:00:00')
})

afterAll(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('listLocalBranches', () => {
  test('returns every local branch with its subject, only the checked-out one flagged', () => {
    const branches = listLocalBranches(repo)

    expect(branches.map((b) => b.name).toSorted()).toEqual(['develop', 'feature/x', 'main'])
    expect(branches.filter((b) => b.isCurrent).map((b) => b.name)).toEqual(['feature/x'])
    expect(branches.find((b) => b.name === 'develop')?.subject).toBe('feat: develop work')
  })

  test('orders branches by most recent commit first (-committerdate)', () => {
    expect(listLocalBranches(repo).map((b) => b.name)).toEqual(['feature/x', 'develop', 'main'])
  })

  test('non-git directory: empty list, never throws', () => {
    const empty = realpathSync(mkdtempSync(join(tmpdir(), 'codesema-branches-empty-')))
    try {
      expect(listLocalBranches(empty)).toEqual([])
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})

describe('worktree path resolution (macOS symlinked tmpdir)', () => {
  // Regression guard for the symlinked-tmpdir flake: listLocalBranches runs
  // through git.ts::tryGit, which reports the resolved worktree path. Comparing
  // it to the temp repo requires realpathSync on both sides, or the equality
  // spuriously fails on macOS (/var/folders -> /private/var) while passing on Linux.
  test('git worktree path equals the realpath-normalized temp repo', () => {
    const porcelain = tryGit(['worktree', 'list', '--porcelain'], repo)
    const worktreeLine = porcelain?.split('\n').find((line) => line.startsWith('worktree ')) ?? ''
    const worktreePath = worktreeLine.slice('worktree '.length)

    expect(realpathSync(worktreePath)).toBe(realpathSync(repo))
  })
})
