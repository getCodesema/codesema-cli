// DP12: the per-criterion verdict type is defined ONCE, beside
// `AcceptanceCriterion` in ticket.ts, and reused verbatim here (T3.2's
// `ReviewRecord`) and by `RecapRecord` (T3.4). Importing it rather than
// restating it is what keeps the three consumers from drifting into two
// spellings of the same fact. ticket.ts imports nothing, so this cannot cycle.
import {
  CRITERION_VERDICT_EVIDENCE_MAX,
  NON_BLANK,
  sanitizeCriterionVerdicts,
  TICKET_CRITERIA_MAX,
  type CriterionStatus,
  type CriterionVerdict,
} from './ticket.js'

// All agent input passes through here: whitelist and truncate, never throw.

export * from './arm.js'
export * from './reasons.js'
export * from './recap.js'
export * from './runbook.js'
export * from './runner.js'
export * from './tasks.js'
export * from './ticket-state.js'
export * from './ticket.js'

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

/**
 * How a `major` finding claims to reproduce (D24): the command to run, and
 * what a human should expect to see. `expected` is documentation for a
 * person, never parsed by anything downstream: the only machine-readable
 * signal a repro run produces is its exit code.
 */
export type FindingRepro = {
  command: string
  expected: string
}

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
  /** D24: how to reproduce the finding, when the reviewer stated one. */
  repro?: FindingRepro
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
  /**
   * DP12 / T3.2: the per-criterion verdicts this review reached, one entry per
   * acceptance criterion the task is judged against.
   *
   * It lives in the CONTRACT rather than in `task-review.ts` for one concrete
   * reason: `sanitizeRecord` below rebuilds an archive from a STRICT whitelist
   * (`version`, `meta`, `commits`, `diff`, `review`), so anything outside the
   * contract written into an archive is ERASED on read-back. T3.6 evaluates
   * the criteria condition of a merge AFTER the ship, possibly at a later
   * boot where nothing in memory survived — a type local to the reviewer
   * would leave it with nothing to read.
   *
   * OPTIONAL, and its honest default is ABSENCE: "this review judged no
   * criteria" — every archive written before this field existed, and every
   * task with no ticket. Never `[]`: an empty list would claim a review that
   * judged a criteria list of length zero, which a ticket never has
   * (`TICKET_CRITERIA_MIN`). The gate that reads it is CLI-side and
   * deterministic; nothing here is a verdict the model produced.
   */
  criteria?: CriterionVerdict[]
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
/** Bound of `FindingRepro.command`: a shell command, not a script. */
const FINDING_REPRO_COMMAND_MAX = 500
/** Bound of `FindingRepro.expected`: a one-line human expectation, not a transcript. */
const FINDING_REPRO_EXPECTED_MAX = 300

function sanitizeReviewFirst(raw: unknown, stepsCount: number): ReviewFirstItem[] {
  if (!Array.isArray(raw)) {
    return []
  }
  const out: ReviewFirstItem[] = []
  for (const item of raw) {
    if (out.length >= REVIEW_FIRST_MAX) {
      break
    }
    if (!item || typeof item !== 'object') {
      continue
    }
    const it = item as Record<string, unknown>
    const point =
      typeof it.point === 'string' ? it.point.trim().slice(0, REVIEW_FIRST_POINT_MAX) : ''
    if (!point) {
      continue
    }
    const risk: ReviewFirstRisk = it.risk === 'high' || it.risk === 'low' ? it.risk : 'medium'
    // Archives written before the step rename used "chapter_ref".
    const rawRef = it.step_ref ?? it.chapter_ref
    const stepRef =
      Number.isInteger(rawRef) && (rawRef as number) >= 0 && (rawRef as number) < stepsCount
        ? (rawRef as number)
        : null
    const file =
      typeof it.file === 'string' && it.file.trim() ? it.file.trim().slice(0, FILE_MAX) : null
    out.push({ point, risk, step_ref: stepRef, file })
  }
  return out
}

function sanitizeRisk(raw: unknown): NarrativeRisk | undefined {
  if (raw === 'high' || raw === 'medium' || raw === 'low') {
    return raw
  }
  return undefined
}

function sanitizePrologue(raw: unknown): NarrativePrologue | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined
  }
  const p = raw as Record<string, unknown>
  const why = typeof p.why === 'string' ? p.why.trim() : ''
  const what = typeof p.what === 'string' ? p.what.trim() : ''
  if (!why && !what) {
    return undefined
  }
  const key_changes: NarrativePrologueKeyChange[] = []
  if (Array.isArray(p.key_changes)) {
    for (const item of p.key_changes) {
      if (key_changes.length >= KEY_CHANGES_MAX) {
        break
      }
      if (!item || typeof item !== 'object') {
        continue
      }
      const it = item as Record<string, unknown>
      const title = typeof it.title === 'string' ? it.title.trim() : ''
      const detail = typeof it.detail === 'string' ? it.detail.trim() : ''
      if (!title) {
        continue
      }
      key_changes.push({ title, detail })
    }
  }
  return { why, what, key_changes }
}

export function sanitizeNarrative(raw: unknown, findingsCount: number): ReviewNarrative | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const r = raw as Record<string, unknown>

  const intent = typeof r.intent === 'string' ? r.intent.trim() : ''
  const confidence: NarrativeConfidence =
    r.confidence === 'high' || r.confidence === 'low' ? r.confidence : 'medium'
  const prologue = sanitizePrologue(r.prologue)
  // Archives written before the step rename used "chapters".
  const rawSteps = Array.isArray(r.steps) ? r.steps : Array.isArray(r.chapters) ? r.chapters : []

  const steps: NarrativeStep[] = []
  for (const c of rawSteps) {
    if (!c || typeof c !== 'object') {
      continue
    }
    const cc = c as Record<string, unknown>
    const title = typeof cc.title === 'string' ? cc.title.trim() : ''
    if (!title) {
      continue
    }
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
    const take =
      typeof cc.take === 'string' ? cc.take.trim().slice(0, TAKE_MAX) || undefined : undefined
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

  if (steps.length === 0 && !intent) {
    return null
  }
  const review_first = sanitizeReviewFirst(r.review_first, steps.length)
  return { intent, confidence, ...(prologue ? { prologue } : {}), steps, review_first }
}

const SEVERITIES: ReadonlySet<FindingSeverity> = new Set(['critical', 'major', 'minor', 'info'])
const KINDS: ReadonlySet<FindingKind> = new Set([
  'security',
  'perf',
  'convention',
  'design',
  'praise',
  'why',
])

/**
 * Whitelist and truncate, never throw, same doctrine as `sanitizeFindings`
 * itself: a `command` that is empty after trimming drops the WHOLE repro
 * (nothing to run is worse than no repro claimed at all), while `expected`
 * degrades to an empty string rather than dropping the pair, since it is
 * documentation for a human, not a condition anything checks.
 */
function sanitizeFindingRepro(raw: unknown): FindingRepro | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined
  }
  const r = raw as Record<string, unknown>
  const command =
    typeof r.command === 'string' ? r.command.trim().slice(0, FINDING_REPRO_COMMAND_MAX) : ''
  if (!command) {
    return undefined
  }
  const expected =
    typeof r.expected === 'string' ? r.expected.trim().slice(0, FINDING_REPRO_EXPECTED_MAX) : ''
  return { command, expected }
}

export function sanitizeFindings(raw: unknown): Finding[] {
  if (!Array.isArray(raw)) {
    return []
  }
  const out: Finding[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      continue
    }
    const f = item as Record<string, unknown>
    const file = typeof f.file === 'string' ? f.file.trim().slice(0, FILE_MAX) : ''
    const message = typeof f.message === 'string' ? f.message.trim().slice(0, MESSAGE_MAX) : ''
    if (!file || !message) {
      continue
    }
    const kind = KINDS.has(f.kind as FindingKind) ? (f.kind as FindingKind) : undefined
    // A praise/why finding carries no defect: any higher severity would trip
    // the verdict escalation and the --fail-on gate.
    const severity: FindingSeverity =
      kind === 'praise' || kind === 'why'
        ? 'info'
        : SEVERITIES.has(f.severity as FindingSeverity)
          ? (f.severity as FindingSeverity)
          : 'info'
    const line = Number.isInteger(f.line) && (f.line as number) > 0 ? (f.line as number) : undefined
    const endLine =
      line !== undefined && Number.isInteger(f.endLine) && (f.endLine as number) >= line
        ? (f.endLine as number)
        : undefined
    const title =
      typeof f.title === 'string' ? f.title.trim().slice(0, TITLE_MAX) || undefined : undefined
    const suggestion =
      typeof f.suggestion === 'string'
        ? f.suggestion.slice(0, SUGGESTION_MAX) || undefined
        : undefined
    const repro = sanitizeFindingRepro(f.repro)
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
      ...(repro !== undefined ? { repro } : {}),
    })
  }
  return out
}

const FILES_REVIEWED_MAX = 500

/** Bare strings are accepted for reviews written by pre-0.9 agents and archives. */
function sanitizeReviewedPaths(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined
  }
  const seen = new Set<string>()
  for (const item of raw) {
    const value =
      typeof item === 'string'
        ? item
        : item !== null &&
            typeof item === 'object' &&
            typeof (item as Record<string, unknown>).path === 'string'
          ? ((item as Record<string, unknown>).path as string)
          : null
    if (value === null) {
      continue
    }
    const path = value.trim().slice(0, FILE_MAX)
    if (!path) {
      continue
    }
    seen.add(path)
    if (seen.size >= FILES_REVIEWED_MAX) {
      break
    }
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
    if (!all.includes(file) && all.length < FILES_REVIEWED_MAX) {
      all.push(file)
    }
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
  // DP12: dedup on `criterion_id`, an invented id DISCARDED (never rebuilt),
  // an out-of-enum status degraded to 'unclear' (never to 'met', which would
  // fabricate a success) — all of it owned by ticket.ts, not restated here.
  // Nothing survives means the key is OMITTED, not emptied: see the field's
  // own doc on `SanitizedReview`.
  const criteria = sanitizeCriterionVerdicts(r.criteria)
  return {
    verdict,
    summary,
    findings,
    narrative,
    ...(reviewedPaths !== undefined
      ? { files_reviewed: reviewedFilesFrom(reviewedPaths, findings) }
      : {}),
    ...(criteria.length > 0 ? { criteria } : {}),
  }
}

/**
 * Revalidates a ReviewRecord read back from disk (a possibly corrupt archive,
 * hand-edited, or written by an older schema). Returns null when the input is not
 * a usable object; shape fields are normalized.
 */
function sanitizeDualStats(raw: unknown): DualStats | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined
  }
  const d = raw as Record<string, unknown>
  const counts = [d.merged, d.rejected, d.added_by_b]
  if (!counts.every((n) => Number.isInteger(n) && (n as number) >= 0)) {
    return undefined
  }
  return {
    merged: d.merged as number,
    rejected: d.rejected as number,
    added_by_b: d.added_by_b as number,
  }
}

export function sanitizeRecord(raw: unknown): ReviewRecord | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
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
    created_at:
      typeof m.created_at === 'string' && m.created_at ? m.created_at : new Date().toISOString(),
    ...(dual !== undefined ? { dual } : {}),
  }
  const commits = Array.isArray(r.commits)
    ? r.commits.filter((c): c is string => typeof c === 'string')
    : []
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
  if (!base) {
    return false
  }
  if (SENSITIVE_BASENAMES.has(base)) {
    return true
  }
  if (base === '.env') {
    return true
  }
  if (base.startsWith('.env.')) {
    return !DOTENV_ALLOWED_SUFFIXES.has(base.slice(5))
  }
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
  if (raw === '/dev/null') {
    return ''
  }
  return raw.startsWith('a/') || raw.startsWith('b/') ? raw.slice(2) : raw
}

/**
 * Scans a unified diff for material that looks like a committed secret, by file
 * name and by content. Content lines are checked on both sides of the diff: a
 * removed secret still appears in the payload. Never throws; the caller decides
 * whether to hold the diff back.
 */
export function detectDiffSecrets(diff: string): SecretMatch[] {
  if (typeof diff !== 'string' || !diff) {
    return []
  }
  const matches: SecretMatch[] = []
  const seen = new Set<string>()
  const add = (file: string, reason: SecretMatchReason, detail: string): void => {
    const key = `${file}\0${reason}\0${detail}`
    if (seen.has(key)) {
      return
    }
    seen.add(key)
    matches.push({ file, reason, detail })
  }
  let currentFile = ''
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      currentFile = gitHeaderNewPath(line)
      if (currentFile && sensitiveFilename(currentFile)) {
        add(currentFile, 'filename', currentFile)
      }
      continue
    }
    if (line.startsWith('+++ ') || line.startsWith('--- ')) {
      const path = markerLinePath(line)
      if (path) {
        if (!currentFile) {
          currentFile = path
        }
        if (sensitiveFilename(path)) {
          add(path, 'filename', path)
        }
      }
      continue
    }
    const isAdded = line.startsWith('+') && !line.startsWith('+++')
    const isRemoved = line.startsWith('-') && !line.startsWith('---')
    if (!isAdded && !isRemoved) {
      continue
    }
    const content = line.slice(1)
    for (const { label, re } of CONTENT_PATTERNS) {
      if (re.test(content)) {
        add(currentFile || '(unknown file)', 'content', label)
      }
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
      if (path) {
        files.add(path)
      }
      continue
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      const path = markerLinePath(line)
      if (path) {
        files.add(path)
      }
      if (line.startsWith('+++ ')) {
        currentNewPath = path
      }
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
  const report: GroundingReport = {
    dropped: [],
    deanchored: [],
    merged: 0,
    verdict_escalated: false,
  }
  const index = typeof diff === 'string' ? indexDiff(diff) : null
  if (!index) {
    return { review, report }
  }

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
        const severity =
          SEVERITY_ORDER[kept.severity] > SEVERITY_ORDER[first.severity]
            ? kept.severity
            : first.severity
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

/**
 * How a criterion's `evidence` names the line it proves: `path:line`, the same
 * new-file coordinates a finding uses. Everything else in the string is free
 * prose (the reviewer's quote), so an evidence that carries no anchor is not
 * malformed — it is simply UNGROUNDABLE, and `groundCriterionVerdicts` treats
 * it as such.
 *
 * Round 2, majeur 1(a). The first version of this rule read `/^\s*(...)/`: the
 * anchor had to be the FIRST thing in the evidence, bare, with no decoration.
 * A campaign over 28 plausible spellings grounded 8 of them — the SAME
 * criterion with the SAME proof flipped from `met` to `unclear` because the
 * model wrapped the path in backticks. That is not severity, it is a
 * formatting tax, and it was being charged to the WORK.
 *
 * So RECOGNITION is loose and SEVERITY is not. What widened is only what we
 * agree to READ as an anchor:
 *
 *  - the anchor may sit anywhere in the evidence — after prose, behind a
 *    markdown bullet, on the second line;
 *  - backticks and quotes are not part of a path, so they are not part of the
 *    match either;
 *  - `path:11`, `path:L11`, `path#L11` and `path line 11` are one coordinate in
 *    four spellings;
 *  - an OVER-QUALIFIED path resolves when a diff path is a suffix of it AT A
 *    `/` BOUNDARY (`anchorFileInDiff`). That one rule covers `b/src/gate.ts`
 *    and `a/src/gate.ts` — the form the diff literally displays, and the one
 *    `markerLinePath` already strips when it INDEXES it — plus `./src/gate.ts`
 *    and an absolute `/home/me/repo/src/gate.ts`;
 *  - several candidates in one evidence are all tried.
 *
 * What did NOT widen: every candidate is still checked against the diff — the
 * file must be in it and the line must be inside one of its `@@` hunks — and a
 * verdict whose evidence anchors nowhere still falls back to `unclear`. The
 * question stayed "is this proof verifiable?"; it stopped being "did the model
 * write the path undecorated?".
 */
const ANCHOR_SEPARATOR = String.raw`(?::L?|#L|\s+lines?\s+)`

/**
 * Undelimited scan, anywhere in the string. The path stops at whitespace, at
 * the separator's own punctuation and at any quote — which is exactly what
 * makes `` `src/gate.ts:11` `` and `"src/gate.ts:11"` parse without a
 * dedicated unwrapping pass.
 */
const ANCHOR_LOOSE_RE = new RegExp(String.raw`([^\s:#\`'"]+)${ANCHOR_SEPARATOR}(\d+)`, 'gi')

/** Backtick / double-quote / single-quote spans, read WHOLE (see below). */
const ANCHOR_DELIMITED_RE = /`([^`\n]+)`|"([^"\n]+)"|'([^'\n]+)'/g

/**
 * A delimited span that is an anchor and NOTHING else. This is the only form
 * in which a path may carry a space: `` `src/my file.ts:11` `` is unambiguous
 * precisely because the delimiters say where the path starts and stops, while
 * the same path written bare in prose does not. Anchored at both ends on
 * purpose — a span holding prose around the anchor is left to the loose scan,
 * which would read its path as ending at the last space.
 */
const ANCHOR_WHOLE_SPAN_RE = new RegExp(
  String.raw`^\s*(\S(?:[\s\S]*\S)?)${ANCHOR_SEPARATOR}(\d+)\s*$`,
  'i',
)

/**
 * Bound on how many candidates one evidence contributes. `evidence` is capped
 * at `CRITERION_VERDICT_EVIDENCE_MAX` code points by the sanitizer, but this
 * function is also reachable from a hand-built record, and the grounding loop
 * below is O(candidates x diff files). Thirty-two distinct anchors in a single
 * quote is already far past anything a reviewer writes.
 */
const EVIDENCE_ANCHORS_MAX = 32

/** Trailing prose punctuation a path never ends with. `.` is NOT in it: `a.ts` does. */
const PATH_TRAILING_PUNCTUATION = ',;)]}>*~'

/**
 * Leading prose punctuation a path never starts with: markdown emphasis and
 * the three bracket families a reviewer parenthesises an anchor with. `.` and
 * `_` are NOT in it — `./src/a.ts` and `_internal/a.ts` are both real paths.
 */
const PATH_LEADING_PUNCTUATION = '([{<*~'

/**
 * Both ends stripped in one scan, deliberately NOT with a regex. The trailing
 * form was written `/[,;)\]}>*~]+$/` first, and that shape is quadratic: with
 * nothing anchoring its start, the engine restarts the run at every position of
 * a long `)))…)` and re-walks it to the `$` it never reaches. Measured on the
 * regex it replaces: 10 000 closing parens took 72 ms, 20 000 took 276 ms,
 * 40 000 took 1 094 ms — the classic doubling-quadruples curve, on a string a
 * model writes. The sanitizer caps evidence at `CRITERION_VERDICT_EVIDENCE_MAX`
 * code points, but this function is also reachable from a hand-built record, so
 * the bound belongs in the parser rather than in its callers.
 *
 * The scan decides exactly the same strings, in one pass: leading first, then
 * trailing on what is left, which is the order the two `.replace()` calls had.
 */
function stripPathPunctuation(raw: string): string {
  let start = 0
  let end = raw.length
  while (start < end && PATH_LEADING_PUNCTUATION.includes(raw[start] as string)) {
    start += 1
  }
  while (end > start && PATH_TRAILING_PUNCTUATION.includes(raw[end - 1] as string)) {
    end -= 1
  }
  return raw.slice(start, end)
}

export type EvidenceAnchor = { file: string; line: number }

/**
 * The `path:line` coordinates an evidence claims, in the order they appear —
 * empty when it claims none. Never throws; a line that is not a positive safe
 * integer is no anchor at all (`a.ts:0`, `a.ts:99999999999999999999`), which
 * is honest: we would not be able to check it either way.
 */
export function parseEvidenceAnchors(evidence: unknown): EvidenceAnchor[] {
  if (typeof evidence !== 'string' || evidence === '') {
    return []
  }
  const out: EvidenceAnchor[] = []
  const push = (rawFile: string, rawLine: string): void => {
    if (out.length >= EVIDENCE_ANCHORS_MAX) {
      return
    }
    const file = stripPathPunctuation(rawFile.trim())
    const line = Number(rawLine)
    if (file && Number.isSafeInteger(line) && line > 0) {
      out.push({ file, line })
    }
  }
  // Delimited spans first: they are the only place a path may hold a space,
  // and reading the span whole is what makes that unambiguous.
  for (const span of evidence.matchAll(ANCHOR_DELIMITED_RE)) {
    const whole = ANCHOR_WHOLE_SPAN_RE.exec(span[1] ?? span[2] ?? span[3] ?? '')
    if (whole) {
      push(whole[1] as string, whole[2] as string)
    }
  }
  for (const match of evidence.matchAll(ANCHOR_LOOSE_RE)) {
    push(match[1] as string, match[2] as string)
  }
  return out
}

/**
 * The FIRST coordinate an evidence claims, or null when it claims none. Kept
 * beside `parseEvidenceAnchors` because "what does this evidence point at" is
 * a question with one useful answer for a caller that only wants to show it;
 * the grounding below deliberately tries them all.
 */
export function parseEvidenceAnchor(evidence: unknown): EvidenceAnchor | null {
  return parseEvidenceAnchors(evidence)[0] ?? null
}

/**
 * Which diff path an anchor's path names, or null. TWO readings, and the second
 * subsumes more than it looks like it does: the path exactly as written, then
 * the LONGEST diff path that is a suffix of it AT A `/` BOUNDARY.
 *
 * That suffix rule is what makes `b/src/gate.ts`, `a/src/gate.ts`,
 * `./src/gate.ts` and `/home/me/repo/src/gate.ts` all resolve to the diff's own
 * `src/gate.ts`: any prefix at all ends the decorated path with `/src/gate.ts`.
 * A dedicated `a/`/`b/`/`./` stripper was written here first and then deleted —
 * every input it could decide, this loop decides identically, which is the
 * honest definition of dead (the same rule that removed two conjuncts from
 * `groundCriterionVerdicts`). A mutation campaign confirmed it: stripping the
 * stripper reddened nothing.
 *
 * The `/` boundary is the whole severity of the rule — it is what stops
 * `src/gate.ts` from being found inside `notsrc/gate.ts`, and what stops a bare
 * `gate.ts` from matching any file that happens to end in it.
 */
function anchorFileInDiff(index: DiffIndex, file: string): string | null {
  if (index.hunks.has(file)) {
    return file
  }
  let best: string | null = null
  for (const known of index.hunks.keys()) {
    if (file.endsWith(`/${known}`) && (best === null || known.length > best.length)) {
      best = known
    }
  }
  return best
}

/**
 * Whether an evidence points at a line the diff actually carries. ONE check,
 * not two: `index.hunks` is only ever keyed by a path that `index.files` also
 * carries (both are filled from the same `+++` line), so a `files.has(...)`
 * conjunct would be a branch no input can decide — a mutation campaign found
 * it unkillable, which is the honest definition of dead. A file absent from
 * the diff has no hunks entry at all, so it fails here exactly like a line
 * outside every hunk does; a deleted file (`+++ /dev/null`) never gets one
 * either, which is right — there is no new-file line for an evidence to point
 * at.
 */
function evidenceIsAnchoredIn(index: DiffIndex, evidence: unknown): boolean {
  return parseEvidenceAnchors(evidence).some((anchor) => {
    const file = anchorFileInDiff(index, anchor.file)
    return file !== null && lineInHunks(index.hunks.get(file), anchor.line)
  })
}

export type CriteriaGroundingReport = {
  /** Verdicts whose evidence claimed an anchor the diff does not carry; the evidence was removed. */
  dropped_evidence: CriterionVerdict[]
  /** Verdicts whose status fell to 'unclear' because nothing grounded it. */
  demoted: CriterionVerdict[]
  /** The diff could not be indexed at all: NOTHING in it could be verified. */
  diff_unreadable: boolean
}

/**
 * Deterministic post-check of per-criterion verdicts against the reviewed diff
 * (T3.2), on the exact pattern of `groundReview` above: same `indexDiff` /
 * `lineInHunks`, same "never throws" contract, same vocabulary of a dropped
 * anchor. What differs is the CONSEQUENCE, and deliberately so — a finding
 * that loses its anchor is still a finding, while a criterion verdict that
 * loses its proof is no longer a verdict:
 *
 * - an evidence whose `path:line` names a file absent from the diff, or a line
 *   outside every hunk of a file that IS in the diff, is REMOVED;
 * - a verdict that CLAIMED an evidence and lost it falls to `'unclear'`: the
 *   reviewer asserted something checkable and the check failed, so the whole
 *   verdict stops being trustworthy;
 * - a `'met'` with no surviving evidence falls to `'unclear'` too — a positive
 *   claim with no proof is a doubt, and D11's gate treats a doubt as a block.
 *   An `'unmet'` that never claimed an anchor keeps its status: nothing about
 *   it was falsified, and blurring a named failure into a shrug would lose
 *   information without changing what the gate decides.
 *
 * An UNINDEXABLE diff (`diff_unreadable`) is not "leave everything alone" the
 * way it is for `groundReview`: there, keeping unverified findings only risks
 * noise; here it would let a model's `'met'` through a merge gate with nothing
 * behind it. So the output degrades — every `met` becomes `unclear` — and the
 * report says why. It still never throws.
 */
export function groundCriterionVerdicts(
  verdicts: readonly CriterionVerdict[],
  diff: string,
): { verdicts: CriterionVerdict[]; report: CriteriaGroundingReport } {
  const index = typeof diff === 'string' ? indexDiff(diff) : null
  const report: CriteriaGroundingReport = {
    dropped_evidence: [],
    demoted: [],
    diff_unreadable: index === null,
  }
  const out: CriterionVerdict[] = []
  for (const verdict of verdicts) {
    // ONE condition, not two (round 2, mineur 7): `evidenceIsAnchoredIn` is
    // false for an evidence that claims nothing, so a `parseEvidenceAnchor(...)
    // !== null` conjunct in front of it would be a third branch no input can
    // decide — the same "a branch no input can reach is dead" rule that
    // removed the other two in this function, applied to itself.
    const grounded = index !== null && evidenceIsAnchoredIn(index, verdict.evidence)
    if (grounded) {
      out.push(verdict)
      continue
    }
    const claimed = typeof verdict.evidence === 'string' && verdict.evidence !== ''
    if (claimed) {
      report.dropped_evidence.push(verdict)
    }
    const status: CriterionStatus = claimed || verdict.status === 'met' ? 'unclear' : verdict.status
    if (status !== verdict.status) {
      report.demoted.push(verdict)
    }
    out.push({ criterion_id: verdict.criterion_id, status })
  }
  return { verdicts: out, report }
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
        // DP12 / T3.2. `minItems: 1` because ABSENCE is how "this review
        // judged no criteria" is said — `sanitizeReview` omits the key rather
        // than writing `[]`. `uniqueItems` catches a literal duplicate item;
        // it does NOT catch two entries sharing a `criterion_id` while
        // differing in status or evidence (draft 2020-12 has no "unique by
        // property" keyword) — the same documented gap as
        // `recapRecordSchema.criteria`. That stronger guarantee is made on the
        // producing side, by `sanitizeCriterionVerdicts`.
        criteria: {
          type: 'array',
          minItems: 1,
          maxItems: TICKET_CRITERIA_MAX,
          uniqueItems: true,
          items: { $ref: '#/$defs/criterionVerdict' },
        },
      },
    },
    criterionVerdict: {
      type: 'object',
      additionalProperties: false,
      required: ['criterion_id', 'status'],
      properties: {
        criterion_id: { type: 'string', pattern: '^ac-[0-9a-f]{12}$' },
        status: { enum: ['met', 'unmet', 'unclear'] },
        // Multi-line-capable prose (the reviewer's quoted grounding, DP12):
        // bounded, never blanked — `sanitizeCriterionVerdict` omits an empty
        // evidence instead of storing one.
        //
        // Round 2, mineur 3: `NON_BLANK` (ticket.ts), the SAME pattern
        // `recapRecordSchema.$defs.criterionVerdict.evidence` uses, in place of
        // the `minLength: 1` this $def shipped with. The two schemas publish
        // one type; the bare `minLength` accepted `'   '`, which the sanitizer
        // trims to empty and then OMITS — a schema looser than its own
        // sanctioned reader, on a field whose twin was already locked.
        evidence: {
          type: 'string',
          maxLength: CRITERION_VERDICT_EVIDENCE_MAX,
          pattern: NON_BLANK,
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
        repro: { $ref: '#/$defs/findingRepro' },
      },
    },
    // `command` carries `NON_BLANK`: `sanitizeFindingRepro` drops the WHOLE
    // repro rather than keep a blank command (see its own doc comment), so a
    // finding this schema admits must never claim a repro with nothing to
    // run. `expected` has no such guarantee: the sanitizer keeps an empty one.
    findingRepro: {
      type: 'object',
      additionalProperties: false,
      required: ['command', 'expected'],
      properties: {
        command: { type: 'string', maxLength: FINDING_REPRO_COMMAND_MAX, pattern: NON_BLANK },
        expected: { type: 'string', maxLength: FINDING_REPRO_EXPECTED_MAX },
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
