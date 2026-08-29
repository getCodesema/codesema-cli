/**
 * The runbook: how a repository is installed, started and tested inside a
 * microVM, so that "it passes" can be REPLAYED mechanically by the runner in a
 * VM the agent never touched. Proposed by an agent, accepted only after a real
 * green execution, stored both in the repository (`.codesema/runbook.json`)
 * and in the hub (validated against a repository sha).
 *
 * Every list is bounded and every entry whitelisted: a runbook is executed as
 * shell inside a VM whose egress is opened to `egress`, so a value the
 * sanitizer would not accept is a value the runner must never run.
 */

export const RUNBOOK_VERSION = 1

export type RunbookServices = {
  /**
   * Commands started at boot, in order, before the healthchecks (e.g.
   * `dockerd`, `docker compose up -d`). Empty when the repository needs no
   * running service to be tested.
   */
  host_up: string[]
  /** Compose file the services come from, relative to the worktree; null when none. */
  compose_file: string | null
}

export type RunbookConfig = {
  version: typeof RUNBOOK_VERSION
  /**
   * OCI image the VM boots from. Must ship `dockerd` when `services.host_up`
   * or `services.compose_file` is set: the VM has no Docker of its own.
   */
  image: string
  /** Commands run ONCE in the base VM before its snapshot (dependencies, build artifacts the tests need). */
  install: string[]
  services: RunbookServices
  /** Commands retried until they exit 0 (or the runner's deadline) before the tests run. */
  healthchecks: string[]
  /** Commands that must ALL exit 0 for the verdict to be green. Never empty: a runbook without tests proves nothing. */
  tests: string[]
  /** Exact domain names opened in addition to the runner's defaults, during install and services only. */
  egress: string[]
  /**
   * Worktree-relative files whose change invalidates this runbook (lockfiles,
   * compose files, test configs, the scripts of package.json): a ticket whose
   * worktree differs from the validated sha on any of them is REFUSED by the
   * verification and triggers a re-scan.
   */
  depends_on_files: string[]
}

export type RunbookValidationStatus = 'valid' | 'stale' | 'failed'

export type RunbookValidation = {
  /** sha256 (16 hex) of `canonicalRunbookJson(runbook)`. */
  runbook_sha: string
  /** Repository commit the runbook was validated against (7 to 64 hex). */
  validated_sha: string
  validated_at: string
  status: RunbookValidationStatus
}

export const RUNBOOK_IMAGE_MAX = 200
export const RUNBOOK_COMMAND_MAX = 500
export const RUNBOOK_COMMANDS_MAX = 32
export const RUNBOOK_EGRESS_MAX = 32
export const RUNBOOK_HOST_MAX = 253
export const RUNBOOK_PATH_MAX = 500
export const RUNBOOK_PATHS_MAX = 64
export const RUNBOOK_TIMESTAMP_MAX = 40

/** `registry.host:5000/org/image:tag@sha256:...` and every shorter form of it. */
const RUNBOOK_IMAGE_RE =
  /^[a-zA-Z0-9][a-zA-Z0-9._-]*(:[0-9]{1,5})?(\/[a-zA-Z0-9._-]+)*(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(@sha256:[a-f0-9]{64})?$/
/** One exact, lowercase, fully qualified domain name: no wildcard, no scheme, no port. */
const RUNBOOK_HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
const RUNBOOK_SHA_RE = /^[0-9a-f]{16}$/
const GIT_SHA_RE = /^[0-9a-f]{7,64}$/

const RUNBOOK_VALIDATION_STATUSES: ReadonlySet<RunbookValidationStatus> = new Set([
  'valid',
  'stale',
  'failed',
])

export function isRunbookValidationStatus(value: unknown): value is RunbookValidationStatus {
  return RUNBOOK_VALIDATION_STATUSES.has(value as RunbookValidationStatus)
}

const str = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.trim().slice(0, max).trim() : ''

const isoOrNow = (v: unknown): string =>
  typeof v === 'string' && v.trim()
    ? v.trim().slice(0, RUNBOOK_TIMESTAMP_MAX)
    : new Date().toISOString()

/**
 * A command is one non-blank shell line, bounded. Blank and non-string entries
 * are dropped; the list is cut at RUNBOOK_COMMANDS_MAX. Order is kept: a
 * runbook is a sequence, not a set.
 */
function commandList(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return []
  }
  const out: string[] = []
  for (const item of raw) {
    if (out.length >= RUNBOOK_COMMANDS_MAX) {
      break
    }
    const command = str(item, RUNBOOK_COMMAND_MAX)
    if (command && !/[\r\n]/.test(command)) {
      out.push(command)
    }
  }
  return out
}

/**
 * A worktree-relative path: no leading slash, no drive letter, no backslash,
 * no `..` segment, no NUL. Anything else is dropped rather than resolved.
 */
export function isRunbookRelativePath(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false
  }
  const p = value.trim()
  if (!p || p.length > RUNBOOK_PATH_MAX || p !== value) {
    return false
  }
  if (
    p.startsWith('/') ||
    p.startsWith('~') ||
    /^[A-Za-z]:/.test(p) ||
    p.includes('\\') ||
    p.includes('\0')
  ) {
    return false
  }
  return !p.split('/').some((segment) => segment === '..' || segment === '')
}

function pathList(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return []
  }
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (out.length >= RUNBOOK_PATHS_MAX) {
      break
    }
    if (isRunbookRelativePath(item) && !seen.has(item)) {
      seen.add(item)
      out.push(item)
    }
  }
  return out
}

/** Exact hosts only, lowercased, deduplicated, bounded; anything else is dropped. */
function hostList(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return []
  }
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (out.length >= RUNBOOK_EGRESS_MAX) {
      break
    }
    const host = str(item, RUNBOOK_HOST_MAX).toLowerCase()
    if (RUNBOOK_HOST_RE.test(host) && !seen.has(host)) {
      seen.add(host)
      out.push(host)
    }
  }
  return out
}

/**
 * Revalidates a runbook read from disk, from the hub, or proposed by an agent.
 * Returns null when the runbook cannot be executed honestly: wrong version,
 * no bootable image, or no test to run. Individual bad entries are dropped,
 * never repaired.
 */
export function sanitizeRunbookConfig(raw: unknown): RunbookConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null
  }
  const r = raw as Record<string, unknown>
  if (r.version !== RUNBOOK_VERSION) {
    return null
  }
  // An image reference is never truncated: a cut reference names a different
  // image, so an over-long one is refused outright.
  const image = typeof r.image === 'string' ? r.image.trim() : ''
  if (!image || image.length > RUNBOOK_IMAGE_MAX || !RUNBOOK_IMAGE_RE.test(image)) {
    return null
  }
  const tests = commandList(r.tests)
  if (tests.length === 0) {
    return null
  }
  const services =
    r.services && typeof r.services === 'object' && !Array.isArray(r.services)
      ? (r.services as Record<string, unknown>)
      : {}
  const composeFile = services.compose_file
  return {
    version: RUNBOOK_VERSION,
    image,
    install: commandList(r.install),
    services: {
      host_up: commandList(services.host_up),
      compose_file: isRunbookRelativePath(composeFile) ? composeFile : null,
    },
    healthchecks: commandList(r.healthchecks),
    tests,
    egress: hostList(r.egress),
    depends_on_files: pathList(r.depends_on_files),
  }
}

/**
 * The ONE serialization both repositories hash: fixed key order, no
 * whitespace, arrays in their own order. `runbook_sha` is the first 16 hex of
 * sha256 over this string, computed by the consumer with its own crypto.
 */
export function canonicalRunbookJson(runbook: RunbookConfig): string {
  return JSON.stringify({
    version: runbook.version,
    image: runbook.image,
    install: runbook.install,
    services: {
      host_up: runbook.services.host_up,
      compose_file: runbook.services.compose_file,
    },
    healthchecks: runbook.healthchecks,
    tests: runbook.tests,
    egress: runbook.egress,
    depends_on_files: runbook.depends_on_files,
  })
}

export function isRunbookSha(value: unknown): value is string {
  return typeof value === 'string' && RUNBOOK_SHA_RE.test(value)
}

/**
 * Revalidates a validation record. Null when it names nothing verifiable
 * (bad shas, unknown status): a validation the reader cannot trust is not a
 * validation at all.
 */
export function sanitizeRunbookValidation(raw: unknown): RunbookValidation | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null
  }
  const r = raw as Record<string, unknown>
  const runbookSha = typeof r.runbook_sha === 'string' ? r.runbook_sha.trim().toLowerCase() : ''
  const validatedSha =
    typeof r.validated_sha === 'string' ? r.validated_sha.trim().toLowerCase() : ''
  if (!RUNBOOK_SHA_RE.test(runbookSha) || !GIT_SHA_RE.test(validatedSha)) {
    return null
  }
  if (!isRunbookValidationStatus(r.status)) {
    return null
  }
  return {
    runbook_sha: runbookSha,
    validated_sha: validatedSha,
    validated_at: isoOrNow(r.validated_at),
    status: r.status,
  }
}

/** A runbook scan as the hub hands it to a runner (queue item, `/api/cli/runbook-scans`). */
export type RunbookScanStatus = 'queued' | 'running' | 'completed' | 'failed'

export type RunbookScan = {
  id: string
  repo_id: string
  repo_full_name: string
  /** Repository commit the scan should validate against; null lets the runner use the default branch tip. */
  head_sha: string | null
  status: RunbookScanStatus
  requested_at: string
}

export const RUNBOOK_SCAN_NAME_MAX = 300

const RUNBOOK_SCAN_STATUSES: ReadonlySet<RunbookScanStatus> = new Set([
  'queued',
  'running',
  'completed',
  'failed',
])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isRunbookScanStatus(value: unknown): value is RunbookScanStatus {
  return RUNBOOK_SCAN_STATUSES.has(value as RunbookScanStatus)
}

/** Revalidates a queue item from the hub; null when it names no repository or no usable id. */
export function sanitizeRunbookScan(raw: unknown): RunbookScan | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null
  }
  const r = raw as Record<string, unknown>
  const id = typeof r.id === 'string' ? r.id.trim().toLowerCase() : ''
  const repoId = typeof r.repo_id === 'string' ? r.repo_id.trim().toLowerCase() : ''
  if (!UUID_RE.test(id) || !UUID_RE.test(repoId) || !isRunbookScanStatus(r.status)) {
    return null
  }
  const headSha = typeof r.head_sha === 'string' ? r.head_sha.trim().toLowerCase() : ''
  return {
    id,
    repo_id: repoId,
    repo_full_name: str(r.repo_full_name, RUNBOOK_SCAN_NAME_MAX),
    head_sha: GIT_SHA_RE.test(headSha) ? headSha : null,
    status: r.status,
    requested_at: isoOrNow(r.requested_at),
  }
}
