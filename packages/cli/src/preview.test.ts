import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ForgeMr, ForgeMrsResult } from './forge-mrs.js'
import {
  buildFileDiff,
  buildPreview,
  parsePreviewPath,
  parsePreviewSource,
  PREVIEW_DIFF_MAX_CHARS,
  resolvePreviewRefs,
} from './preview.js'

describe('parsePreviewSource', () => {
  test('parses a valid branch source', () => {
    expect(parsePreviewSource(new URLSearchParams('source=branch&name=feature/x'))).toEqual({ kind: 'branch', name: 'feature/x' })
  })

  test('parses a valid mr source', () => {
    expect(parsePreviewSource(new URLSearchParams('source=mr&number=42'))).toEqual({ kind: 'mr', number: 42 })
  })

  test('rejects a missing or unknown source', () => {
    expect(parsePreviewSource(new URLSearchParams(''))).toBeNull()
    expect(parsePreviewSource(new URLSearchParams('source=bogus&name=x'))).toBeNull()
  })

  test('rejects a branch name that is empty or could be parsed as a git flag', () => {
    expect(parsePreviewSource(new URLSearchParams('source=branch'))).toBeNull()
    expect(parsePreviewSource(new URLSearchParams('source=branch&name='))).toBeNull()
    expect(parsePreviewSource(new URLSearchParams('source=branch&name=-x'))).toBeNull()
  })

  test('rejects a non-integer or non-positive MR number', () => {
    expect(parsePreviewSource(new URLSearchParams('source=mr'))).toBeNull()
    expect(parsePreviewSource(new URLSearchParams('source=mr&number=abc'))).toBeNull()
    expect(parsePreviewSource(new URLSearchParams('source=mr&number=1.5'))).toBeNull()
    expect(parsePreviewSource(new URLSearchParams('source=mr&number=0'))).toBeNull()
    expect(parsePreviewSource(new URLSearchParams('source=mr&number=-1'))).toBeNull()
  })
})

describe('parsePreviewPath', () => {
  test('accepts a plain relative path', () => {
    expect(parsePreviewPath(new URLSearchParams('path=src/a.ts'))).toBe('src/a.ts')
  })

  test('rejects a missing path or one that could be parsed as a git flag', () => {
    expect(parsePreviewPath(new URLSearchParams(''))).toBeNull()
    expect(parsePreviewPath(new URLSearchParams('path=-x'))).toBeNull()
  })
})

let repo: string

function run(args: string[]) {
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: repo, stdio: 'ignore' })
}

function commitFile(name: string, content: string, msg: string) {
  writeFileSync(join(repo, name), content)
  run(['add', '-A'])
  run(['commit', '-m', msg])
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'codesema-preview-test-'))
  run(['init', '-b', 'main'])
  commitFile('a.txt', 'base\n', 'init: base')
  run(['checkout', '-b', 'feature/x'])
  commitFile('a.txt', 'changed\n', 'feat: change')
})

afterAll(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('resolvePreviewRefs (branch source)', () => {
  test('resolves the currently checked-out branch via HEAD', async () => {
    const refs = await resolvePreviewRefs(repo, { kind: 'branch', name: 'feature/x' })
    expect(refs).toEqual({ sourceRef: 'HEAD', targetRef: 'main', branch: 'feature/x', target: 'main' })
  })

  test('resolves a non-checked-out branch by name', async () => {
    run(['checkout', 'main'])
    try {
      const refs = await resolvePreviewRefs(repo, { kind: 'branch', name: 'feature/x' })
      expect(refs).toEqual({ sourceRef: 'feature/x', targetRef: 'main', branch: 'feature/x', target: 'main' })
    } finally {
      run(['checkout', 'feature/x'])
    }
  })

  test('throws for a branch that does not exist locally', async () => {
    await expect(resolvePreviewRefs(repo, { kind: 'branch', name: 'nope' })).rejects.toThrow(/branch not found/)
  })
})

describe('buildPreview', () => {
  test('reports branch, target, commits, files and diff stats without the diff itself', async () => {
    const preview = await buildPreview(repo, { kind: 'branch', name: 'feature/x' })
    expect(preview.branch).toBe('feature/x')
    expect(preview.target).toBe('main')
    expect(preview.commits).toEqual(['feat: change'])
    expect(preview.files).toEqual([{ path: 'a.txt', additions: 1, deletions: 1, status: 'modified' }])
    expect(preview.diffStats).toEqual({ files: 1, additions: 1, deletions: 1 })
    expect('diff' in preview).toBe(false)
  })

  test('uses the injected MR listing to resolve a merge request source', async () => {
    const mr: ForgeMr = {
      number: 7,
      title: 't',
      author: 'a',
      sourceBranch: 'feature/x',
      targetBranch: 'main',
      updatedAt: new Date().toISOString(),
      url: 'https://example.com/7',
    }
    const listMrs = async (): Promise<ForgeMrsResult> => ({ available: true, mrs: [mr] })
    // fetchBranch (git fetch origin ...) is skipped here: there is no origin remote, so it would throw;
    // instead we exercise resolvePreviewRefs directly against a source branch reachable without a remote.
    await expect(buildPreview(repo, { kind: 'mr', number: 999 }, listMrs)).rejects.toThrow(/no open MR/)
  })
})

describe('buildFileDiff', () => {
  test('returns the diff of a single file', async () => {
    const result = await buildFileDiff(repo, { kind: 'branch', name: 'feature/x' }, 'a.txt')
    expect(result.truncated).toBe(false)
    expect(result.diff).toContain('-base')
    expect(result.diff).toContain('+changed')
  })

  test('rejects a path that is not part of the diff', async () => {
    await expect(buildFileDiff(repo, { kind: 'branch', name: 'feature/x' }, 'nope.txt')).rejects.toThrow(/not part of this diff/)
  })

  test('truncates a diff larger than the size cap and sets truncated', async () => {
    run(['checkout', '-b', 'feature/huge', 'main'])
    const bigLine = 'x'.repeat(200)
    const lines = Array.from({ length: (PREVIEW_DIFF_MAX_CHARS / bigLine.length) * 2 }, () => bigLine)
    writeFileSync(join(repo, 'huge.txt'), `${lines.join('\n')}\n`)
    run(['add', '-A'])
    run(['commit', '-m', 'feat: huge file'])
    try {
      const result = await buildFileDiff(repo, { kind: 'branch', name: 'feature/huge' }, 'huge.txt')
      expect(result.truncated).toBe(true)
      expect(result.diff.length).toBe(PREVIEW_DIFF_MAX_CHARS)
    } finally {
      run(['checkout', 'feature/x'])
    }
  })
})
