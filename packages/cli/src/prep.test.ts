import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectTarget, prep } from './prep.js'

let repo: string

function run(args: string[]) {
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: repo, stdio: 'ignore' })
}

function commitFile(name: string, content: string, msg: string) {
  writeFileSync(join(repo, name), content)
  run(['add', '-A'])
  run(['commit', '-m', msg])
}

// Fixture repo topology: main (2 commits) -> develop (1 commit) -> feature/x (1 commit).
// develop is the closest merge-base to the feature branch.
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'codesema-test-'))
  run(['init', '-b', 'main'])
  commitFile('base.txt', 'a\n', 'init: base')
  commitFile('base.txt', 'a\nb\n', 'chore: main grows')
  run(['checkout', '-b', 'develop'])
  commitFile('dev.txt', 'dev\n', 'feat: develop work')
  run(['checkout', '-b', 'feature/x'])
  commitFile('café.txt', 'contenu accentué\n', 'feat: fichier accentué')
})

afterAll(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('detectTarget', () => {
  test('valid --target resolved, source = flag', () => {
    expect(detectTarget('feature/x', 'develop', repo)).toEqual({ target: 'develop', source: '--target flag' })
  })

  test('--target not found: explicit error', () => {
    expect(() => detectTarget('feature/x', 'nope', repo)).toThrow(/branch not found/)
  })

  test('heuristic: branch at the closest merge-base (develop, not main)', () => {
    const { target, source } = detectTarget('feature/x', undefined, repo)
    expect(target).toBe('develop')
    expect(source).toContain('heuristic')
  })
})

describe('prep', () => {
  test('complete input, non-ASCII paths intact', () => {
    const input = prep({ target: 'develop', cwd: repo })
    expect(input.branch).toBe('feature/x')
    expect(input.target).toBe('develop')
    expect(input.commits).toEqual(['feat: fichier accentué'])
    expect(input.files.map((f) => f.path)).toEqual(['café.txt'])
    expect(input.diff).toContain('+++ b/café.txt')
    expect(input.diff).not.toContain('\\303')
  })

  test('current branch = target: error', () => {
    run(['checkout', 'develop'])
    try {
      expect(() => prep({ target: 'develop', cwd: repo })).toThrow(/target branch itself/)
    } finally {
      run(['checkout', 'feature/x'])
    }
  })

  test('detached HEAD: error', () => {
    run(['checkout', '--detach'])
    try {
      expect(() => prep({ target: 'develop', cwd: repo })).toThrow(/detached HEAD/)
    } finally {
      run(['checkout', 'feature/x'])
    }
  })
})
