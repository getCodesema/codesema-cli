// Résolution du ReviewRecord consommé par `show` et `export` : sortie agent
// fraîche (.codesema/review.json ou --review) sinon dernière review archivée.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ReviewRecord } from './contract.js'
import { sanitizeReview } from './contract.js'
import type { PrepInput } from './prep.js'

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'review'
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** Archive la review dans .codesema/reviews/ et renvoie le chemin écrit. */
export function archiveRecord(record: ReviewRecord, cwd: string): string {
  const reviewsDir = join(cwd, '.codesema', 'reviews')
  mkdirSync(reviewsDir, { recursive: true })
  const savedPath = join(reviewsDir, `${slug(record.meta.branch)}-${stamp(new Date())}.json`)
  writeFileSync(savedPath, JSON.stringify(record, null, 2))
  return savedPath
}

export function readJson(path: string): unknown {
  const raw = readFileSync(path, 'utf8')
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(`${path} is not valid JSON — the agent output must be a single JSON object`)
  }
}

function buildRecord(agentOutputPath: string, dir: string): ReviewRecord {
  const inputPath = join(dir, 'input.json')
  if (!existsSync(inputPath)) {
    throw new Error('.codesema/input.json not found — run `codesema prep` first')
  }
  const input = readJson(inputPath) as PrepInput
  const review = sanitizeReview(readJson(agentOutputPath))
  return {
    version: 1,
    meta: {
      title: input.title,
      branch: input.branch,
      target: input.target,
      merge_base: input.merge_base,
      ...(input.head_sha ? { head_sha: input.head_sha } : {}),
      repo_root: input.repo_root,
      created_at: new Date().toISOString(),
    },
    commits: input.commits ?? [],
    diff: input.diff ?? '',
    review,
  }
}

function latestSavedRecord(reviewsDir: string): { record: ReviewRecord; path: string } | null {
  if (!existsSync(reviewsDir)) return null
  const names = readdirSync(reviewsDir).filter((n) => n.endsWith('.json')).sort()
  const last = names[names.length - 1]
  if (!last) return null
  const path = join(reviewsDir, last)
  return { record: readJson(path) as ReviewRecord, path }
}

/** Dernière review archivée de cette branche vers cette cible, avec head_sha connu. */
export function findPreviousReview(cwd: string, branch: string, target: string): ReviewRecord | null {
  const reviewsDir = join(cwd, '.codesema', 'reviews')
  if (!existsSync(reviewsDir)) return null
  const names = readdirSync(reviewsDir).filter((n) => n.endsWith('.json')).sort().reverse()
  for (const name of names) {
    try {
      const record = readJson(join(reviewsDir, name)) as ReviewRecord
      if (record?.meta?.branch === branch && record.meta.target === target && record.meta.head_sha) {
        return record
      }
    } catch {
      // archive illisible : on remonte à la précédente
    }
  }
  return null
}

export type ResolvedRecord = {
  record: ReviewRecord
  /** true si construit depuis une sortie agent fraîche (pas encore archivée). */
  fresh: boolean
  sourcePath: string
}

export function resolveRecord(opts: { review?: string; cwd: string }): ResolvedRecord {
  const dir = join(opts.cwd, '.codesema')
  const freshPath = opts.review ?? join(dir, 'review.json')
  if (existsSync(freshPath)) {
    return { record: buildRecord(freshPath, dir), fresh: true, sourcePath: freshPath }
  }
  if (opts.review) {
    throw new Error(`review file not found: ${opts.review}`)
  }
  const latest = latestSavedRecord(join(dir, 'reviews'))
  if (!latest) {
    throw new Error('no review to show — run `codesema prep`, let your agent write .codesema/review.json, then retry')
  }
  return { record: latest.record, fresh: false, sourcePath: latest.path }
}
