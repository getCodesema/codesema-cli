import { cutCodePoints } from './ticket.js'

export const PROOF_INTENT_KINDS = ['none', 'screenshot', 'journey'] as const

export type ProofIntentKind = (typeof PROOF_INTENT_KINDS)[number]

export type ProofIntent = {
  kind: ProofIntentKind
  reason: string
  pages?: string[]
  journey?: string
}

export type ProofReview = {
  expected: ProofIntentKind
  coherent: boolean
  reason: string
}

export const PROOF_INTENT_REASON_MAX = 500
export const PROOF_INTENT_PAGES_MAX = 8
export const PROOF_INTENT_PATH_MAX = 200

const PROOF_INTENT_KIND_SET: ReadonlySet<ProofIntentKind> = new Set(PROOF_INTENT_KINDS)

function isValidPagePath(raw: unknown): raw is string {
  if (typeof raw !== 'string') {
    return false
  }
  const length = [...raw].length
  if (length === 0 || length > PROOF_INTENT_PATH_MAX) {
    return false
  }
  if (!raw.startsWith('/') || raw.startsWith('//')) {
    return false
  }
  return !raw.includes('..') && !raw.includes("'") && !raw.includes(' ')
}

function isValidJourneyPath(raw: unknown): raw is string {
  if (typeof raw !== 'string') {
    return false
  }
  const length = [...raw].length
  if (length === 0 || length > PROOF_INTENT_PATH_MAX) {
    return false
  }
  if (raw.startsWith('/')) {
    return false
  }
  return !raw.includes('..') && !raw.includes("'") && !raw.includes(' ')
}

function sanitizeProofIntentReason(raw: unknown): string {
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  return trimmed ? cutCodePoints(trimmed, PROOF_INTENT_REASON_MAX).trim() : ''
}

function sanitizeProofIntentPages(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined
  }
  const pages: string[] = []
  for (const item of raw) {
    if (pages.length >= PROOF_INTENT_PAGES_MAX) {
      break
    }
    if (isValidPagePath(item)) {
      pages.push(item)
    }
  }
  return pages.length > 0 ? pages : undefined
}

export function sanitizeProofIntent(raw: unknown): ProofIntent | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const r = raw as Record<string, unknown>
  if (!PROOF_INTENT_KIND_SET.has(r.kind as ProofIntentKind)) {
    return null
  }
  const kind = r.kind as ProofIntentKind
  const reason = sanitizeProofIntentReason(r.reason)
  if (!reason) {
    return null
  }
  const pages = kind === 'screenshot' ? sanitizeProofIntentPages(r.pages) : undefined
  const journey = kind === 'journey' && isValidJourneyPath(r.journey) ? r.journey : undefined
  return {
    kind,
    reason,
    ...(pages !== undefined ? { pages } : {}),
    ...(journey !== undefined ? { journey } : {}),
  }
}

export function sanitizeProofReview(raw: unknown): ProofReview | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const r = raw as Record<string, unknown>
  if (!PROOF_INTENT_KIND_SET.has(r.expected as ProofIntentKind)) {
    return null
  }
  if (typeof r.coherent !== 'boolean') {
    return null
  }
  return {
    expected: r.expected as ProofIntentKind,
    coherent: r.coherent,
    reason: sanitizeProofIntentReason(r.reason),
  }
}
