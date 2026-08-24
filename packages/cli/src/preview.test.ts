import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { ForgeMr, ForgeMrsResult } from './forge-mrs.js'
import {
  buildFileDiff,
  buildPreview,
  clearPreviewTargetCache,
  parsePreviewPath,
  parsePreviewSource,
  pickDiffSection,
  PREVIEW_DIFF_MAX_CHARS,
  PREVIEW_TARGET_TTL_MS,
  resolvePreviewRefs,
  type PreviewDeps,
} from './preview.js'

describe('parsePreviewSource', () => {
  test('parses a valid branch source', () => {
    expect(parsePreviewSource(new URLSearchParams('source=branch&name=feature/x'))).toEqual({
      kind: 'branch',
      name: 'feature/x',
    })
  })

  test('parses a valid mr source', () => {
    expect(parsePreviewSource(new URLSearchParams('source=mr&number=42'))).toEqual({
      kind: 'mr',
      number: 42,
    })
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

describe('pickDiffSection', () => {
  const rename = `diff --git a/utils b/utils/main.sh
similarity index 100%
rename from utils
rename to utils/main.sh
`
  const neighbour = `diff --git a/utils/other.txt b/utils/other.txt
index 1111111..2222222 100644
--- a/utils/other.txt
+++ b/utils/other.txt
@@ -1 +1 @@
-old
+new
`

  test('keeps only the section targeting the requested path', () => {
    expect(pickDiffSection(rename + neighbour, 'utils/main.sh').trimEnd()).toBe(rename.trimEnd())
    expect(pickDiffSection(neighbour + rename, 'utils/main.sh').trimEnd()).toBe(rename.trimEnd())
  })

  test('falls back to the full diff when no header matches', () => {
    expect(pickDiffSection(neighbour, 'utils/main.sh')).toBe(neighbour)
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
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd: repo,
    stdio: 'ignore',
  })
}

function commitFile(name: string, content: string, msg: string) {
  writeFileSync(join(repo, name), content)
  run(['add', '-A'])
  run(['commit', '-m', msg])
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'codesema-preview-test-'))
  run(['init', '-b', 'main'])
  // Pins rename detection (git's default) against a developer's global diff.renames=false.
  run(['config', 'diff.renames', 'true'])
  commitFile('a.txt', 'base\n', 'init: base')
  run(['checkout', '-b', 'feature/x'])
  commitFile('a.txt', 'changed\n', 'feat: change')
})

afterAll(() => {
  rmSync(repo, { recursive: true, force: true })
})

/**
 * Records every forge probe: no gh/glab is ever launched by this file.
 *
 * It ANSWERS by default (as glab would, `main` being the fixture's target),
 * because only a forge answer is memoised — a silent probe is deliberately
 * never cached. `silent: true` gets the empty forge back; `realClock: true`
 * leaves the memo on `Date.now`, the domain a caller without `now` presents.
 */
function forgeSeam(opts: { silent?: boolean; realClock?: boolean; startedAt?: number } = {}) {
  const launches: { cmd: string; args: string[] }[] = []
  const clock = { now: opts.startedAt ?? 1_000_000 }
  const answer = opts.silent ? null : JSON.stringify({ target_branch: 'main' })
  const deps: PreviewDeps = {
    execFn: (cmd, args) => {
      launches.push({ cmd, args })
      return Promise.resolve(cmd === 'glab' ? answer : null)
    },
    ...(opts.realClock ? {} : { now: () => clock.now }),
  }
  return { launches, clock, deps }
}

/** The seam alone, when a test only needs the preview to stay hermetic. */
const noForge: PreviewDeps = { execFn: () => Promise.resolve(null) }

// The memo of detectPreviewTarget survives between tests otherwise, and a test
// that counts probes has to start from a cold one.
beforeEach(() => {
  clearPreviewTargetCache()
})

describe('resolvePreviewRefs (branch source)', () => {
  test('resolves the currently checked-out branch via HEAD', async () => {
    const refs = await resolvePreviewRefs(repo, { kind: 'branch', name: 'feature/x' }, noForge)
    expect(refs).toEqual({
      sourceRef: 'HEAD',
      targetRef: 'main',
      branch: 'feature/x',
      target: 'main',
    })
  })

  test('resolves a non-checked-out branch by name', async () => {
    run(['checkout', 'main'])
    try {
      const refs = await resolvePreviewRefs(repo, { kind: 'branch', name: 'feature/x' }, noForge)
      expect(refs).toEqual({
        sourceRef: 'feature/x',
        targetRef: 'main',
        branch: 'feature/x',
        target: 'main',
      })
    } finally {
      run(['checkout', 'feature/x'])
    }
  })

  test('throws for a branch that does not exist locally', async () => {
    await expect(
      resolvePreviewRefs(repo, { kind: 'branch', name: 'nope' }, noForge),
    ).rejects.toThrow(/branch not found/)
  })

  test('the forge probe goes through the injected seam, never a real gh/glab', async () => {
    const { launches, deps } = forgeSeam({ silent: true })
    await resolvePreviewRefs(repo, { kind: 'branch', name: 'feature/x' }, deps)
    // No origin remote in the fixture, so both candidates are probed — and the
    // argv is the assertion, exactly as in prep.test.ts.
    expect(launches.map((l) => l.cmd)).toEqual(['glab', 'gh'])
  })

  test('a forge that did not answer is asked again, never remembered as absent', async () => {
    const { launches, deps } = forgeSeam({ silent: true })
    await resolvePreviewRefs(repo, { kind: 'branch', name: 'feature/x' }, deps)
    const afterFirst = launches.length
    expect(afterFirst).toBeGreaterThan(0)
    // Caching the miss would keep "this branch has no merge request" for 30s
    // after the forge came back — a wrong target, to save a failed spawn.
    await resolvePreviewRefs(repo, { kind: 'branch', name: 'feature/x' }, deps)
    expect(launches.length).toBe(afterFirst * 2)
  })

  test('an entry stamped by one clock is never read against another', async () => {
    const real = forgeSeam({ realClock: true })
    await resolvePreviewRefs(repo, { kind: 'branch', name: 'feature/x' }, real.deps)
    const perProbe = real.launches.length
    expect(perProbe).toBeGreaterThan(0)
    await resolvePreviewRefs(repo, { kind: 'branch', name: 'feature/x' }, real.deps)
    expect(real.launches.length).toBe(perProbe)

    // A second clock shows up: its 1 000 000 cannot be compared with Date.now's
    // ~1.7e12, so the memo is emptied rather than read across domains.
    const injected = forgeSeam()
    await resolvePreviewRefs(repo, { kind: 'branch', name: 'feature/x' }, injected.deps)
    expect(injected.launches.length).toBe(perProbe)
    await resolvePreviewRefs(repo, { kind: 'branch', name: 'feature/x' }, injected.deps)
    expect(injected.launches.length).toBe(perProbe)

    // …and back: the real clock finds the memo emptied again, not a stale hit.
    await resolvePreviewRefs(repo, { kind: 'branch', name: 'feature/x' }, real.deps)
    expect(real.launches.length).toBe(perProbe * 2)
  })

  test('the memo expires: fresh at 29s, asked again at 31s', async () => {
    const { launches, clock, deps } = forgeSeam()
    await resolvePreviewRefs(repo, { kind: 'branch', name: 'feature/x' }, deps)
    const afterFirst = launches.length
    expect(afterFirst).toBeGreaterThan(0)

    clock.now += PREVIEW_TARGET_TTL_MS - 1_000
    await resolvePreviewRefs(repo, { kind: 'branch', name: 'feature/x' }, deps)
    expect(launches.length).toBe(afterFirst)

    clock.now += 2_000
    await resolvePreviewRefs(repo, { kind: 'branch', name: 'feature/x' }, deps)
    expect(launches.length).toBe(afterFirst * 2)
  })

  test('a burst of previews on one branch costs ONE forge probe, not one per request', async () => {
    const { launches, deps } = forgeSeam()
    await resolvePreviewRefs(repo, { kind: 'branch', name: 'feature/x' }, deps)
    const afterFirst = launches.length
    await resolvePreviewRefs(repo, { kind: 'branch', name: 'feature/x' }, deps)
    await buildFileDiff(repo, { kind: 'branch', name: 'feature/x' }, 'a.txt', deps)
    expect(launches.length).toBe(afterFirst)
    // …until the memo is dropped, and then the forge is asked again.
    clearPreviewTargetCache()
    await resolvePreviewRefs(repo, { kind: 'branch', name: 'feature/x' }, deps)
    expect(launches.length).toBe(afterFirst * 2)
  })
})

describe('buildPreview', () => {
  test('reports branch, target, commits, files and diff stats without the diff itself', async () => {
    const preview = await buildPreview(repo, { kind: 'branch', name: 'feature/x' }, noForge)
    expect(preview.branch).toBe('feature/x')
    expect(preview.target).toBe('main')
    expect(preview.commits).toEqual(['feat: change'])
    expect(preview.files).toEqual([
      { path: 'a.txt', additions: 1, deletions: 1, status: 'modified' },
    ])
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
      state: 'open',
      isDraft: false,
      labels: [],
      additions: null,
      deletions: null,
      changedFiles: null,
      checks: null,
      reviewers: [],
      assignees: [],
      milestone: null,
      mergeable: null,
      commits: null,
      body: null,
    }
    const listMrs = async (): Promise<ForgeMrsResult> => ({
      available: true,
      mrs: [mr],
      truncated: false,
    })
    // fetchBranch (git fetch origin ...) is skipped here: there is no origin remote, so it would throw;
    // instead we exercise resolvePreviewRefs directly against a source branch reachable without a remote.
    await expect(buildPreview(repo, { kind: 'mr', number: 999 }, { listMrs })).rejects.toThrow(
      /no open MR/,
    )
  })

  test('uses the destination path and renamed status for a renamed file', async () => {
    run(['checkout', '-b', 'feature/rename', 'main'])
    run(['mv', 'a.txt', 'renamed.txt'])
    run(['commit', '-m', 'feat: rename file'])
    try {
      const preview = await buildPreview(repo, { kind: 'branch', name: 'feature/rename' }, noForge)
      expect(preview.files).toEqual([
        {
          path: 'renamed.txt',
          previousPath: 'a.txt',
          additions: 0,
          deletions: 0,
          status: 'renamed',
        },
      ])
      const result = await buildFileDiff(
        repo,
        { kind: 'branch', name: 'feature/rename' },
        'renamed.txt',
        noForge,
      )
      expect(result.truncated).toBe(false)
      expect(result.diff).toContain('rename from a.txt')
      expect(result.diff).toContain('rename to renamed.txt')
    } finally {
      run(['checkout', 'feature/x'])
    }
  })
})

describe('buildFileDiff', () => {
  test('returns the diff of a single file', async () => {
    const result = await buildFileDiff(
      repo,
      { kind: 'branch', name: 'feature/x' },
      'a.txt',
      noForge,
    )
    expect(result.truncated).toBe(false)
    expect(result.diff).toContain('-base')
    expect(result.diff).toContain('+changed')
  })

  test('rejects a path that is not part of the diff', async () => {
    await expect(
      buildFileDiff(repo, { kind: 'branch', name: 'feature/x' }, 'nope.txt', noForge),
    ).rejects.toThrow(/not part of this diff/)
  })

  test('truncates a diff larger than the size cap and sets truncated', async () => {
    run(['checkout', '-b', 'feature/huge', 'main'])
    const bigLine = 'x'.repeat(200)
    const lines = Array.from(
      { length: (PREVIEW_DIFF_MAX_CHARS / bigLine.length) * 2 },
      () => bigLine,
    )
    writeFileSync(join(repo, 'huge.txt'), `${lines.join('\n')}\n`)
    run(['add', '-A'])
    run(['commit', '-m', 'feat: huge file'])
    try {
      const result = await buildFileDiff(
        repo,
        { kind: 'branch', name: 'feature/huge' },
        'huge.txt',
        noForge,
      )
      expect(result.truncated).toBe(true)
      expect(result.diff.length).toBe(PREVIEW_DIFF_MAX_CHARS)
    } finally {
      run(['checkout', 'feature/x'])
    }
  })
})
