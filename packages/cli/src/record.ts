import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { sanitizeRecord, type ReviewRecord } from './contract.js'
import { t } from './i18n.js'

const ARCHIVES_KEPT_PER_BRANCH = 5

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'review'
  )
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * Archive names are `<slug>-<stamp>.json`; matching on the fixed stamp shape keeps
 * branch "feat" from swallowing "feat-x" archives (both start with "feat-").
 */
function archiveNames(reviewsDir: string, slugged: string): string[] {
  const stampTail = /^\d{8}-\d{6}\.json$/
  return readdirSync(reviewsDir)
    .filter((n) => n.startsWith(`${slugged}-`) && stampTail.test(n.slice(slugged.length + 1)))
    .toSorted()
}

export function archiveRecord(record: ReviewRecord, cwd: string): string {
  const reviewsDir = join(cwd, '.codesema', 'reviews')
  mkdirSync(reviewsDir, { recursive: true })
  const slugged = slug(record.meta.branch)
  const savedPath = join(reviewsDir, `${slugged}-${stamp(new Date())}.json`)
  writeFileSync(savedPath, JSON.stringify(record, null, 2))
  const names = archiveNames(reviewsDir, slugged)
  for (const name of names.slice(0, Math.max(0, names.length - ARCHIVES_KEPT_PER_BRANCH))) {
    unlinkSync(join(reviewsDir, name))
  }
  return savedPath
}

export function readJson(path: string): unknown {
  const raw = readFileSync(path, 'utf8')
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(t('record.invalidJson', { path }))
  }
}

function buildRecord(agentOutputPath: string, dir: string): ReviewRecord {
  const inputPath = join(dir, 'input.json')
  if (!existsSync(inputPath)) {
    throw new Error(t('record.noInput'))
  }
  const raw = readJson(inputPath)
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const record = sanitizeRecord({
    meta: {
      title: input.title,
      branch: input.branch,
      target: input.target,
      merge_base: input.merge_base,
      head_sha: input.head_sha,
      repo_root: input.repo_root,
    },
    commits: input.commits,
    diff: input.diff,
    review: readJson(agentOutputPath),
  })
  if (!record) {
    throw new Error(t('record.invalidJson', { path: agentOutputPath }))
  }
  return record
}

function latestSavedRecord(reviewsDir: string): { record: ReviewRecord; path: string } | null {
  if (!existsSync(reviewsDir)) {
    return null
  }
  const names = readdirSync(reviewsDir)
    .filter((n) => n.endsWith('.json'))
    .toSorted()
  for (let i = names.length - 1; i >= 0; i--) {
    const name = names[i]
    if (!name) {
      continue
    }
    const path = join(reviewsDir, name)
    try {
      const record = sanitizeRecord(readJson(path))
      if (record) {
        return { record, path }
      }
    } catch {
      // unreadable archive: fall back to the previous one
    }
  }
  return null
}

/** Last archived review of this branch to this target, with a known head_sha. */
export function findPreviousReview(
  cwd: string,
  branch: string,
  target: string,
): ReviewRecord | null {
  const reviewsDir = join(cwd, '.codesema', 'reviews')
  if (!existsSync(reviewsDir)) {
    return null
  }
  const names = archiveNames(reviewsDir, slug(branch)).toReversed()
  for (const name of names) {
    try {
      const record = sanitizeRecord(readJson(join(reviewsDir, name)))
      if (record?.meta.branch === branch && record.meta.target === target && record.meta.head_sha) {
        return record
      }
    } catch {
      // unreadable archive: fall back to the previous one
    }
  }
  return null
}

export type ResolvedRecord = {
  record: ReviewRecord
  /** true when built from fresh agent output, not yet archived. */
  fresh: boolean
  sourcePath: string
}

export function resolveRecord(opts: { review?: string | undefined; cwd: string }): ResolvedRecord {
  const dir = join(opts.cwd, '.codesema')
  const freshPath = opts.review ?? join(dir, 'review.json')
  if (existsSync(freshPath)) {
    return { record: buildRecord(freshPath, dir), fresh: true, sourcePath: freshPath }
  }
  if (opts.review) {
    throw new Error(t('record.reviewNotFound', { path: opts.review }))
  }
  const latest = latestSavedRecord(join(dir, 'reviews'))
  if (!latest) {
    throw new Error(t('record.nothingToShow'))
  }
  return { record: latest.record, fresh: false, sourcePath: latest.path }
}
