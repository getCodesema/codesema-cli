import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import { PROBE_TIMEOUT_MS, subprocessEnv, tryExecAsync, tryGit } from './git.js'

describe('subprocessEnv', () => {
  test('purges variables that redirect git to a different repo', () => {
    const source = {
      PATH: '/usr/bin',
      GIT_DIR: '/some/other/repo/.git',
      GIT_WORK_TREE: '/some/other/repo',
      GIT_INDEX_FILE: '/some/other/repo/.git/index',
      GIT_OBJECT_DIRECTORY: '/some/other/repo/.git/objects',
      GIT_COMMON_DIR: '/some/other/repo/.git',
      GIT_PREFIX: 'sub/dir/',
      GIT_ALTERNATE_OBJECT_DIRECTORIES: '/some/other/repo/.git/objects-alt',
      GIT_QUARANTINE_PATH: '/some/other/repo/.git/objects/incoming',
    }
    const result = subprocessEnv(source)
    expect(result.GIT_DIR).toBeUndefined()
    expect(result.GIT_WORK_TREE).toBeUndefined()
    expect(result.GIT_INDEX_FILE).toBeUndefined()
    expect(result.GIT_OBJECT_DIRECTORY).toBeUndefined()
    expect(result.GIT_COMMON_DIR).toBeUndefined()
    expect(result.GIT_PREFIX).toBeUndefined()
    expect(result.GIT_ALTERNATE_OBJECT_DIRECTORIES).toBeUndefined()
    expect(result.GIT_QUARANTINE_PATH).toBeUndefined()
    expect(result.PATH).toBe('/usr/bin')
  })

  test('keeps legitimate user GIT_* settings untouched, not just non-GIT vars', () => {
    const source = {
      GIT_DIR: '/some/other/repo/.git',
      GIT_SSH_COMMAND: 'ssh -i ~/.ssh/deploy_key',
      GIT_AUTHOR_NAME: 'Ada Lovelace',
      GIT_AUTHOR_EMAIL: 'ada@example.com',
      GIT_COMMITTER_NAME: 'Ada Lovelace',
      GIT_COMMITTER_EMAIL: 'ada@example.com',
      GIT_CONFIG_GLOBAL: '/custom/gitconfig',
      GIT_ASKPASS: '/usr/bin/my-askpass',
    }
    const result = subprocessEnv(source)
    expect(result.GIT_DIR).toBeUndefined()
    expect(result.GIT_SSH_COMMAND).toBe('ssh -i ~/.ssh/deploy_key')
    expect(result.GIT_AUTHOR_NAME).toBe('Ada Lovelace')
    expect(result.GIT_AUTHOR_EMAIL).toBe('ada@example.com')
    expect(result.GIT_COMMITTER_NAME).toBe('Ada Lovelace')
    expect(result.GIT_COMMITTER_EMAIL).toBe('ada@example.com')
    expect(result.GIT_CONFIG_GLOBAL).toBe('/custom/gitconfig')
    expect(result.GIT_ASKPASS).toBe('/usr/bin/my-askpass')
  })

  test('defaults to process.env when no source is given', () => {
    const previous = process.env.GIT_DIR
    process.env.GIT_DIR = '/some/other/repo/.git'
    try {
      const result = subprocessEnv()
      expect(result.GIT_DIR).toBeUndefined()
    } finally {
      if (previous === undefined) {
        delete process.env.GIT_DIR
      } else {
        process.env.GIT_DIR = previous
      }
    }
  })
})

describe('tryExecAsync', () => {
  test('keeps tryExec semantics: null when the binary is missing, never a throw', async () => {
    expect(await tryExecAsync('codesema-no-such-binary', ['--version'], process.cwd())).toBeNull()
  })

  test('keeps tryExec semantics: trimmed stdout on success, argv only', async () => {
    expect(await tryExecAsync('git', ['--version'], process.cwd())).toMatch(/^git version/)
  })

  test('null on a failing command, like its blocking sibling', async () => {
    expect(await tryExecAsync('git', ['not-a-git-command'], process.cwd())).toBeNull()
  })

  test('the per-probe budget is unchanged (8s), only the waiting is shared', () => {
    expect(PROBE_TIMEOUT_MS).toBe(8000)
  })
})

// `GitCallOptions` arrived with T1.9 as the seat belt of the retention pass:
// its `git status` runs UNATTENDED, at boot, against a path this process does
// not control, and a worktree on a suspended network mount makes git block
// forever. The whole value of that budget is the shape of the answer it
// produces — `tryGit` returns `null`, "could not determine", which the caller
// reads as "do not destroy anything". Ignored, the same call comes back an
// EMPTY STRING once the hang eventually clears, and an empty porcelain status
// reads as CLEAN: the protective `null` becomes a permissive `''` and
// `git worktree remove --force` proceeds (DP16). Proven on a real hang, with a
// budget short enough to cost the suite nothing.
describe('GitCallOptions', () => {
  const repo = mkdtempSync(join(tmpdir(), 'codesema-git-budget-'))
  const run = (args: string[]): void => {
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
      cwd: repo,
      stdio: 'ignore',
    })
  }
  run(['init', '-b', 'main'])
  writeFileSync(join(repo, 'base.txt'), 'a\n')
  run(['add', '-A'])
  run(['commit', '-m', 'init'])

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  test('a git call that outlives its budget is cut short and answers null, never an empty string', () => {
    const started = Date.now()
    // A shell alias that simply sleeps: a real git process that really hangs,
    // no fake, no injected clock.
    const result = tryGit(['-c', 'alias.hang=!sleep 4', 'hang'], repo, { timeoutMs: 500 })
    const elapsed = Date.now() - started

    // `''` here would be the disaster: it is exactly what a clean worktree
    // looks like to the retention guard.
    expect(result).toBeNull()
    expect(elapsed).toBeLessThan(2500)
  })

  test('a budget large enough is simply not in the way: the command still answers', () => {
    expect(tryGit(['rev-parse', '--abbrev-ref', 'HEAD'], repo, { timeoutMs: 30_000 })).toBe('main')
  })
})
