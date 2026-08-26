import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { sanitizeRecord } from './contract.js'
import {
  archiveRecord,
  findPreviousReview,
  listLatestReviews,
  listReviewHistory,
  resolveArchivePath,
} from './record.js'

let dir: string
let reviewsDir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'codesema-record-'))
  reviewsDir = join(dir, '.codesema', 'reviews')
  mkdirSync(reviewsDir, { recursive: true })
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function record(meta: Record<string, unknown>) {
  const sanitized = sanitizeRecord({ meta, review: { verdict: 'approve', summary: 's' } })
  expect(sanitized).not.toBeNull()
  return sanitized!
}

describe('archiveRecord', () => {
  test('keeps the 20 newest archives of the branch, other branches untouched', () => {
    // 21 existing + the one archived below: the two oldest fall off. A task
    // branch archives ONE review per reviewed turn, hence the deep history.
    for (let day = 1; day <= 21; day++) {
      writeFileSync(
        join(reviewsDir, `feat-x-202601${String(day).padStart(2, '0')}-000000.json`),
        '{}',
      )
    }
    writeFileSync(join(reviewsDir, 'feat-x-extra-20260101-000000.json'), '{}')
    writeFileSync(join(reviewsDir, 'other-20260101-000000.json'), '{}')

    archiveRecord(record({ branch: 'feat/x', target: 'develop' }), dir)

    const names = readdirSync(reviewsDir)
    const kept = names.filter((n) => /^feat-x-\d{8}-\d{6}\.json$/.test(n)).toSorted()
    expect(kept.length).toBe(20)
    expect(kept).not.toContain('feat-x-20260101-000000.json')
    expect(kept).not.toContain('feat-x-20260102-000000.json')
    expect(kept).toContain('feat-x-20260103-000000.json')
    expect(names).toContain('feat-x-extra-20260101-000000.json')
    expect(names).toContain('other-20260101-000000.json')
  })
})

describe('findPreviousReview', () => {
  test('matches branch and target, requires head_sha, ignores other branches', () => {
    const previous = record({ branch: 'feat/y', target: 'develop', head_sha: 'abc123' })
    writeFileSync(join(reviewsDir, 'feat-y-20260101-000000.json'), JSON.stringify(previous))

    expect(findPreviousReview(dir, 'feat/y', 'develop')?.meta.head_sha).toBe('abc123')
    expect(findPreviousReview(dir, 'feat/y', 'main')).toBeNull()
    expect(findPreviousReview(dir, 'feat/z', 'develop')).toBeNull()
  })

  test('skips archives without head_sha', () => {
    const previous = record({ branch: 'feat/nosha', target: 'develop' })
    writeFileSync(join(reviewsDir, 'feat-nosha-20260101-000000.json'), JSON.stringify(previous))

    expect(findPreviousReview(dir, 'feat/nosha', 'develop')).toBeNull()
  })
})

describe('listReviewHistory', () => {
  test('newest first, capped at 20, corrupt archives skipped, slug collisions excluded', () => {
    for (let day = 3; day <= 22; day++) {
      writeFileSync(
        join(reviewsDir, `list-hist-202603${String(day).padStart(2, '0')}-000000.json`),
        JSON.stringify(record({ branch: 'list/hist', target: 'main' })),
      )
    }
    // Corrupt archive for the SAME branch: silently absent, never a throw.
    writeFileSync(join(reviewsDir, 'list-hist-20260401-000000.json'), '{not json')
    // A DIFFERENT real branch ("list-hist") slugs to the identical prefix as
    // "list/hist" and must not leak into that branch's history.
    writeFileSync(
      join(reviewsDir, 'list-hist-20260501-000000.json'),
      JSON.stringify(record({ branch: 'list-hist', target: 'main' })),
    )

    const history = listReviewHistory(dir, 'list/hist')
    expect(history).toHaveLength(20)
    expect(history.every((s) => s.branch === 'list/hist')).toBe(true)
    expect(history[0]?.ref).toBe('list-hist-20260322-000000.json')
    expect(history.at(-1)?.ref).toBe('list-hist-20260303-000000.json')
  })

  test('unknown branch and missing reviews dir both yield an empty list', () => {
    expect(listReviewHistory(dir, 'never/reviewed')).toEqual([])
    expect(listReviewHistory(mkdtempSync(join(tmpdir(), 'codesema-record-empty-')), 'x')).toEqual(
      [],
    )
  })

  test('reads verdict, target, findings_total and mode (from meta.dual) off the archive', () => {
    const dual = sanitizeRecord({
      meta: {
        branch: 'list/mode',
        target: 'main',
        dual: { merged: 1, rejected: 0, added_by_b: 0 },
      },
      review: {
        verdict: 'request_changes',
        summary: 's',
        findings: [
          { file: 'a.ts', message: 'm1' },
          { file: 'b.ts', message: 'm2' },
          { file: 'c.ts', message: 'm3' },
        ],
      },
    })
    expect(dual).not.toBeNull()
    writeFileSync(join(reviewsDir, 'list-mode-20260601-000000.json'), JSON.stringify(dual))
    writeFileSync(
      join(reviewsDir, 'list-mode-20260602-000000.json'),
      JSON.stringify(record({ branch: 'list/mode', target: 'staging' })),
    )

    const history = listReviewHistory(dir, 'list/mode')
    expect(history[0]).toMatchObject({
      ref: 'list-mode-20260602-000000.json',
      target: 'staging',
      verdict: 'approve',
      mode: 'simple',
      findings_total: 0,
    })
    expect(history[1]).toMatchObject({
      ref: 'list-mode-20260601-000000.json',
      target: 'main',
      verdict: 'request_changes',
      mode: 'dual',
      findings_total: 3,
    })
  })
})

describe('listLatestReviews', () => {
  test('one summary per real branch, most recent, grouped on meta.branch not the filename slug', () => {
    writeFileSync(
      join(reviewsDir, 'list-latest-a-20260601-000000.json'),
      JSON.stringify(record({ branch: 'list/latest-a', target: 'main' })),
    )
    writeFileSync(
      join(reviewsDir, 'list-latest-a-20260602-000000.json'),
      JSON.stringify(record({ branch: 'list/latest-a', target: 'main' })),
    )
    // Two DIFFERENT real branches sharing one slug ("list/collide" and
    // "list-collide" both become "list-collide"): both must be reported,
    // neither clobbering the other.
    writeFileSync(
      join(reviewsDir, 'list-collide-20260603-000000.json'),
      JSON.stringify(record({ branch: 'list/collide', target: 'main' })),
    )
    writeFileSync(
      join(reviewsDir, 'list-collide-20260604-000000.json'),
      JSON.stringify(record({ branch: 'list-collide', target: 'main' })),
    )

    const latest = listLatestReviews(dir)
    const byBranch = new Map(latest.map((s) => [s.branch, s]))
    expect(byBranch.get('list/latest-a')?.ref).toBe('list-latest-a-20260602-000000.json')
    expect(byBranch.get('list/collide')?.ref).toBe('list-collide-20260603-000000.json')
    expect(byBranch.get('list-collide')?.ref).toBe('list-collide-20260604-000000.json')
  })

  test('a directory with no archives yields an empty list', () => {
    expect(listLatestReviews(mkdtempSync(join(tmpdir(), 'codesema-record-empty-')))).toEqual([])
  })
})

describe('resolveArchivePath', () => {
  test('resolves a ref inside .codesema/reviews', () => {
    expect(resolveArchivePath(dir, 'feat-y-20260101-000000.json')).toBe(
      join(reviewsDir, 'feat-y-20260101-000000.json'),
    )
  })

  test('rejects traversal and paths outside the reviews directory, the directory itself included', () => {
    expect(resolveArchivePath(dir, '../../etc/passwd')).toBeNull()
    expect(resolveArchivePath(dir, '../tasks/x.json')).toBeNull()
    expect(resolveArchivePath(dir, join(dir, 'secret.json'))).toBeNull()
    expect(resolveArchivePath(dir, reviewsDir)).toBeNull()
  })
})
