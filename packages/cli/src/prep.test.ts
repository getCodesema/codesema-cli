import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

  test('rules: null without RULES.md, formatted [Cn] grid lines with it', () => {
    expect(prep({ target: 'develop', cwd: repo, quiet: true }).rules).toBeNull()
    mkdirSync(join(repo, '.codesema'), { recursive: true })
    const rulesPath = join(repo, '.codesema', 'RULES.md')
    writeFileSync(rulesPath, '# Rules\n- no any | Where to look: exported APIs\n')
    try {
      const input = prep({ target: 'develop', cwd: repo, quiet: true })
      expect(input.rules).toEqual(['[C1] no any | Where to look: exported APIs'])
    } finally {
      rmSync(rulesPath, { force: true })
    }
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

  test('truncation counts code points and never splits a surrogate pair', () => {
    run(['checkout', '-b', 'feature/emoji-subject', 'develop'])
    try {
      commitFile('emoji.txt', 'x\n', `feat: ${'🚀'.repeat(200)}`)
      const input = prep({ target: 'develop', cwd: repo, quiet: true })
      const subject = input.commits[0] ?? ''
      expect(subject.endsWith('…')).toBe(true)
      expect(Array.from(subject)).toHaveLength(120)
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(subject)).toBe(false)
    } finally {
      run(['checkout', 'feature/x'])
    }
  })

  test('overlong commit subjects are truncated with an ellipsis', () => {
    run(['checkout', '-b', 'feature/long-subject', 'develop'])
    try {
      commitFile('long.txt', 'x\n', `feat: ${'y'.repeat(400)}`)
      const input = prep({ target: 'develop', cwd: repo, quiet: true })
      expect(input.commits).toHaveLength(1)
      expect(input.commits[0]?.length).toBeLessThanOrEqual(120)
      expect(input.commits[0]?.startsWith('feat: ')).toBe(true)
      expect(input.commits[0]?.endsWith('…')).toBe(true)
    } finally {
      run(['checkout', 'feature/x'])
    }
  })

  test('impact_candidates: null when the diff touches no supported source file', () => {
    const input = prep({ target: 'develop', cwd: repo, quiet: true })
    expect(input.impact_candidates).toBeNull()
  })

  test('diff carries 10 context lines around each change', () => {
    run(['checkout', 'develop'])
    const lines = Array.from({ length: 30 }, (_, i) => `line${i + 1}`)
    writeFileSync(join(repo, 'context.txt'), `${lines.join('\n')}\n`)
    run(['add', '-A'])
    run(['commit', '-m', 'chore: add context file'])
    run(['checkout', '-b', 'feature/context'])
    try {
      lines[14] = 'line15 changed'
      writeFileSync(join(repo, 'context.txt'), `${lines.join('\n')}\n`)
      run(['add', '-A'])
      run(['commit', '-m', 'feat: change middle line'])
      const input = prep({ target: 'develop', cwd: repo, quiet: true })
      expect(input.diff).toContain('line7\n')
      expect(input.diff).toContain('line23\n')
    } finally {
      run(['checkout', 'feature/x'])
    }
  })

  test('impact_candidates: filled when a changed export has callers outside the diff', () => {
    run(['checkout', 'develop'])
    writeFileSync(join(repo, 'greeting.ts'), 'export function greetUser(name: string): string {\n  return name\n}\n')
    writeFileSync(join(repo, 'consumer.ts'), "import { greetUser } from './greeting'\nconsole.log(greetUser('a'))\n")
    run(['add', '-A'])
    run(['commit', '-m', 'chore: add greeting and consumer'])
    run(['checkout', '-b', 'feature/impact'])
    try {
      commitFile('greeting.ts', 'export function greetUser(name: string, loud: boolean): string {\n  return name\n}\n', 'feat: loud greeting')
      const input = prep({ target: 'develop', cwd: repo, quiet: true })
      const symbol = input.impact_candidates?.symbols.find((s) => s.name === 'greetUser')
      expect(symbol?.change).toBe('modified')
      expect(symbol?.used_at).toContain('consumer.ts:2')
      expect(input.impact_candidates?.imported_by['greeting.ts']).toContain('consumer.ts')
    } finally {
      run(['checkout', 'feature/x'])
    }
  })
})
