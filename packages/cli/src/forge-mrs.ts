import { execFile } from 'node:child_process'
import { detectForgeHint, tryGit } from './git.js'

export type ForgeMrState = 'open' | 'merged' | 'closed'
export type ForgeMrMergeable = 'mergeable' | 'conflicting' | 'unknown'

export type ForgeCheckRollup = {
  passed: number
  failed: number
  pending: number
  skipped: number
  truncated: boolean
}

export type ForgeMr = {
  number: number
  title: string
  author: string
  sourceBranch: string
  targetBranch: string
  updatedAt: string
  url: string
  state: ForgeMrState | null
  isDraft: boolean | null
  labels: string[] | null
  additions: number | null
  deletions: number | null
  changedFiles: number | null
  checks: ForgeCheckRollup | null
  reviewers: string[] | null
  assignees: string[] | null
  milestone: string | null
  mergeable: ForgeMrMergeable | null
  commits: number | null
  body: string | null
}

/**
 * `truncated` is never optional on the success branch (same invariant as
 * forge-issues.ts's `ForgeIssuesResult`): a caller cannot hold a capped list
 * without being handed the fact that it is capped.
 */
export type ForgeMrsResult =
  | { available: true; mrs: ForgeMr[]; truncated: boolean }
  | { available: false; reason: 'no-remote' | 'no-cli' | 'cli-error' }

/**
 * `commits` is deliberately absent: gh's GraphQL query walks it down to each
 * commit's `authors`, roughly 5000 nodes per MR, and the node budget scales
 * with `--limit`. At `--limit 201` (MR_LIST_MAX below) GitHub's API refuses
 * the whole query with "exceeds the maximum limit of 500,000" nodes, verified
 * against the real getCodesema/codesema-cli repo. Since a refused query fails
 * the ENTIRE `pr list` call, keeping `commits` would turn every MR list past
 * roughly a hundred open MRs into a full `cli-error`, exactly the whole-list
 * rejection the field-by-field degradation doctrine forbids. `commits` stays
 * null for gh, same as it already is for glab (see parseGlabMrList).
 */
// prettier-ignore
const GH_JSON_FIELDS = 'number,title,author,headRefName,baseRefName,updatedAt,url,state,isDraft,labels,additions,deletions,changedFiles,statusCheckRollup,reviewRequests,assignees,milestone,mergeable,body'
const EXEC_TIMEOUT_MS = 8000

/**
 * Hard cap on one `listOpenMrs` answer, same doctrine as forge-issues.ts's
 * `ISSUE_LIST_MAX`: both `gh pr list` and `glab mr list` stop at 30 items by
 * default (gh `-L/--limit`, glab `-P/--per-page`), exactly the SILENT
 * truncation this cap replaces. The size is now asked for explicitly, and
 * whatever the cap leaves out is reported as `truncated: true`, never dropped
 * in silence. Same magnitude as `ISSUE_LIST_MAX` for the same reason: open
 * MRs are typically far fewer than an issue backlog, but the cap exists to
 * bound a pathological repo, not to describe a normal one.
 */
export const MR_LIST_MAX = 200
/** One MR past the cap is what proves there are more; the extra one is never returned. */
const GH_MR_LIMIT = String(MR_LIST_MAX + 1)
/**
 * GitLab's REST API clamps `per_page` at 100 whatever is asked for (same
 * quirk forge-issues.ts documents for issues), so glab cannot answer "give me
 * 201" in one go: it pages.
 */
const GLAB_PAGE_SIZE = 100
const GLAB_PER_PAGE = String(GLAB_PAGE_SIZE)
const GLAB_MAX_PAGES = Math.ceil((MR_LIST_MAX + 1) / GLAB_PAGE_SIZE)

/**
 * Same budget and reasoning as forge-issues.ts's `FORGE_MAX_BUFFER_BYTES`.
 * Node's default `maxBuffer` is 1 MiB, and this contract's `commits` (the
 * full commit list) and `body` (the full Markdown description) are its
 * heaviest fields by far: a `pr list`/`mr list` answer can blow past the
 * default as soon as MRs carry real descriptions. Past it, `execFile` kills
 * the process, `runForgeCli` maps that to `{ kind: 'error' }`, and the WHOLE
 * list would be reported unavailable even though the data existed: exactly
 * the whole-list rejection the field-by-field degradation doctrine forbids.
 */
export const FORGE_MR_MAX_BUFFER_BYTES = 64 * 1024 * 1024

/**
 * Bounds for the GitLab per-MR enrichment fan-out (see `enrichGlabMrs`).
 * `mr list` does not carry diff size or CI status the way `gh pr list --json`
 * does, so both need one `glab api` call per MR. CONCURRENCY caps how many of
 * those calls run at once; BUDGET_MS caps how long the whole enrichment phase
 * may run. CALL_TIMEOUT_MS is each call's own ceiling, but a call is never
 * allowed to outlive the phase: every dispatch is timed with
 * `min(CALL_TIMEOUT_MS, remaining budget)`, so a call started near the
 * deadline gets a short leash instead of the full 5s, and the phase as a
 * whole never runs meaningfully past BUDGET_MS. Whatever the deadline leaves
 * unenriched is returned as-is, rather than making one slow repo stall the
 * entire `/api/mrs` request.
 */
const GLAB_ENRICH_CONCURRENCY = 4
const GLAB_ENRICH_CALL_TIMEOUT_MS = 5000
const GLAB_ENRICH_BUDGET_MS = 6000

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function readRecordProp(record: Record<string, unknown>, key: string): unknown {
  return record[key]
}

function parseBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function parseNumber(value: unknown): number | null {
  return isFiniteNumber(value) ? value : null
}

function parseOptionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** Every entry must be a plain string, or the whole field degrades to null (never a partial list). */
function parseStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null
  }
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') {
      return null
    }
    out.push(item)
  }
  return out
}

// --- GitHub (`gh`) field mapping ---------------------------------------------

const GH_STATE_MAP: Record<string, ForgeMrState> = {
  OPEN: 'open',
  MERGED: 'merged',
  CLOSED: 'closed',
}

function parseGhState(value: unknown): ForgeMrState | null {
  return typeof value === 'string' ? (GH_STATE_MAP[value] ?? null) : null
}

const GH_MERGEABLE_MAP: Record<string, ForgeMrMergeable> = {
  MERGEABLE: 'mergeable',
  CONFLICTING: 'conflicting',
  UNKNOWN: 'unknown',
}

function parseGhMergeable(value: unknown): ForgeMrMergeable | null {
  return typeof value === 'string' ? (GH_MERGEABLE_MAP[value] ?? null) : null
}

/** gh's `labels` field is an array of Label nodes (`{id,name,description,color}`), never bare strings. */
function parseGhLabels(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null
  }
  const names: string[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) {
      return null
    }
    const name = readRecordProp(item as Record<string, unknown>, 'name')
    if (!isNonEmptyString(name)) {
      return null
    }
    names.push(name)
  }
  return names
}

/** gh's `assignees` field is an array of GitHubUser nodes (`{id,login,name,databaseId}`). */
function parseGhLogins(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null
  }
  const logins: string[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) {
      return null
    }
    const login = readRecordProp(item as Record<string, unknown>, 'login')
    if (!isNonEmptyString(login)) {
      return null
    }
    logins.push(login)
  }
  return logins
}

/**
 * gh's `reviewRequests` mixes two shapes (api/export_pr.go): a requested User
 * carries `login`, a requested Team carries `name` (and `slug`) instead. Both
 * are folded into one name here since the contract only wants a flat list of
 * reviewer identifiers, not a distinction between a person and a team.
 */
function parseGhReviewRequests(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null
  }
  const names: string[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) {
      return null
    }
    const r = item as Record<string, unknown>
    const login = readRecordProp(r, 'login')
    const teamName = readRecordProp(r, 'name')
    if (isNonEmptyString(login)) {
      names.push(login)
    } else if (isNonEmptyString(teamName)) {
      names.push(teamName)
    } else {
      return null
    }
  }
  return names
}

/** gh's `milestone` is `null`, or a Milestone object (`{number,title,description,dueOn}`). */
function parseGhMilestone(value: unknown): string | null {
  if (value === null || typeof value !== 'object') {
    return null
  }
  const title = readRecordProp(value as Record<string, unknown>, 'title')
  return isNonEmptyString(title) ? title : null
}

const GH_CHECKRUN_PASSED = new Set(['SUCCESS', 'NEUTRAL'])
const GH_CHECKRUN_SKIPPED = new Set(['SKIPPED', 'CANCELLED', 'STALE'])
const GH_STATUSCONTEXT_PASSED = new Set(['SUCCESS'])
const GH_STATUSCONTEXT_PENDING = new Set(['PENDING', 'EXPECTED'])

/**
 * gh's own GraphQL query caps this connection at `contexts(first:100)`
 * (cli/cli api/query_builder.go) and its JSON export never surfaces the
 * connection's `hasNextPage`, so a returned length of exactly 100 is the
 * only observable signal that more checks might exist, and is treated as
 * truncated. A PR with exactly 100 checks and no more would be flagged too;
 * that false positive is the honest trade-off for never claiming a
 * completeness gh itself cannot vouch for.
 */
const GH_STATUS_CHECK_ROLLUP_CAP = 100

/**
 * gh exports `statusCheckRollup` as `null` only when the PR's head commit
 * carries no rollup at all (StatusCheckRollup.Nodes empty), no measurement
 * was possible, so the whole rollup is null rather than an all-zero one. An
 * empty array, by contrast, is a real answer: the head commit exists and
 * reports zero checks.
 *
 * Each entry is either a CheckRun (`status`/`conclusion`, GitHub Actions and
 * app-based checks) or a legacy StatusContext (`state`, commit statuses):
 * distinguished by `__typename`, per api/export_pr.go. An unrecognised or
 * still-running CheckRun conclusion, and an unrecognised StatusContext state,
 * both fall into `failed`: a completed-but-unread signal should draw
 * attention rather than disappear into a count nobody asked about.
 */
function parseGhChecks(value: unknown): ForgeCheckRollup | null {
  if (value === null) {
    return null
  }
  if (!Array.isArray(value)) {
    return null
  }
  const rollup: ForgeCheckRollup = {
    passed: 0,
    failed: 0,
    pending: 0,
    skipped: 0,
    truncated: value.length >= GH_STATUS_CHECK_ROLLUP_CAP,
  }
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) {
      return null
    }
    const e = entry as Record<string, unknown>
    if (readRecordProp(e, '__typename') === 'CheckRun') {
      const status = readRecordProp(e, 'status')
      const conclusion = readRecordProp(e, 'conclusion')
      if (status !== 'COMPLETED') {
        rollup.pending += 1
      } else if (typeof conclusion === 'string' && GH_CHECKRUN_PASSED.has(conclusion)) {
        rollup.passed += 1
      } else if (typeof conclusion === 'string' && GH_CHECKRUN_SKIPPED.has(conclusion)) {
        rollup.skipped += 1
      } else {
        rollup.failed += 1
      }
    } else {
      const state = readRecordProp(e, 'state')
      if (typeof state === 'string' && GH_STATUSCONTEXT_PASSED.has(state)) {
        rollup.passed += 1
      } else if (typeof state === 'string' && GH_STATUSCONTEXT_PENDING.has(state)) {
        rollup.pending += 1
      } else {
        rollup.failed += 1
      }
    }
  }
  return rollup
}

/** Parses and validates `gh pr list --json ...` output; null on any shape mismatch. */
export function parseGhMrList(raw: string): ForgeMr[] | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(data)) {
    return null
  }

  const mrs: ForgeMr[] = []
  for (const entry of data) {
    if (typeof entry !== 'object' || entry === null) {
      return null
    }
    const e = entry as Record<string, unknown>
    const author = readRecordProp(e, 'author')
    const login =
      typeof author === 'object' && author !== null
        ? readRecordProp(author as Record<string, unknown>, 'login')
        : undefined
    // The original 7 fields keep their exact validation: any mismatch here
    // still rejects the whole payload, same as before this contract grew.
    if (
      typeof e.number !== 'number' ||
      !isNonEmptyString(e.title) ||
      !isNonEmptyString(login) ||
      !isNonEmptyString(e.headRefName) ||
      !isNonEmptyString(e.baseRefName) ||
      !isIsoTimestamp(e.updatedAt) ||
      !isNonEmptyString(e.url)
    ) {
      return null
    }
    mrs.push({
      number: e.number,
      title: e.title,
      author: login,
      sourceBranch: e.headRefName,
      targetBranch: e.baseRefName,
      updatedAt: e.updatedAt,
      url: e.url,
      state: parseGhState(e.state),
      isDraft: parseBoolean(e.isDraft),
      labels: parseGhLabels(e.labels),
      additions: parseNumber(e.additions),
      deletions: parseNumber(e.deletions),
      changedFiles: parseNumber(e.changedFiles),
      checks: parseGhChecks(e.statusCheckRollup),
      reviewers: parseGhReviewRequests(e.reviewRequests),
      assignees: parseGhLogins(e.assignees),
      milestone: parseGhMilestone(e.milestone),
      mergeable: parseGhMergeable(e.mergeable),
      // Never requested (see GH_JSON_FIELDS above): gh's commit list blows
      // past GitHub's GraphQL node budget once --limit grows with MR_LIST_MAX.
      commits: null,
      body: parseOptionalString(e.body),
    })
  }
  return mrs
}

// --- GitLab (`glab`) field mapping --------------------------------------------

const GLAB_STATE_MAP: Record<string, ForgeMrState> = {
  opened: 'open',
  merged: 'merged',
  closed: 'closed',
}

function parseGlabState(value: unknown): ForgeMrState | null {
  return typeof value === 'string' ? (GLAB_STATE_MAP[value] ?? null) : null
}

/**
 * GitLab REST deprecated `merge_status` in favour of `detailed_merge_status`
 * (GitLab API docs, merge requests), but the porcelain list payload still
 * carries only the former, and it is what the contract asks to map: values
 * are `unchecked`/`checking` (not yet resolved), `can_be_merged`, and
 * `cannot_be_merged`/`cannot_be_merged_recheck`.
 */
const GLAB_MERGE_STATUS_MAP: Record<string, ForgeMrMergeable> = {
  can_be_merged: 'mergeable',
  cannot_be_merged: 'conflicting',
  cannot_be_merged_recheck: 'conflicting',
  unchecked: 'unknown',
  checking: 'unknown',
}

function parseGlabMergeable(value: unknown): ForgeMrMergeable | null {
  return typeof value === 'string' ? (GLAB_MERGE_STATUS_MAP[value] ?? null) : null
}

/** `draft` is the current field; `work_in_progress` is GitLab's older, deprecated equivalent. */
function parseGlabIsDraft(draft: unknown, workInProgress: unknown): boolean | null {
  if (typeof draft === 'boolean') {
    return draft
  }
  return typeof workInProgress === 'boolean' ? workInProgress : null
}

/** GitLab's `assignees`/`reviewers` are arrays of user objects; the contract wants their `username`. */
function parseGlabUsernames(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null
  }
  const usernames: string[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) {
      return null
    }
    const username = readRecordProp(item as Record<string, unknown>, 'username')
    if (!isNonEmptyString(username)) {
      return null
    }
    usernames.push(username)
  }
  return usernames
}

function parseGlabMilestone(value: unknown): string | null {
  if (value === null || typeof value !== 'object') {
    return null
  }
  const title = readRecordProp(value as Record<string, unknown>, 'title')
  return isNonEmptyString(title) ? title : null
}

/** Parses and validates `glab mr list --output json` output; null on any shape mismatch. */
export function parseGlabMrList(raw: string): ForgeMr[] | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(data)) {
    return null
  }

  const mrs: ForgeMr[] = []
  for (const entry of data) {
    if (typeof entry !== 'object' || entry === null) {
      return null
    }
    const e = entry as Record<string, unknown>
    const author = readRecordProp(e, 'author')
    const username =
      typeof author === 'object' && author !== null
        ? readRecordProp(author as Record<string, unknown>, 'username')
        : undefined
    // The original 7 fields keep their exact validation: any mismatch here
    // still rejects the whole payload, same as before this contract grew.
    if (
      typeof e.iid !== 'number' ||
      !isNonEmptyString(e.title) ||
      !isNonEmptyString(username) ||
      !isNonEmptyString(e.source_branch) ||
      !isNonEmptyString(e.target_branch) ||
      !isIsoTimestamp(e.updated_at) ||
      !isNonEmptyString(e.web_url)
    ) {
      return null
    }
    mrs.push({
      number: e.iid,
      title: e.title,
      author: username,
      sourceBranch: e.source_branch,
      targetBranch: e.target_branch,
      updatedAt: e.updated_at,
      url: e.web_url,
      state: parseGlabState(e.state),
      isDraft: parseGlabIsDraft(e.draft, e.work_in_progress),
      labels: parseStringArray(e.labels),
      // Diff size, CI status and commit count are not on the list payload at
      // all (GitLab REST has no dedicated endpoint for the first two, and the
      // third needs its own paginated call): left null here, and changedFiles
      // + checks are filled in, best-effort, by enrichGlabMrs below.
      additions: null,
      deletions: null,
      changedFiles: null,
      checks: null,
      reviewers: parseGlabUsernames(e.reviewers),
      assignees: parseGlabUsernames(e.assignees),
      milestone: parseGlabMilestone(e.milestone),
      mergeable: parseGlabMergeable(e.merge_status),
      commits: null,
      body: parseOptionalString(e.description),
    })
  }
  return mrs
}

// --- GitLab per-MR enrichment (changedFiles, checks) --------------------------

export type GlabMrDetail = { changedFiles: number | null; checks: ForgeCheckRollup | null }

/**
 * GitLab caps `changes_count` at 1000 and returns the literal string "1000+"
 * past it (GitLab API docs, merge requests): a capped count cannot be
 * expressed as an exact number, and reporting 1000 would claim a precision
 * the forge itself refused to give, so it degrades to null instead of a wrong
 * number.
 */
function parseGlabChangesCount(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    return null
  }
  return Number(value)
}

const GLAB_PIPELINE_PASSED = new Set(['success'])
const GLAB_PIPELINE_SKIPPED = new Set(['skipped', 'canceled', 'canceling'])
const GLAB_PIPELINE_PENDING = new Set([
  'created',
  'pending',
  'running',
  'manual',
  'scheduled',
  'waiting_for_resource',
  'preparing',
  'waiting_for_callback',
])

/**
 * GitLab's MR resource carries one pipeline (`pipeline`/`head_pipeline`), not
 * a per-job breakdown the way GitHub's statusCheckRollup does: this rolls the
 * whole pipeline's status into a single check. Reading the underlying jobs
 * would need one further `api` call per MR (`GET pipelines/:id/jobs`), which
 * the bounded per-MR budget below (see `enrichGlabMrs`) deliberately does not
 * spend, a coarser but honest rollup, not a truncation, so `truncated`
 * always stays false here. `null` pipeline (no CI ever ran on this MR) yields
 * `checks: null`, distinct from a pipeline that ran and produced a status.
 */
function parseGlabPipelineChecks(value: unknown): ForgeCheckRollup | null {
  if (value === null || typeof value !== 'object') {
    return null
  }
  const status = readRecordProp(value as Record<string, unknown>, 'status')
  if (typeof status !== 'string') {
    return null
  }
  const rollup: ForgeCheckRollup = {
    passed: 0,
    failed: 0,
    pending: 0,
    skipped: 0,
    truncated: false,
  }
  if (GLAB_PIPELINE_PASSED.has(status)) {
    rollup.passed = 1
  } else if (GLAB_PIPELINE_SKIPPED.has(status)) {
    rollup.skipped = 1
  } else if (GLAB_PIPELINE_PENDING.has(status)) {
    rollup.pending = 1
  } else {
    // 'failed' and any unrecognised status both surface as failed: an
    // unrecognised state should draw attention, not disappear silently.
    rollup.failed = 1
  }
  return rollup
}

export function parseGlabMrDetail(raw: string): GlabMrDetail | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return null
  }
  const e = data as Record<string, unknown>
  return {
    changedFiles: parseGlabChangesCount(e.changes_count),
    checks: parseGlabPipelineChecks(readRecordProp(e, 'pipeline')),
  }
}

export type CliOutcome = { kind: 'ok'; stdout: string } | { kind: 'missing' } | { kind: 'error' }

/**
 * Injectable seam for tests (mirrors forge-issues.ts's `ForgeIssuesExecFn`):
 * no test in forge-mrs.test.ts runs a real gh/glab, and none waits out a real
 * timeout: each asserts on the argv it was handed and the outcome it is
 * fed back.
 */
export type ForgeMrsExecFn = (
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
) => Promise<CliOutcome>

export type ForgeMrsOptions = {
  execFn?: ForgeMrsExecFn | undefined
  /** Test-only override of GLAB_ENRICH_CONCURRENCY; production never sets it. */
  glabEnrichConcurrency?: number | undefined
  /** Test-only override of GLAB_ENRICH_BUDGET_MS; production never sets it. */
  glabEnrichBudgetMs?: number | undefined
}

/**
 * Distinct from git.ts's tryExec: that helper collapses "binary missing" and
 * "command failed" into the same null, which is fine for its fallback-chain use
 * but loses the distinction the /api/mrs "no-cli" vs "cli-error" reason needs.
 * Runs async (unlike tryExec/git.ts) so a slow or hanging forge CLI never blocks
 * the HTTP server's event loop while a request is in flight.
 */
export function runForgeCli(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<CliOutcome> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: FORGE_MR_MAX_BUFFER_BYTES },
      (err, stdout) => {
        if (err) {
          resolve(
            (err as NodeJS.ErrnoException).code === 'ENOENT'
              ? { kind: 'missing' }
              : { kind: 'error' },
          )
          return
        }
        resolve({ kind: 'ok', stdout })
      },
    )
  })
}

const defaultExec: ForgeMrsExecFn = (cmd, args, cwd, timeoutMs) =>
  runForgeCli(cmd, args, cwd, timeoutMs)

async function enrichOneGlabMr(
  mr: ForgeMr,
  cwd: string,
  execFn: ForgeMrsExecFn,
  timeoutMs: number,
): Promise<ForgeMr> {
  const outcome = await execFn(
    'glab',
    ['api', `projects/:fullpath/merge_requests/${mr.number}`],
    cwd,
    timeoutMs,
  )
  if (outcome.kind !== 'ok') {
    // Nothing measured for this MR: it is returned as-is, changedFiles/checks
    // stay null, and it is NEVER dropped from the list (doctrine: the outer
    // MR list is never silently truncated, only individual fields degrade).
    return mr
  }
  const detail = parseGlabMrDetail(outcome.stdout)
  if (detail === null) {
    return mr
  }
  return { ...mr, changedFiles: detail.changedFiles, checks: detail.checks }
}

type EnrichBudget = { concurrency: number; budgetMs: number }

/**
 * Fills `changedFiles` and `checks` for a glab-sourced MR list, one `glab api`
 * call per MR, bounded by `budget.concurrency` workers and a global
 * `budget.budgetMs` wall-clock deadline (GLAB_ENRICH_CONCURRENCY /
 * GLAB_ENRICH_BUDGET_MS in production; overridable only from
 * ForgeMrsOptions, which only tests use). Each dispatch is timed with
 * `min(GLAB_ENRICH_CALL_TIMEOUT_MS, time left before the deadline)`, so a
 * call started near the deadline cannot itself outlive it: the phase as a
 * whole never runs meaningfully past `budget.budgetMs`. An MR whose call
 * fails, times out, or is never reached before the deadline simply keeps
 * those two fields null: it is never removed from the returned list.
 */
async function enrichGlabMrs(
  mrs: ForgeMr[],
  cwd: string,
  execFn: ForgeMrsExecFn,
  budget: EnrichBudget,
): Promise<ForgeMr[]> {
  const deadline = Date.now() + budget.budgetMs
  const results = [...mrs]
  let cursor = 0

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= mrs.length) {
        return
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        return
      }
      const mr = mrs[index]
      if (mr !== undefined) {
        const callTimeoutMs = Math.min(GLAB_ENRICH_CALL_TIMEOUT_MS, remaining)
        results[index] = await enrichOneGlabMr(mr, cwd, execFn, callTimeoutMs)
      }
    }
  }

  const workerCount = Math.min(Math.max(budget.concurrency, 1), mrs.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}

type MrPage = { mrs: ForgeMr[]; truncated: boolean }

/** One MR past the cap is what proves there are more; the extra one is never returned. */
function capMrs(all: ForgeMr[]): MrPage {
  return { mrs: all.slice(0, MR_LIST_MAX), truncated: all.length > MR_LIST_MAX }
}

type CandidateOutcome = { kind: 'ok'; value: MrPage } | { kind: 'missing' } | { kind: 'error' }

type Candidate = {
  cli: string
  run: (execFn: ForgeMrsExecFn, cwd: string) => Promise<CandidateOutcome>
  enrich?: (
    mrs: ForgeMr[],
    cwd: string,
    execFn: ForgeMrsExecFn,
    budget: EnrichBudget,
  ) => Promise<ForgeMr[]>
}

/** gh paginates internally: ask for one more than the cap and count what comes back. */
function ghMrCandidate(): Candidate {
  return {
    cli: 'gh',
    run: async (execFn, cwd) => {
      const args = ['pr', 'list', '--json', GH_JSON_FIELDS, '--limit', GH_MR_LIMIT]
      const outcome = await execFn('gh', args, cwd, EXEC_TIMEOUT_MS)
      if (outcome.kind !== 'ok') {
        return outcome
      }
      const mrs = parseGhMrList(outcome.stdout)
      return mrs === null ? { kind: 'error' } : { kind: 'ok', value: capMrs(mrs) }
    },
  }
}

/** glab cannot: GitLab clamps a page at 100, so walk pages until one comes back short. */
function glabMrCandidate(): Candidate {
  return {
    cli: 'glab',
    run: async (execFn, cwd) => {
      const all: ForgeMr[] = []
      for (let page = 1; page <= GLAB_MAX_PAGES; page += 1) {
        const paging = ['--per-page', GLAB_PER_PAGE, '--page', String(page), '--output', 'json']
        const args = ['mr', 'list', ...paging]
        const outcome = await execFn('glab', args, cwd, EXEC_TIMEOUT_MS)
        if (outcome.kind !== 'ok') {
          return outcome
        }
        const batch = parseGlabMrList(outcome.stdout)
        if (batch === null) {
          return { kind: 'error' }
        }
        all.push(...batch)
        if (batch.length < GLAB_PAGE_SIZE) {
          // A short page is the end of the list, but the pages before it can
          // already have overshot the cap, so the cap is applied HERE too.
          return { kind: 'ok', value: capMrs(all) }
        }
        if (all.length > MR_LIST_MAX) {
          break
        }
      }
      return { kind: 'ok', value: capMrs(all) }
    },
    enrich: enrichGlabMrs,
  }
}

export async function listOpenMrs(
  cwd: string,
  options: ForgeMrsOptions = {},
): Promise<ForgeMrsResult> {
  const execFn = options.execFn ?? defaultExec
  const hasRemote = tryGit(['remote', 'get-url', 'origin'], cwd) !== null
  if (!hasRemote) {
    return { available: false, reason: 'no-remote' }
  }

  const hint = detectForgeHint(cwd)
  const candidates: Candidate[] = []
  if (hint !== 'gitlab') {
    candidates.push(ghMrCandidate())
  }
  if (hint !== 'github') {
    candidates.push(glabMrCandidate())
  }

  let sawCliError = false
  for (const candidate of candidates) {
    const outcome = await candidate.run(execFn, cwd)
    if (outcome.kind === 'missing') {
      continue
    }
    if (outcome.kind === 'error') {
      sawCliError = true
      continue
    }
    const budget: EnrichBudget = {
      concurrency: options.glabEnrichConcurrency ?? GLAB_ENRICH_CONCURRENCY,
      budgetMs: options.glabEnrichBudgetMs ?? GLAB_ENRICH_BUDGET_MS,
    }
    const mrs = candidate.enrich
      ? await candidate.enrich(outcome.value.mrs, cwd, execFn, budget)
      : outcome.value.mrs
    return { available: true, mrs, truncated: outcome.value.truncated }
  }
  return { available: false, reason: sawCliError ? 'cli-error' : 'no-cli' }
}
