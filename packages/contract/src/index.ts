// All agent input passes through here: whitelist and truncate, never throw.

export type NarrativeConfidence = 'high' | 'medium' | 'low'
export type NarrativeRisk = 'high' | 'medium' | 'low'

export type NarrativePrologueKeyChange = {
  title: string
  detail: string
}

export type NarrativePrologue = {
  why: string
  what: string
  key_changes: NarrativePrologueKeyChange[]
}

export type NarrativeStep = {
  title: string
  rationale: string
  files: string[]
  finding_refs: number[]
  risk?: NarrativeRisk
  take?: string
  check?: string | null
}

export type ReviewFirstRisk = NarrativeRisk

export type ReviewFirstItem = {
  point: string
  risk: ReviewFirstRisk
  step_ref: number | null
  file: string | null
}

export type ReviewNarrative = {
  intent: string
  confidence: NarrativeConfidence
  prologue?: NarrativePrologue
  steps: NarrativeStep[]
  review_first: ReviewFirstItem[]
}

export type Verdict = 'approve' | 'request_changes' | 'comment'
export type FindingSeverity = 'critical' | 'major' | 'minor' | 'info'
export type FindingKind = 'security' | 'perf' | 'convention' | 'design' | 'praise' | 'why'

export type Finding = {
  file: string
  line?: number
  endLine?: number
  severity: FindingSeverity
  kind?: FindingKind
  title?: string
  message: string
  suggestion?: string
  /** Dual review: true when both independent reviewers raised this finding. */
  consensus?: boolean
}

export type ReviewedFileStatus = 'clean' | 'findings'

/** Per-file coverage verdict: the reviewer settles every examined file explicitly. */
export type ReviewedFile = {
  path: string
  status: ReviewedFileStatus
}

export type SanitizedReview = {
  verdict: Verdict
  summary: string
  findings: Finding[]
  narrative: ReviewNarrative | null
  /**
   * Files the reviewer claims to have examined, for coverage reporting. The
   * status is always recomputed from the surviving findings, never trusted
   * from the agent: the declaration only forces a per-file decision.
   */
  files_reviewed?: ReviewedFile[]
}

export type DualStats = {
  merged: number
  rejected: number
  added_by_b: number
}

export type ReviewRecord = {
  version: 1
  meta: {
    title: string
    branch: string
    target: string
    merge_base: string
    /** HEAD at review time (absent on older archives). */
    head_sha?: string
    repo_root: string
    created_at: string
    /** Present when the review was produced by a dual (two reviewers + judge) run. */
    dual?: DualStats
  }
  commits: string[]
  diff: string
  review: SanitizedReview
}

const REVIEW_FIRST_MAX = 4
const REVIEW_FIRST_POINT_MAX = 300
const FILE_MAX = 500
const KEY_CHANGES_MAX = 5
const TAKE_MAX = 500
const CHECK_MAX = 300
const TITLE_MAX = 200
const MESSAGE_MAX = 2000
const SUGGESTION_MAX = 4000

function sanitizeReviewFirst(raw: unknown, stepsCount: number): ReviewFirstItem[] {
  if (!Array.isArray(raw)) return []
  const out: ReviewFirstItem[] = []
  for (const item of raw) {
    if (out.length >= REVIEW_FIRST_MAX) break
    if (!item || typeof item !== 'object') continue
    const it = item as Record<string, unknown>
    const point = typeof it.point === 'string' ? it.point.trim().slice(0, REVIEW_FIRST_POINT_MAX) : ''
    if (!point) continue
    const risk: ReviewFirstRisk = it.risk === 'high' || it.risk === 'low' ? it.risk : 'medium'
    // Archives written before the step rename used "chapter_ref".
    const rawRef = it.step_ref ?? it.chapter_ref
    const stepRef =
      Number.isInteger(rawRef) && (rawRef as number) >= 0 && (rawRef as number) < stepsCount
        ? (rawRef as number)
        : null
    const file = typeof it.file === 'string' && it.file.trim() ? it.file.trim().slice(0, FILE_MAX) : null
    out.push({ point, risk, step_ref: stepRef, file })
  }
  return out
}

function sanitizeRisk(raw: unknown): NarrativeRisk | undefined {
  if (raw === 'high' || raw === 'medium' || raw === 'low') return raw
  return undefined
}

function sanitizePrologue(raw: unknown): NarrativePrologue | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const p = raw as Record<string, unknown>
  const why = typeof p.why === 'string' ? p.why.trim() : ''
  const what = typeof p.what === 'string' ? p.what.trim() : ''
  if (!why && !what) return undefined
  const key_changes: NarrativePrologueKeyChange[] = []
  if (Array.isArray(p.key_changes)) {
    for (const item of p.key_changes) {
      if (key_changes.length >= KEY_CHANGES_MAX) break
      if (!item || typeof item !== 'object') continue
      const it = item as Record<string, unknown>
      const title = typeof it.title === 'string' ? it.title.trim() : ''
      const detail = typeof it.detail === 'string' ? it.detail.trim() : ''
      if (!title) continue
      key_changes.push({ title, detail })
    }
  }
  return { why, what, key_changes }
}

export function sanitizeNarrative(raw: unknown, findingsCount: number): ReviewNarrative | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>

  const intent = typeof r.intent === 'string' ? r.intent.trim() : ''
  const confidence: NarrativeConfidence = r.confidence === 'high' || r.confidence === 'low' ? r.confidence : 'medium'
  const prologue = sanitizePrologue(r.prologue)
  // Archives written before the step rename used "chapters".
  const rawSteps = Array.isArray(r.steps) ? r.steps : Array.isArray(r.chapters) ? r.chapters : []

  const steps: NarrativeStep[] = []
  for (const c of rawSteps) {
    if (!c || typeof c !== 'object') continue
    const cc = c as Record<string, unknown>
    const title = typeof cc.title === 'string' ? cc.title.trim() : ''
    if (!title) continue
    const rationale = typeof cc.rationale === 'string' ? cc.rationale.trim() : ''
    const files = Array.isArray(cc.files)
      ? cc.files.filter((f): f is string => typeof f === 'string').map((f) => f.slice(0, FILE_MAX))
      : []
    const seen = new Set<number>()
    const finding_refs: number[] = []
    for (const n of Array.isArray(cc.finding_refs) ? cc.finding_refs : []) {
      if (Number.isInteger(n) && n >= 0 && n < findingsCount && !seen.has(n as number)) {
        seen.add(n as number)
        finding_refs.push(n as number)
      }
    }
    const risk = sanitizeRisk(cc.risk)
    const take = typeof cc.take === 'string' ? cc.take.trim().slice(0, TAKE_MAX) || undefined : undefined
    const check =
      cc.check === null
        ? null
        : typeof cc.check === 'string'
          ? cc.check.trim().slice(0, CHECK_MAX) || undefined
          : undefined
    steps.push({
      title,
      rationale,
      files,
      finding_refs,
      ...(risk !== undefined ? { risk } : {}),
      ...(take !== undefined ? { take } : {}),
      ...(check !== undefined ? { check } : {}),
    })
  }

  if (steps.length === 0 && !intent) return null
  const review_first = sanitizeReviewFirst(r.review_first, steps.length)
  return { intent, confidence, ...(prologue ? { prologue } : {}), steps, review_first }
}

const SEVERITIES: readonly FindingSeverity[] = ['critical', 'major', 'minor', 'info']
const KINDS: readonly FindingKind[] = ['security', 'perf', 'convention', 'design', 'praise', 'why']

export function sanitizeFindings(raw: unknown): Finding[] {
  if (!Array.isArray(raw)) return []
  const out: Finding[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const f = item as Record<string, unknown>
    const file = typeof f.file === 'string' ? f.file.trim().slice(0, FILE_MAX) : ''
    const message = typeof f.message === 'string' ? f.message.trim().slice(0, MESSAGE_MAX) : ''
    if (!file || !message) continue
    const kind = KINDS.includes(f.kind as FindingKind) ? (f.kind as FindingKind) : undefined
    // A praise/why finding carries no defect: any higher severity would trip
    // the verdict escalation and the --fail-on gate.
    const severity: FindingSeverity =
      kind === 'praise' || kind === 'why'
        ? 'info'
        : SEVERITIES.includes(f.severity as FindingSeverity)
          ? (f.severity as FindingSeverity)
          : 'info'
    const line = Number.isInteger(f.line) && (f.line as number) > 0 ? (f.line as number) : undefined
    const endLine =
      line !== undefined && Number.isInteger(f.endLine) && (f.endLine as number) >= line
        ? (f.endLine as number)
        : undefined
    const title = typeof f.title === 'string' ? f.title.trim().slice(0, TITLE_MAX) || undefined : undefined
    const suggestion =
      typeof f.suggestion === 'string' ? f.suggestion.slice(0, SUGGESTION_MAX) || undefined : undefined
    out.push({
      file,
      message,
      severity,
      ...(kind !== undefined ? { kind } : {}),
      ...(line !== undefined ? { line } : {}),
      ...(endLine !== undefined ? { endLine } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(suggestion !== undefined ? { suggestion } : {}),
      ...(f.consensus === true ? { consensus: true } : {}),
    })
  }
  return out
}

const FILES_REVIEWED_MAX = 500

/** Bare strings are accepted for reviews written by pre-0.9 agents and archives. */
function sanitizeReviewedPaths(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const seen = new Set<string>()
  for (const item of raw) {
    const value =
      typeof item === 'string'
        ? item
        : item !== null && typeof item === 'object' && typeof (item as Record<string, unknown>).path === 'string'
          ? ((item as Record<string, unknown>).path as string)
          : null
    if (value === null) continue
    const path = value.trim().slice(0, FILE_MAX)
    if (!path) continue
    seen.add(path)
    if (seen.size >= FILES_REVIEWED_MAX) break
  }
  return [...seen]
}

/**
 * A file carrying a finding but missing from the declaration was necessarily
 * examined, so it is appended; a declared status is never kept when the
 * findings contradict it.
 */
function reviewedFilesFrom(paths: string[], findings: Finding[]): ReviewedFile[] {
  const withFindings = new Set(findings.map((f) => f.file))
  const all = [...paths]
  for (const file of withFindings) {
    if (!all.includes(file) && all.length < FILES_REVIEWED_MAX) all.push(file)
  }
  return all.map((path) => ({ path, status: withFindings.has(path) ? 'findings' : 'clean' }))
}

export function sanitizeReview(raw: unknown): SanitizedReview {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const verdict: Verdict =
    r.verdict === 'approve' || r.verdict === 'request_changes' ? r.verdict : 'comment'
  const summary = typeof r.summary === 'string' ? r.summary.trim().slice(0, MESSAGE_MAX) : ''
  const findings = sanitizeFindings(r.findings)
  const narrative = sanitizeNarrative(r.narrative, findings.length)
  const reviewedPaths = sanitizeReviewedPaths(r.files_reviewed)
  return {
    verdict,
    summary,
    findings,
    narrative,
    ...(reviewedPaths !== undefined ? { files_reviewed: reviewedFilesFrom(reviewedPaths, findings) } : {}),
  }
}

/**
 * Revalidates a ReviewRecord read back from disk (a possibly corrupt archive,
 * hand-edited, or written by an older schema). Returns null when the input is not
 * a usable object; shape fields are normalized.
 */
function sanitizeDualStats(raw: unknown): DualStats | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const d = raw as Record<string, unknown>
  const counts = [d.merged, d.rejected, d.added_by_b]
  if (!counts.every((n) => Number.isInteger(n) && (n as number) >= 0)) return undefined
  return { merged: d.merged as number, rejected: d.rejected as number, added_by_b: d.added_by_b as number }
}

export function sanitizeRecord(raw: unknown): ReviewRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const m = (r.meta && typeof r.meta === 'object' ? r.meta : {}) as Record<string, unknown>
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  const dual = sanitizeDualStats(m.dual)
  const meta: ReviewRecord['meta'] = {
    title: str(m.title),
    branch: str(m.branch),
    target: str(m.target),
    merge_base: str(m.merge_base),
    ...(typeof m.head_sha === 'string' && m.head_sha ? { head_sha: m.head_sha } : {}),
    repo_root: str(m.repo_root),
    created_at: typeof m.created_at === 'string' && m.created_at ? m.created_at : new Date().toISOString(),
    ...(dual !== undefined ? { dual } : {}),
  }
  const commits = Array.isArray(r.commits) ? r.commits.filter((c): c is string => typeof c === 'string') : []
  const diff = typeof r.diff === 'string' ? r.diff : ''
  return { version: 1, meta, commits, diff, review: sanitizeReview(r.review) }
}

export type SecretMatchReason = 'filename' | 'content'
export type SecretMatch = { file: string; reason: SecretMatchReason; detail: string }

const SENSITIVE_BASENAMES = new Set([
  '.npmrc',
  '.netrc',
  '.pgpass',
  '.htpasswd',
  'credentials',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
])
const SENSITIVE_EXTENSIONS = new Set(['pem', 'key', 'p12', 'pfx', 'keystore', 'jks'])
// Placeholder dotenv files carry no real values and are meant to be committed.
const DOTENV_ALLOWED_SUFFIXES = new Set(['example', 'sample', 'template', 'dist', 'defaults'])

const CONTENT_PATTERNS: readonly { label: string; re: RegExp }[] = [
  { label: 'a private key', re: /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/ },
  { label: 'an AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'a GitHub token', re: /\bgh[posru]_[A-Za-z0-9]{36,}\b/ },
  { label: 'a Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { label: 'a Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: 'a Stripe secret key', re: /\b(?:sk|rk)_live_[0-9A-Za-z]{16,}\b/ },
  { label: 'an Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { label: 'an OpenAI API key', re: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/ },
  { label: 'an OpenAI API key', re: /\bsk-[A-Za-z0-9]{40,}\b/ },
]

function sensitiveFilename(path: string): boolean {
  const base = (path.split('/').pop() ?? '').toLowerCase()
  if (!base) return false
  if (SENSITIVE_BASENAMES.has(base)) return true
  if (base === '.env') return true
  if (base.startsWith('.env.')) return !DOTENV_ALLOWED_SUFFIXES.has(base.slice(5))
  const dot = base.lastIndexOf('.')
  return dot > 0 && SENSITIVE_EXTENSIONS.has(base.slice(dot + 1))
}

function gitHeaderNewPath(header: string): string {
  const rest = header.slice('diff --git '.length)
  const marker = rest.indexOf(' b/')
  return marker >= 0 ? rest.slice(marker + 3) : ''
}

function markerLinePath(line: string): string {
  const rest = line.slice(4)
  const tab = rest.indexOf('\t')
  const raw = (tab === -1 ? rest : rest.slice(0, tab)).trim()
  if (raw === '/dev/null') return ''
  return raw.startsWith('a/') || raw.startsWith('b/') ? raw.slice(2) : raw
}

/**
 * Scans a unified diff for material that looks like a committed secret, by file
 * name and by content. Content lines are checked on both sides of the diff: a
 * removed secret still appears in the payload. Never throws; the caller decides
 * whether to hold the diff back.
 */
export function detectDiffSecrets(diff: string): SecretMatch[] {
  if (typeof diff !== 'string' || !diff) return []
  const matches: SecretMatch[] = []
  const seen = new Set<string>()
  const add = (file: string, reason: SecretMatchReason, detail: string): void => {
    const key = `${file}\0${reason}\0${detail}`
    if (seen.has(key)) return
    seen.add(key)
    matches.push({ file, reason, detail })
  }
  let currentFile = ''
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      currentFile = gitHeaderNewPath(line)
      if (currentFile && sensitiveFilename(currentFile)) add(currentFile, 'filename', currentFile)
      continue
    }
    if (line.startsWith('+++ ') || line.startsWith('--- ')) {
      const path = markerLinePath(line)
      if (path) {
        if (!currentFile) currentFile = path
        if (sensitiveFilename(path)) add(path, 'filename', path)
      }
      continue
    }
    const isAdded = line.startsWith('+') && !line.startsWith('+++')
    const isRemoved = line.startsWith('-') && !line.startsWith('---')
    if (!isAdded && !isRemoved) continue
    const content = line.slice(1)
    for (const { label, re } of CONTENT_PATTERNS) {
      if (re.test(content)) add(currentFile || '(unknown file)', 'content', label)
    }
  }
  return matches
}

export type GroundingReport = {
  dropped: Finding[]
  deanchored: Finding[]
  merged: number
  verdict_escalated: boolean
}

const SEVERITY_ORDER: Record<FindingSeverity, number> = { info: 0, minor: 1, major: 2, critical: 3 }

type DiffIndex = { files: Set<string>; hunks: Map<string, [number, number][]> }

function indexDiff(diff: string): DiffIndex | null {
  const files = new Set<string>()
  const hunks = new Map<string, [number, number][]>()
  let currentNewPath = ''
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      currentNewPath = ''
      const path = gitHeaderNewPath(line)
      if (path) files.add(path)
      continue
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      const path = markerLinePath(line)
      if (path) files.add(path)
      if (line.startsWith('+++ ')) currentNewPath = path
      continue
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (hunk && currentNewPath) {
      const start = Number(hunk[1])
      const count = hunk[2] === undefined ? 1 : Number(hunk[2])
      if (count > 0) {
        const ranges = hunks.get(currentNewPath) ?? []
        ranges.push([start, start + count - 1])
        hunks.set(currentNewPath, ranges)
      }
    }
  }
  return files.size > 0 ? { files, hunks } : null
}

function lineInHunks(ranges: [number, number][] | undefined, line: number): boolean {
  return (ranges ?? []).some(([start, end]) => line >= start && line <= end)
}

/**
 * Deterministic post-check of an agent review against the reviewed diff:
 * findings on files absent from the diff are dropped, line anchors outside
 * every hunk are removed (new-file numbering), duplicates (same file, line
 * and kind) merge into the first, keeping the highest severity and the
 * consensus flag of either copy, and an approve verdict cannot survive a
 * critical finding. Narrative finding_refs are
 * remapped accordingly, and files_reviewed statuses are recomputed from the
 * surviving findings. Never throws; an unparseable diff returns the
 * review untouched.
 */
export function groundReview(
  review: SanitizedReview,
  diff: string,
): { review: SanitizedReview; report: GroundingReport } {
  const report: GroundingReport = { dropped: [], deanchored: [], merged: 0, verdict_escalated: false }
  const index = typeof diff === 'string' ? indexDiff(diff) : null
  if (!index) return { review, report }

  const newIndexByOld = new Map<number, number>()
  const keptIndexByKey = new Map<string, number>()
  const findings: Finding[] = []
  review.findings.forEach((finding, oldIndex) => {
    if (!index.files.has(finding.file)) {
      report.dropped.push(finding)
      return
    }
    let kept = finding
    const ranges = index.hunks.get(finding.file)
    if (kept.line !== undefined && !lineInHunks(ranges, kept.line)) {
      const { line: _line, endLine: _endLine, ...rest } = kept
      kept = rest
      report.deanchored.push(finding)
    } else if (kept.endLine !== undefined && !lineInHunks(ranges, kept.endLine)) {
      const { endLine: _endLine, ...rest } = kept
      kept = rest
    }
    if (kept.line !== undefined) {
      const key = `${kept.file}\0${kept.line}\0${kept.kind ?? ''}`
      const duplicateOf = keptIndexByKey.get(key)
      if (duplicateOf !== undefined) {
        report.merged++
        const first = findings[duplicateOf] as Finding
        const severity = SEVERITY_ORDER[kept.severity] > SEVERITY_ORDER[first.severity] ? kept.severity : first.severity
        const consensus = first.consensus === true || kept.consensus === true
        findings[duplicateOf] = { ...first, severity, ...(consensus ? { consensus: true } : {}) }
        newIndexByOld.set(oldIndex, duplicateOf)
        return
      }
      keptIndexByKey.set(key, findings.length)
    }
    newIndexByOld.set(oldIndex, findings.length)
    findings.push(kept)
  })

  let narrative = review.narrative
  if (narrative && (report.dropped.length > 0 || report.merged > 0)) {
    narrative = {
      ...narrative,
      steps: narrative.steps.map((step) => {
        const seen = new Set<number>()
        const finding_refs: number[] = []
        for (const ref of step.finding_refs) {
          const mapped = newIndexByOld.get(ref)
          if (mapped !== undefined && !seen.has(mapped)) {
            seen.add(mapped)
            finding_refs.push(mapped)
          }
        }
        return { ...step, finding_refs }
      }),
    }
  }

  let verdict = review.verdict
  if (verdict === 'approve' && findings.some((f) => f.severity === 'critical')) {
    verdict = 'request_changes'
    report.verdict_escalated = true
  }

  const files_reviewed =
    review.files_reviewed !== undefined
      ? reviewedFilesFrom(
          review.files_reviewed.map((f) => f.path),
          findings,
        )
      : undefined
  return {
    review: {
      ...review,
      verdict,
      findings,
      narrative,
      ...(files_reviewed !== undefined ? { files_reviewed } : {}),
    },
    report,
  }
}

const RISK_ENUM = { enum: ['high', 'medium', 'low'] } as const

/** JSON Schema (draft 2020-12) for a ReviewRecord, for consumers validating synced reviews. */
export const reviewRecordSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://codesema.com/schemas/review-record.json',
  title: 'Codesema review record',
  type: 'object',
  additionalProperties: false,
  required: ['version', 'meta', 'commits', 'diff', 'review'],
  properties: {
    version: { const: 1 },
    meta: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'branch', 'target', 'merge_base', 'repo_root', 'created_at'],
      properties: {
        title: { type: 'string' },
        branch: { type: 'string' },
        target: { type: 'string' },
        merge_base: { type: 'string' },
        head_sha: { type: 'string' },
        repo_root: { type: 'string' },
        created_at: { type: 'string' },
        dual: {
          type: 'object',
          additionalProperties: false,
          required: ['merged', 'rejected', 'added_by_b'],
          properties: {
            merged: { type: 'integer', minimum: 0 },
            rejected: { type: 'integer', minimum: 0 },
            added_by_b: { type: 'integer', minimum: 0 },
          },
        },
      },
    },
    commits: { type: 'array', items: { type: 'string' } },
    diff: { type: 'string' },
    review: { $ref: '#/$defs/review' },
  },
  $defs: {
    review: {
      type: 'object',
      additionalProperties: false,
      required: ['verdict', 'summary', 'findings', 'narrative'],
      properties: {
        verdict: { enum: ['approve', 'request_changes', 'comment'] },
        summary: { type: 'string' },
        findings: { type: 'array', items: { $ref: '#/$defs/finding' } },
        narrative: { anyOf: [{ type: 'null' }, { $ref: '#/$defs/narrative' }] },
        files_reviewed: {
          type: 'array',
          items: { anyOf: [{ type: 'string' }, { $ref: '#/$defs/reviewedFile' }] },
        },
      },
    },
    reviewedFile: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'status'],
      properties: {
        path: { type: 'string' },
        status: { enum: ['clean', 'findings'] },
      },
    },
    finding: {
      type: 'object',
      additionalProperties: false,
      required: ['file', 'severity', 'message'],
      properties: {
        file: { type: 'string' },
        line: { type: 'integer', minimum: 1 },
        endLine: { type: 'integer', minimum: 1 },
        severity: { enum: ['critical', 'major', 'minor', 'info'] },
        kind: { enum: ['security', 'perf', 'convention', 'design', 'praise', 'why'] },
        title: { type: 'string' },
        message: { type: 'string' },
        suggestion: { type: 'string' },
        consensus: { type: 'boolean' },
      },
    },
    narrative: {
      type: 'object',
      additionalProperties: false,
      required: ['intent', 'confidence', 'steps', 'review_first'],
      properties: {
        intent: { type: 'string' },
        confidence: RISK_ENUM,
        prologue: { $ref: '#/$defs/prologue' },
        steps: { type: 'array', items: { $ref: '#/$defs/step' } },
        review_first: { type: 'array', items: { $ref: '#/$defs/reviewFirstItem' } },
      },
    },
    prologue: {
      type: 'object',
      additionalProperties: false,
      required: ['why', 'what', 'key_changes'],
      properties: {
        why: { type: 'string' },
        what: { type: 'string' },
        key_changes: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['title', 'detail'],
            properties: { title: { type: 'string' }, detail: { type: 'string' } },
          },
        },
      },
    },
    step: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'rationale', 'files', 'finding_refs'],
      properties: {
        title: { type: 'string' },
        rationale: { type: 'string' },
        files: { type: 'array', items: { type: 'string' } },
        finding_refs: { type: 'array', items: { type: 'integer', minimum: 0 } },
        risk: RISK_ENUM,
        take: { type: 'string' },
        check: { type: ['string', 'null'] },
      },
    },
    reviewFirstItem: {
      type: 'object',
      additionalProperties: false,
      required: ['point', 'risk', 'step_ref', 'file'],
      properties: {
        point: { type: 'string' },
        risk: RISK_ENUM,
        step_ref: { type: ['integer', 'null'], minimum: 0 },
        file: { type: ['string', 'null'] },
      },
    },
  },
} as const
