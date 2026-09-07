import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  type Dirent,
} from 'node:fs'
import { extname, join, relative } from 'node:path'
import { writeJsonAtomic } from './atomic-write.js'
import {
  isTaskId,
  sanitizeEvidence,
  type EvidenceItem,
  type EvidenceKind,
  type EvidenceRecord,
  type EvidenceStatus,
  type ProofIntent,
} from './contract.js'
import { taskDir } from './tasks-store.js'

export const EVIDENCE_MAX_BYTES = 64 * 1024 * 1024
const EVIDENCE_DEFAULT_KEEP = 5

const EVIDENCE_EXTENSION_KIND: Readonly<Record<string, EvidenceKind>> = {
  '.png': 'screenshot',
  '.webm': 'video',
}

export type IngestEvidenceMeta = {
  turn: number
  status: EvidenceStatus
  reason: string | null
  head_sha: string | null
  keep: number | null
  intent?: ProofIntent
}

export function evidenceDir(cwd: string, id: string): string {
  return join(taskDir(cwd, id), 'evidence')
}

/**
 * Latest evidence record of a task (.codesema/tasks/<id>/evidence.json),
 * calque of readTaskChecks/readTaskVerification. Null on unknown id,
 * unreadable file or unusable content, never a throw.
 */
export function readTaskEvidence(cwd: string, id: string): EvidenceRecord | null {
  if (!isTaskId(id)) {
    return null
  }
  const path = join(taskDir(cwd, id), 'evidence.json')
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
  return sanitizeEvidence(raw)
}

/**
 * Atomic rewrite of evidence.json, calque of writeTaskChecks/writeTaskVerification.
 * Sanitized before writing so the file on disk is always bounded; the
 * sanitized copy is returned so the caller broadcasts exactly what was
 * persisted.
 */
export function writeTaskEvidence(cwd: string, id: string, record: EvidenceRecord): EvidenceRecord {
  if (!isTaskId(id)) {
    throw new Error(`invalid task id: ${id}`)
  }
  const clean = sanitizeEvidence(record)
  if (!clean) {
    throw new Error('invalid task evidence')
  }
  writeJsonAtomic(join(taskDir(cwd, id), 'evidence.json'), clean)
  return clean
}

function collectIncomingFiles(dir: string, base = dir): string[] {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const files: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectIncomingFiles(full, base))
    } else if (entry.isFile()) {
      files.push(full)
    }
  }
  return files.toSorted((a, b) => relative(base, a).localeCompare(relative(base, b)))
}

/**
 * Ingests every .png/.webm found recursively under incomingDir (Playwright
 * writes videos into a subfolder) into <taskDir>/evidence, merges the result
 * with the previous record's surviving items, purges down to meta.keep
 * (default 5, most recent created_at first), and persists the merged record.
 * incomingDir is removed once ingestion completes, whether or not it held
 * any usable file.
 */
export function ingestEvidenceFiles(
  cwd: string,
  id: string,
  incomingDir: string,
  meta: IngestEvidenceMeta,
): EvidenceRecord {
  if (!isTaskId(id)) {
    throw new Error(`invalid task id: ${id}`)
  }
  const targetDir = evidenceDir(cwd, id)
  mkdirSync(targetDir, { recursive: true })

  const candidates = collectIncomingFiles(incomingDir)
  const epochMs = Date.now()
  const createdAt = new Date(epochMs).toISOString()
  const newItems: EvidenceItem[] = []
  let index = 0
  for (const file of candidates) {
    const ext = extname(file).toLowerCase()
    const kind = EVIDENCE_EXTENSION_KIND[ext]
    if (!kind) {
      continue
    }
    if (statSync(file).size > EVIDENCE_MAX_BYTES) {
      continue
    }
    const filename = `t${meta.turn}-${epochMs}-${index}${ext}`
    const target = join(targetDir, filename)
    renameSync(file, target)
    newItems.push({
      kind,
      path: filename,
      bytes: statSync(target).size,
      turn: meta.turn,
      created_at: createdAt,
    })
    index += 1
  }

  const previousItems = readTaskEvidence(cwd, id)?.items ?? []
  const combined = [...previousItems, ...newItems]
  const keepN = meta.keep ?? EVIDENCE_DEFAULT_KEEP
  const sorted = combined.toSorted((a, b) => b.created_at.localeCompare(a.created_at))
  const toKeep = sorted.slice(0, keepN)
  const toDrop = sorted.slice(keepN)

  for (const item of toDrop) {
    try {
      unlinkSync(join(targetDir, item.path))
    } catch {
      continue
    }
  }

  const survivors = toKeep.filter((item) => {
    try {
      statSync(join(targetDir, item.path))
      return true
    } catch {
      return false
    }
  })

  rmSync(incomingDir, { recursive: true, force: true })

  return writeTaskEvidence(cwd, id, {
    version: 1,
    status: meta.status,
    reason: meta.reason,
    head_sha: meta.head_sha,
    items: survivors,
    ...(meta.intent !== undefined ? { intent: meta.intent } : {}),
  })
}
