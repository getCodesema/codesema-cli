// Résolution du ReviewRecord consommé par `show` et `export` : sortie agent
// fraîche (.mr-review/review.json ou --review) sinon dernière review archivée.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ReviewRecord } from './contract.js'
import { sanitizeReview } from './contract.js'
import type { PrepInput } from './prep.js'

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
    throw new Error('.mr-review/input.json not found — run `mr-review prep` first')
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

export type ResolvedRecord = {
  record: ReviewRecord
  /** true si construit depuis une sortie agent fraîche (pas encore archivée). */
  fresh: boolean
  sourcePath: string
}

export function resolveRecord(opts: { review?: string; cwd: string }): ResolvedRecord {
  const dir = join(opts.cwd, '.mr-review')
  const freshPath = opts.review ?? join(dir, 'review.json')
  if (existsSync(freshPath)) {
    return { record: buildRecord(freshPath, dir), fresh: true, sourcePath: freshPath }
  }
  if (opts.review) {
    throw new Error(`review file not found: ${opts.review}`)
  }
  const latest = latestSavedRecord(join(dir, 'reviews'))
  if (!latest) {
    throw new Error('no review to show — run `mr-review prep`, let your agent write .mr-review/review.json, then retry')
  }
  return { record: latest.record, fresh: false, sourcePath: latest.path }
}
