import {
  sanitizeProofIntent,
  sanitizeProofReview,
  type ProofIntent,
  type ProofReview,
} from './proof-intent.js'
import { cutCodePoints } from './ticket.js'

export type EvidenceKind = 'screenshot' | 'video'

export type EvidenceItem = {
  kind: EvidenceKind
  path: string
  bytes: number
  turn: number
  created_at: string
}

export type EvidenceStatus = 'passed' | 'failed' | 'skipped'

export type EvidenceRecord = {
  version: 1
  status: EvidenceStatus
  reason: string | null
  head_sha: string | null
  items: EvidenceItem[]
  intent?: ProofIntent
  review?: ProofReview
}

export const EVIDENCE_ITEMS_MAX = 40
export const EVIDENCE_PATH_MAX = 200
export const EVIDENCE_REASON_MAX = 2_000

const EVIDENCE_KINDS: ReadonlySet<EvidenceKind> = new Set(['screenshot', 'video'])
const EVIDENCE_STATUSES: ReadonlySet<EvidenceStatus> = new Set(['passed', 'failed', 'skipped'])
const EVIDENCE_PATH_PATTERN = /^[A-Za-z0-9._-]+$/

function isNonNegativeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
}

function sanitizeEvidenceItem(raw: unknown): EvidenceItem | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const r = raw as Record<string, unknown>
  if (!EVIDENCE_KINDS.has(r.kind as EvidenceKind)) {
    return null
  }
  if (
    typeof r.path !== 'string' ||
    r.path.length > EVIDENCE_PATH_MAX ||
    !EVIDENCE_PATH_PATTERN.test(r.path)
  ) {
    return null
  }
  if (!isNonNegativeInt(r.bytes) || !isNonNegativeInt(r.turn)) {
    return null
  }
  if (typeof r.created_at !== 'string' || r.created_at.length === 0) {
    return null
  }
  return {
    kind: r.kind as EvidenceKind,
    path: r.path,
    bytes: r.bytes,
    turn: r.turn,
    created_at: r.created_at,
  }
}

function sanitizeEvidenceItems(raw: unknown): EvidenceItem[] {
  if (!Array.isArray(raw)) {
    return []
  }
  const out: EvidenceItem[] = []
  for (const item of raw) {
    if (out.length >= EVIDENCE_ITEMS_MAX) {
      break
    }
    const sanitized = sanitizeEvidenceItem(item)
    if (sanitized) {
      out.push(sanitized)
    }
  }
  return out
}

export function sanitizeEvidence(raw: unknown): EvidenceRecord | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const r = raw as Record<string, unknown>
  if (r.version !== 1) {
    return null
  }
  if (!EVIDENCE_STATUSES.has(r.status as EvidenceStatus)) {
    return null
  }
  const reason = typeof r.reason === 'string' ? cutCodePoints(r.reason, EVIDENCE_REASON_MAX) : null
  const headSha = typeof r.head_sha === 'string' && r.head_sha.length > 0 ? r.head_sha : null
  const intent = sanitizeProofIntent(r.intent)
  const review = sanitizeProofReview(r.review)
  return {
    version: 1,
    status: r.status as EvidenceStatus,
    reason,
    head_sha: headSha,
    items: sanitizeEvidenceItems(r.items),
    ...(intent !== null ? { intent } : {}),
    ...(review !== null ? { review } : {}),
  }
}
