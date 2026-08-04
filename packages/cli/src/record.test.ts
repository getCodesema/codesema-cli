import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { sanitizeRecord } from './contract.js'
import { archiveRecord, findPreviousReview } from './record.js'

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
  test('keeps only the newest archives of the branch, other branches untouched', () => {
    for (let day = 1; day <= 6; day++) {
      writeFileSync(join(reviewsDir, `feat-x-2026010${day}-000000.json`), '{}')
    }
    writeFileSync(join(reviewsDir, 'feat-x-extra-20260101-000000.json'), '{}')
    writeFileSync(join(reviewsDir, 'other-20260101-000000.json'), '{}')

    archiveRecord(record({ branch: 'feat/x', target: 'develop' }), dir)

    const names = readdirSync(reviewsDir)
    const kept = names.filter((n) => /^feat-x-\d{8}-\d{6}\.json$/.test(n)).toSorted()
    expect(kept.length).toBe(5)
    expect(kept).not.toContain('feat-x-20260101-000000.json')
    expect(kept).not.toContain('feat-x-20260102-000000.json')
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
