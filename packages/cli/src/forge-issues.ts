// Forge issues, read AND write (T2.1, decision D5). Every call goes through
// the forge CLI the user already has — `gh` or `glab` — using their porcelain
// when it covers the operation and their `api` passthrough when it does not.
// NO TOKEN IS EVER READ, WRITTEN OR STORED here: the authentication is
// whatever `gh auth` / `glab auth` already set up for the user, which is the
// whole point of D5.
//
// Deliberately a near-copy of forge-mrs.ts rather than a factorisation of the
// two: an abstraction written before the parent/child hierarchy (T2.2) and the
// offline mode (T2.7) exist would be an abstraction written against the wrong
// constraints. The duplication is assumed. Payload parsing and argument
// hardening live next door in forge-issues-parse.ts.
//
// Porcelain vs `api`, operation by operation, and the gh/glab asymmetries:
//
// | operation     | gh (2.46.0)                  | glab (1.53.0)                    |
// |---------------|------------------------------|----------------------------------|
// | listIssues    | `issue list --limit N --json`| `issue list --page/--per-page`   |
// | getIssue      | `issue view N --json …`      | `issue view N --output json`     |
// | createIssue   | `issue create --title=…`     | `… --no-editor --yes`            |
// | commentIssue  | `issue comment N --body=…`   | `issue note N --message=…`       |
// | closeIssue    | `issue close N`              | `issue close N`                  |
// | setLabels     | `api …/labels -X PUT`        | `api …/issues/N -X PUT`          |
//
// The asymmetries are documented, not smoothed over (D8):
//   - a comment is a `comment` on GitHub and a `note` on GitLab, and its text
//     rides `--body` there, `--message` here;
//   - the state filter is `--state open|closed|all` on gh and a pair of
//     boolean flags (`--closed`, `--all`) on glab;
//   - gh paginates internally behind one `--limit`, glab exposes GitLab's
//     `--page` / `--per-page` and its API clamps a page at 100 (see below);
//   - `glab issue create` opens an editor and asks for confirmation unless
//     told not to (`--no-editor`, `--yes`); `gh issue create` does neither;
//   - GitHub returns labels as objects (`{name}`), GitLab as plain strings;
//   - GitHub says `OPEN`/`CLOSED`, GitLab says `opened`/`closed`;
//   - `setLabels` is the one operation NO porcelain covers: `gh issue edit`
//     and `glab issue update` only ADD or REMOVE labels, neither REPLACES the
//     set. So both forges go through `api` — GitHub with an array
//     (`labels[]=…`), GitLab with the comma-separated string its REST contract
//     mandates.

import { execFile, type ExecException } from 'node:child_process'
import type { TaskReason } from './contract.js'
import {
  extractIssueUrl,
  isIssueNumber,
  oversizedArg,
  parseGhIssue,
  parseGhIssueList,
  parseGlabIssue,
  parseGlabIssueList,
  sanitizeIssueBody,
  sanitizeIssueLabels,
  sanitizeIssueTitle,
  type ForgeIssue,
  type ForgeIssueState,
} from './forge-issues-parse.js'
import { detectForgeHint, subprocessEnv, tryGit } from './git.js'
import { taskReason } from './tasks-store.js'

export type { ForgeIssue, ForgeIssueState } from './forge-issues-parse.js'

/** Same budget as forge-mrs: one forge call must never hold the event loop for long. */
export const FORGE_ISSUE_TIMEOUT_MS = 8000
/** Bound for a CLI error message surfaced as an unavailability `detail`. */
const FORGE_ERROR_MAX = 500

/**
 * Explicit, and dimensioned rather than inherited. Node's default `maxBuffer`
 * is 1 MiB, which one `issue list` blows straight through as soon as the
 * issues carry bodies (201 issues × a 60 000-character description is already
 * ~12 MiB of JSON) — and the overflow arrives as an opaque failure with
 * nothing read at all. 64 MiB, the same budget `git()` uses in git.ts, leaves
 * room for multi-byte descriptions; past it the read degrades with a message
 * that names the buffer instead of a bare exit code.
 */
export const FORGE_MAX_BUFFER_BYTES = 64 * 1024 * 1024

/**
 * Hard cap on one `listIssues` answer. Both porcelains stop at 30 by default
 * (gh `--limit`, glab `--per-page`), which is exactly the SILENT truncation
 * this cap replaces: the size is now asked for explicitly, and whatever the
 * cap leaves out is reported as `truncated: true`, never dropped in silence.
 */
export const ISSUE_LIST_MAX = 200
/**
 * GitLab's REST API clamps `per_page` at 100 whatever is asked for, so glab
 * cannot answer "give me 201" in one go: it pages. gh has no `--page` at all
 * and paginates internally behind `--limit`, so it stays a single call.
 */
const GLAB_PAGE_SIZE = 100
const GLAB_MAX_PAGES = Math.ceil((ISSUE_LIST_MAX + 1) / GLAB_PAGE_SIZE)
/** Pre-rendered argv values: the argv is data, and building it must not read as arithmetic. */
const GH_LIST_LIMIT = String(ISSUE_LIST_MAX + 1)
const GLAB_PER_PAGE = String(GLAB_PAGE_SIZE)

const GH_ISSUE_JSON_FIELDS = 'number,title,body,state,labels,author,createdAt,updatedAt,url'
const UNREADABLE = 'unreadable output'

export type ForgeCli = 'gh' | 'glab'

/**
 * DIVERGES from `ForgeMrsResult` (`forge-mrs.ts:14`) by one member:
 * `invalid-input`. The three others mean exactly what they mean there —
 * `no-remote`, `no-cli`, `cli-error` — and the web keeps mapping them the same
 * way (`MrSidebar.vue:24-26`).
 *
 * `invalid-input` exists because this module WRITES: an issue number that is
 * not a positive integer, a title that sanitises to nothing, a label no forge
 * could express, an argument the kernel would refuse are all decided HERE,
 * before any binary is launched. Calling them `cli-error` would claim the forge
 * is broken (and D2 would then journal `forge_unreachable`) when nothing was
 * ever asked of it — a degradation that lies is worse than one more member in a
 * union. `forgeIssueReason` maps it to no code at all: the message alone.
 */
export type ForgeIssueReason = 'no-remote' | 'no-cli' | 'cli-error' | 'invalid-input'

/**
 * Same shape as the merge-request unavailability plus one OPTIONAL field:
 * `detail`, the failing CLI's own words (or, for `invalid-input`, ours). It is
 * added to the code, never a replacement for it (invariant 2) — a reason with
 * nothing to add simply carries none, so a reader that only knows `reason`
 * keeps working unchanged.
 */
export type ForgeUnavailable = { available: false; reason: ForgeIssueReason; detail?: string }

/**
 * `truncated` is never optional: a caller cannot hold a capped list without
 * having been handed the fact that it is capped (invariant 2). It is `true`
 * only when the forge really has more than ISSUE_LIST_MAX issues in the
 * requested state.
 */
export type ForgeIssuesResult =
  { available: true; issues: ForgeIssue[]; truncated: boolean } | ForgeUnavailable
export type ForgeIssueResult = { available: true; issue: ForgeIssue } | ForgeUnavailable
/** createIssue: both porcelains print the created issue's URL, but neither promises to. */
export type ForgeIssueRefResult = { available: true; url: string | null } | ForgeUnavailable
export type ForgeWriteResult = { available: true } | ForgeUnavailable

/**
 * `invalid` is NOT a failure of the CLI: it says the call was refused before
 * anything was launched because the argv itself is impossible (see
 * MAX_ARG_BYTES). It is kept apart from `error` so the reason stays honest —
 * `invalid-input`, not `cli-error` — and so the ladder does not try the other
 * forge with the very same argv it would refuse too.
 */
export type ForgeCliOutcome =
  | { kind: 'ok'; stdout: string }
  | { kind: 'missing' }
  | { kind: 'error'; message: string }
  | { kind: 'invalid'; message: string }

/**
 * Signature every forge call is injected through in tests: no test ever runs a
 * real gh/glab and no test ever touches the network — it asserts on the argv
 * it was handed. Named `execFn` like every other seam in the repo (`ProbeExecFn`
 * in git.ts, `execFn` in prep/preview).
 */
export type ForgeIssuesExecFn = (
  cli: ForgeCli,
  args: string[],
  cwd: string,
) => Promise<ForgeCliOutcome>

export type ForgeIssuesOptions = {
  cwd: string
  execFn?: ForgeIssuesExecFn | undefined
}

function formatBudget(ms: number): string {
  return ms >= 1000 && ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`
}

/**
 * Why the CLI failed, IN ITS OWN WORDS — and never the argv. `err.message` of
 * a failed execFile is `Command failed: <the whole command line>`, which makes
 * a timeout indistinguishable from a bad exit code and echoes back the very
 * arguments the caller already knows. Each cause therefore gets its own
 * sentence, and only stderr is quoted verbatim.
 */
function failureMessage(err: ExecException, stderr: string, timeoutMs: number): string {
  // execFile kills the child itself when `timeout` elapses: `killed` is true
  // only in that case, so this is the "binary that never gives back the hand".
  if (err.killed === true) {
    return `timed out after ${formatBudget(timeoutMs)}`
  }
  if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return `output exceeded the ${FORGE_MAX_BUFFER_BYTES / (1024 * 1024)} MiB buffer`
  }
  const said = stderr.trim()
  if (said) {
    return said.slice(0, FORGE_ERROR_MAX)
  }
  if (typeof err.code === 'number') {
    return `exited with code ${err.code}`
  }
  if (err.signal) {
    return `killed by ${err.signal}`
  }
  return typeof err.code === 'string' ? err.code : 'failed without a message'
}

/**
 * Distinct from git.ts's tryExec, which collapses "binary missing" and
 * "command failed" into the same null: the caller here has to tell `no-cli`
 * from `cli-error` (invariant 2, non-silence of degradations). Async — like
 * forge-mrs's namesake and unlike tryExec — so a slow or hanging forge CLI
 * never blocks the local server's event loop while a request is in flight.
 * argv only, never a shell string: no host-side interpolation, ever.
 *
 * It NEVER throws, not even synchronously: `execFile` itself raises before any
 * child exists when the argv exceeds what the kernel accepts, and a promise
 * executor turns that throw into a rejection the callers are not allowed to
 * see. Two layers answer it, and BOTH answer `invalid` rather than `error` —
 * the forge was never contacted, so this is our input, not its health:
 *   1. an argument past MAX_ARG_BYTES is refused HERE, before any spawn, with
 *      the size it reached;
 *   2. the E2BIG the kernel can still raise (the argv total, the environment)
 *      is caught as the net under it.
 */
export function runForgeCli(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number = FORGE_ISSUE_TIMEOUT_MS,
): Promise<ForgeCliOutcome> {
  const oversized = oversizedArg(args)
  if (oversized) {
    return Promise.resolve({ kind: 'invalid', message: oversized })
  }
  return new Promise((resolve) => {
    try {
      execFile(
        cmd,
        args,
        // GIT_TERMINAL_PROMPT=0: a forge CLI that decides to ask for credentials
        // must fail fast with a readable error, not hang until the timeout.
        {
          cwd,
          encoding: 'utf8',
          timeout: timeoutMs,
          maxBuffer: FORGE_MAX_BUFFER_BYTES,
          env: { ...subprocessEnv(), GIT_TERMINAL_PROMPT: '0' },
        },
        (err, stdout, stderr) => {
          if (err) {
            resolve(
              err.code === 'ENOENT'
                ? { kind: 'missing' }
                : { kind: 'error', message: failureMessage(err, stderr, timeoutMs) },
            )
            return
          }
          resolve({ kind: 'ok', stdout })
        },
      )
    } catch (err) {
      // ENOENT can only come back asynchronously, but keep the mapping honest
      // whichever side of the spawn raises it.
      resolve(spawnFailure((err as NodeJS.ErrnoException).code))
    }
  })
}

/**
 * E2BIG is `invalid`, not `error`: nothing left this machine, and retrying —
 * on this forge or the other — hits the same wall until the INPUT shrinks.
 * Any other spawn refusal is a genuine failure of the binary.
 */
function spawnFailure(code: string | undefined): ForgeCliOutcome {
  if (code === 'ENOENT') {
    return { kind: 'missing' }
  }
  return code === 'E2BIG'
    ? { kind: 'invalid', message: 'argument list too long for the kernel (E2BIG)' }
    : { kind: 'error', message: `could not be launched${code ? ` (${code})` : ''}` }
}

const defaultExec: ForgeIssuesExecFn = (cli, args, cwd) => runForgeCli(cli, args, cwd)

// --- Probe order and outcome -------------------------------------------------

type CandidateOutcome<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'missing' }
  | { kind: 'error'; message: string }
  | { kind: 'invalid'; message: string }

/** One forge's way of answering an operation: one CLI round trip, or several for a paged read. */
type Candidate<T> = {
  cli: ForgeCli
  run: (execFn: ForgeIssuesExecFn, cwd: string) => Promise<CandidateOutcome<T>>
}

/** The common case: one call, one parse, `null` from the parser meaning "unreadable". */
function oneCall<T>(
  cli: ForgeCli,
  args: string[],
  parse: (stdout: string) => T | null,
): Candidate<T> {
  return {
    cli,
    run: async (execFn, cwd) => {
      const outcome = await execFn(cli, args, cwd)
      if (outcome.kind !== 'ok') {
        return outcome
      }
      const value = parse(outcome.stdout)
      return value === null ? { kind: 'error', message: UNREADABLE } : { kind: 'ok', value }
    },
  }
}

type Attempt<T> = { available: true; value: T } | ForgeUnavailable

/**
 * Reads may walk the whole ladder; WRITES may not.
 *
 * A read that fails on `gh` costs nothing to retry on `glab`. A write that
 * fails on `gh` may ALREADY HAVE LANDED — the CLI can exit non-zero after the
 * issue was created, or the failure can be a timeout on a request the forge
 * accepted — so replaying it on the second CLI risks a duplicate issue or a
 * duplicate comment. The write ladder therefore stops at the first candidate
 * that actually RAN, whatever it answered, and reports honestly.
 *
 * A `missing` candidate is not a candidate that ran: nothing was attempted, so
 * moving to the next binary is not a replay and both ladders do it.
 */
type LadderMode = 'read' | 'write'

/**
 * The whole degradation ladder, in one place: no remote → no probe at all;
 * an argv the kernel would refuse → `invalid-input`, without launching
 * anything; every candidate missing → `no-cli`; anything that ran and failed
 * (bad exit, unreadable output) → `cli-error`, carrying the CLI's own words.
 */
async function attempt<T>(
  cwd: string,
  execFn: ForgeIssuesExecFn,
  build: () => Candidate<T>[],
  mode: LadderMode,
): Promise<Attempt<T>> {
  if (tryGit(['remote', 'get-url', 'origin'], cwd) === null) {
    return { available: false, reason: 'no-remote' }
  }
  let detail: string | null = null
  for (const candidate of build()) {
    const outcome = await candidate.run(execFn, cwd)
    if (outcome.kind === 'missing') {
      continue
    }
    if (outcome.kind === 'invalid') {
      // Refused before anything was launched, and the other forge would be
      // handed the very same oversized argv: stop, and say it is the input.
      return { available: false, reason: 'invalid-input', detail: outcome.message }
    }
    if (outcome.kind === 'error') {
      detail = `${candidate.cli}: ${outcome.message}`
      if (mode === 'write') {
        // It ran. Whether the write landed is unknowable from here, so the
        // answer is an honest failure — never the same write again.
        break
      }
      continue
    }
    return { available: true, value: outcome.value }
  }
  return detail === null
    ? { available: false, reason: 'no-cli' }
    : { available: false, reason: 'cli-error', detail }
}

/**
 * detectForgeHint skips the obviously wrong CLI; an unrecognized (self-hosted)
 * remote probes both, gh first then glab — same rule as forge-mrs.listOpenMrs.
 */
function candidatesFor<T>(cwd: string, gh: Candidate<T>, glab: Candidate<T>): Candidate<T>[] {
  const hint = detectForgeHint(cwd)
  const candidates: Candidate<T>[] = []
  if (hint !== 'gitlab') {
    candidates.push(gh)
  }
  if (hint !== 'github') {
    candidates.push(glab)
  }
  return candidates
}

/**
 * One operation on whichever forge answers: the two candidates, the ladder the
 * mode allows, one typed attempt. The candidate list stays behind a closure so
 * detectForgeHint only runs once the repo is known to have a remote.
 */
function ask<T>(
  opts: ForgeIssuesOptions,
  mode: LadderMode,
  gh: Candidate<T>,
  glab: Candidate<T>,
): Promise<Attempt<T>> {
  return attempt(
    opts.cwd,
    opts.execFn ?? defaultExec,
    () => candidatesFor(opts.cwd, gh, glab),
    mode,
  )
}

/** Refusal decided locally, before any probe: no forge was asked anything. */
function refuse(detail: string): ForgeUnavailable {
  return { available: false, reason: 'invalid-input', detail }
}

/**
 * Bridges an unavailability to D2's vocabulary (T1.1). The code is ADDED to
 * the readable message, never substituted for it: `detail` carries the reason
 * slug and the CLI's own words, verbatim.
 *
 * `invalid-input` maps to NO code and returns null: the call never reached a
 * forge, so claiming `forge_unreachable` would journal a forge outage that did
 * not happen. The caller keeps the message and states it without a code.
 */
export function forgeIssueReason(result: ForgeUnavailable): TaskReason | null {
  if (result.reason === 'invalid-input') {
    return null
  }
  return taskReason(
    'forge_unreachable',
    result.detail ? `${result.reason}: ${result.detail}` : result.reason,
  )
}

// --- Operations --------------------------------------------------------------

/** Both create porcelains print the new issue's URL; neither promises to. */
const issueUrlFrom = (stdout: string) => ({ url: extractIssueUrl(stdout) })
/** A write has nothing to parse: it either ran or it did not. */
const done = () => true as const

export type ForgeIssueStateFilter = ForgeIssueState | 'all'

/** gh takes `--state <value>`; glab has no such flag, only two boolean shortcuts. */
const GLAB_STATE_FLAGS: Record<ForgeIssueStateFilter, string[]> = {
  open: [],
  closed: ['--closed'],
  all: ['--all'],
}

type IssuePage = { issues: ForgeIssue[]; truncated: boolean }

/** One issue past the cap is what proves there are more; the extra one is never returned. */
function capPage(all: ForgeIssue[]): IssuePage {
  return { issues: all.slice(0, ISSUE_LIST_MAX), truncated: all.length > ISSUE_LIST_MAX }
}

/** gh paginates internally: ask for one more than the cap and count what comes back. */
function ghListCandidate(state: ForgeIssueStateFilter): Candidate<IssuePage> {
  const paging = ['--limit', GH_LIST_LIMIT, '--json', GH_ISSUE_JSON_FIELDS]
  const args = ['issue', 'list', '--state', state, ...paging]
  return oneCall('gh', args, (stdout) => {
    const issues = parseGhIssueList(stdout)
    return issues === null ? null : capPage(issues)
  })
}

/** glab cannot: GitLab clamps a page at 100, so walk pages until one comes back short. */
function glabListCandidate(state: ForgeIssueStateFilter): Candidate<IssuePage> {
  return {
    cli: 'glab',
    run: async (execFn, cwd) => {
      const all: ForgeIssue[] = []
      for (let page = 1; page <= GLAB_MAX_PAGES; page += 1) {
        const paging = ['--per-page', GLAB_PER_PAGE, '--page', String(page), '--output', 'json']
        const args = ['issue', 'list', ...GLAB_STATE_FLAGS[state], ...paging]
        const outcome = await execFn('glab', args, cwd)
        if (outcome.kind !== 'ok') {
          return outcome
        }
        const batch = parseGlabIssueList(outcome.stdout)
        if (batch === null) {
          return { kind: 'error', message: UNREADABLE }
        }
        all.push(...batch)
        if (batch.length < GLAB_PAGE_SIZE) {
          // A short page is the end of the list — but the pages before it can
          // already have overshot the cap (100 + 100 + 50 = 250), so the cap is
          // applied HERE too. Skipping it returned 250 issues with
          // truncated:false where gh answered 200/true on the same repo.
          return { kind: 'ok', value: capPage(all) }
        }
        if (all.length > ISSUE_LIST_MAX) {
          break
        }
      }
      return { kind: 'ok', value: capPage(all) }
    },
  }
}

export async function listIssues(
  opts: ForgeIssuesOptions & { state?: ForgeIssueStateFilter | undefined },
): Promise<ForgeIssuesResult> {
  const state = opts.state ?? 'open'
  const result = await ask(opts, 'read', ghListCandidate(state), glabListCandidate(state))
  return result.available
    ? { available: true, issues: result.value.issues, truncated: result.value.truncated }
    : result
}

export async function getIssue(
  opts: ForgeIssuesOptions & { number: number },
): Promise<ForgeIssueResult> {
  if (!isIssueNumber(opts.number)) {
    return refuse(`invalid issue number: ${String(opts.number)}`)
  }
  const id = String(opts.number)
  const result = await ask(
    opts,
    'read',
    oneCall('gh', ['issue', 'view', id, '--json', GH_ISSUE_JSON_FIELDS], parseGhIssue),
    oneCall('glab', ['issue', 'view', id, '--output', 'json'], parseGlabIssue),
  )
  return result.available ? { available: true, issue: result.value } : result
}

export async function createIssue(
  opts: ForgeIssuesOptions & {
    title: string
    body?: string | undefined
    labels?: string[] | undefined
  },
): Promise<ForgeIssueRefResult> {
  const title = sanitizeIssueTitle(opts.title)
  if (!title) {
    // An empty --title= makes both CLIs open an interactive prompt: refused
    // here rather than left to hang until the 8s timeout.
    return refuse('issue title is empty after sanitisation')
  }
  const body = sanitizeIssueBody(opts.body)
  const labels = sanitizeIssueLabels(opts.labels)
  if (!labels.ok) {
    return refuse(labels.detail)
  }
  const flags = labels.labels.map((label) => `--label=${label}`)
  const result = await ask(
    opts,
    'write',
    oneCall(
      'gh',
      ['issue', 'create', `--title=${title}`, `--body=${body}`, ...flags],
      issueUrlFrom,
    ),
    oneCall(
      'glab',
      [
        'issue',
        'create',
        `--title=${title}`,
        `--description=${body}`,
        ...flags,
        // glab, unlike gh, would open $EDITOR for the description and then ask
        // for confirmation. Both are fatal for a non-interactive call: an
        // editor on a pipe hangs until the timeout. --no-editor and --yes are
        // the flags that forbid it (glab 1.53.0).
        '--no-editor',
        '--yes',
      ],
      issueUrlFrom,
    ),
  )
  return result.available ? { available: true, url: result.value.url } : result
}

export async function commentIssue(
  opts: ForgeIssuesOptions & { number: number; body: string },
): Promise<ForgeWriteResult> {
  if (!isIssueNumber(opts.number)) {
    return refuse(`invalid issue number: ${String(opts.number)}`)
  }
  const body = sanitizeIssueBody(opts.body)
  // Blank, not just empty: a comment made of spaces says nothing, and both
  // porcelains would fall back to an interactive prompt for it. The body sent
  // is the sanitized one, untrimmed — leading spaces can be markdown.
  if (!body.trim()) {
    return refuse('comment body is empty after sanitisation')
  }
  const id = String(opts.number)
  const result = await ask(
    opts,
    'write',
    oneCall('gh', ['issue', 'comment', id, `--body=${body}`], done),
    // GitHub calls it a comment, GitLab a note — and the text rides --body
    // there, --message here. Documented, not smoothed over.
    oneCall('glab', ['issue', 'note', id, `--message=${body}`], done),
  )
  return result.available ? { available: true } : result
}

export async function closeIssue(
  opts: ForgeIssuesOptions & { number: number },
): Promise<ForgeWriteResult> {
  if (!isIssueNumber(opts.number)) {
    return refuse(`invalid issue number: ${String(opts.number)}`)
  }
  const id = String(opts.number)
  const result = await ask(
    opts,
    'write',
    oneCall('gh', ['issue', 'close', id], done),
    oneCall('glab', ['issue', 'close', id], done),
  )
  return result.available ? { available: true } : result
}

/**
 * The one operation no porcelain covers (D5's "api for the rest"):
 * `gh issue edit` and `glab issue update` only add or remove labels, neither
 * REPLACES the set. GitHub's REST takes an array and answers an empty set with
 * DELETE; GitLab's takes the comma-separated string and clears on ''.
 */
export async function setLabels(
  opts: ForgeIssuesOptions & { number: number; labels: string[] },
): Promise<ForgeWriteResult> {
  if (!isIssueNumber(opts.number)) {
    return refuse(`invalid issue number: ${String(opts.number)}`)
  }
  const labels = sanitizeIssueLabels(opts.labels)
  if (!labels.ok) {
    return refuse(labels.detail)
  }
  const id = String(opts.number)
  const ghPath = `repos/{owner}/{repo}/issues/${id}/labels`
  const ghArgs =
    labels.labels.length === 0
      ? ['api', ghPath, '--method', 'DELETE']
      : [
          'api',
          ghPath,
          '--method',
          'PUT',
          ...labels.labels.map((label) => `--raw-field=labels[]=${label}`),
        ]
  const glabArgs = [
    'api',
    `projects/:fullpath/issues/${id}`,
    '--method',
    'PUT',
    `--raw-field=labels=${labels.labels.join(',')}`,
  ]
  const result = await ask(
    opts,
    'write',
    oneCall('gh', ghArgs, done),
    oneCall('glab', glabArgs, done),
  )
  return result.available ? { available: true } : result
}
