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
// | operation        | gh (2.46.0)                    | glab (1.53.0)                       |
// |------------------|---------------------------------|--------------------------------------|
// | listIssues       | `issue list --limit N --json`  | `issue list --page/--per-page`      |
// | getIssue         | `issue view N --json …`        | `issue view N --output json`        |
// | createIssue      | `issue create --title=…`       | `… --no-editor --yes`               |
// | commentIssue     | `issue comment N --body=…`     | `issue note N --message=…`          |
// | listIssueComments| `issue view N --json comments` | `issue view N --comments -F json`   |
// | closeIssue       | `issue close N`                | `issue close N`                     |
// | setLabels        | `api …/labels -X PUT`          | `api …/issues/N -X PUT`             |
// | listLabels       | `label list --json name`       | `label list --page/--per-page`      |
// | createLabel      | `label create <name>`          | `label create --name=<name>`        |
// | linkChildIssue   | `api …/sub_issues -X POST`     | `api graphql` (workItemUpdate)      |
// | unlinkChildIssue | `api …/sub_issue -X DELETE`    | `api graphql` (workItemUpdate)      |
// | listChildIssues  | `api …/sub_issues` (paged)     | `api graphql` (hierarchyWidget)     |
//
// The hierarchy trio (T2.2, D8) is the widest asymmetry in the file: GitHub's
// sub-issues are REST, GitLab's are the GraphQL work-item hierarchy widget —
// two different API MODELS, not two dialects of one. GitHub's write body
// wants the child's internal database `id`, never its repo-scoped `number`
// (the parent's `number` still rides the URL); GitLab's mutation wants BOTH
// ids as GraphQL global ids (`gid://gitlab/Issue/<id>`), resolved first
// through the REST `id` field of `projects/:fullpath/issues/<iid>` — one more
// round trip than GitHub's link/unlink pay, since GitLab's write is GraphQL
// and cannot resolve a project-scoped `iid` itself the way a REST path
// placeholder does. Neither forge's write ladder retries the OTHER forge on
// failure (see LadderMode below) — that already held before this ticket.
//
// The asymmetries are documented, not smoothed over (D8):
//   - a comment is a `comment` on GitHub and a `note` on GitLab, and its text
//     rides `--body` there, `--message` here;
//   - reading those comments BACK (T3.5) is `--json comments` on gh, which
//     answers `{comments:[…]}` and pages internally, against
//     `--comments --output json` on glab, which answers the issue payload plus
//     a capitalised `Notes` array — system notes included — and pages with
//     GitLab's own `--page`/`--per-page`;
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
import { forgeCandidates, forgeReasonDetail } from './degraded-mode.js'
import {
  extractIssueUrl,
  ghIssueDatabaseId,
  ghIssueNumberFromRest,
  GLAB_HIERARCHY_CHILDREN_QUERY,
  GLAB_HIERARCHY_HAS_CHILDREN_QUERY,
  GLAB_HIERARCHY_PARENT_QUERY,
  glabIssueDatabaseId,
  glabIssueRestRef,
  isIssueNumber,
  oversizedArg,
  parseGhIssue,
  parseGhIssueComments,
  parseGhIssueList,
  parseGhSubIssueList,
  parseGlabHierarchyChildren,
  parseGlabHierarchyHasChildren,
  parseGlabHierarchyMutation,
  parseGlabHierarchyParent,
  parseGlabIssue,
  parseGlabIssueList,
  parseGlabIssueNotes,
  parseLabelNames,
  sanitizeIssueBody,
  sanitizeIssueLabels,
  sanitizeIssueTitle,
  type ForgeIssue,
  type ForgeIssueComment,
  type ForgeIssueState,
} from './forge-issues-parse.js'
import { detectForgeHint, subprocessEnv, tryGit } from './git.js'
import { taskReason } from './tasks-store.js'

export type { ForgeIssue, ForgeIssueComment, ForgeIssueState } from './forge-issues-parse.js'

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
/**
 * Hard cap on one `listIssueComments` answer (T3.5). Same size and the same
 * reason as `ISSUE_LIST_MAX`, but the CONSEQUENCE of hitting it differs and is
 * the caller's to handle: this read exists to prove a marker ABSENT before
 * writing, and a capped list can only prove it absent from the part that was
 * read. `truncated: true` is therefore not a cosmetic detail here — see
 * `publishTaskRecap` (task-recap-publish.ts), which refuses to write on it.
 *
 * It bites on REAL comments only: `capComments` filters GitLab's system notes
 * out BEFORE it counts, so a ticket cannot be pushed past the cap by label
 * churn alone. See `commentsOnly` for why that matters more here than
 * anywhere else — the refusal this cap produces never lifts.
 */
export const ISSUE_COMMENT_LIST_MAX = 200
const GLAB_MAX_COMMENT_PAGES = Math.ceil((ISSUE_COMMENT_LIST_MAX + 1) / GLAB_PAGE_SIZE)
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
 *
 * `unsupported` is T2.2's own addition (D8 decision 2): a forge or edition
 * that was actually asked, and answered that it structurally cannot link a
 * parent to a child — GitLab's GraphQL schema refusing `hierarchyWidget`
 * itself, not a business rejection of one particular call. It is kept apart
 * from `cli-error` because it means the OPPOSITE thing for a retry: a
 * `cli-error` may be transient (a timeout, a bad exit), `unsupported` never
 * is on the SAME edition. This is a member of a LOCAL union, never of the
 * `REASON_CODES` table in `packages/contract/src/reasons.ts` — that enum
 * qualifies the arrest of a task, and the hierarchy arrests none (DP5); see
 * `forgeIssueReason` below, which keeps mapping it to no D2 code at all.
 */
export type ForgeIssueReason =
  'no-remote' | 'no-cli' | 'cli-error' | 'invalid-input' | 'unsupported'

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
/**
 * `answeredBy` names WHICH forge actually produced this issue, and it is what
 * makes a read-recompose-write triple safe on a repository whose remote names
 * neither forge (T3.7 MAJEUR 2): `setLabels` REPLACES an issue's whole label
 * set, so a set read from GitLab and re-emitted onto GitHub is not a
 * degradation, it is a destruction of whatever GitHub's copy of that issue
 * carried. A caller that reads then writes threads this straight into the
 * write's `pin` — see `poseCycleLabel` in task-labels.ts, exactly as
 * `linkChildIssue` here threads its guard's own pin.
 */
export type ForgeIssueResult =
  { available: true; issue: ForgeIssue; answeredBy?: ForgeCli | undefined } | ForgeUnavailable

/**
 * A call bound to the ONE forge a preceding read actually answered from, or
 * `null`/absent for a call that stands on its own and may pick for itself.
 * Threaded into `askPinned`, which narrows the ladder to that single binary.
 */
export type ForgePinned = { pin?: ForgeCli | null | undefined }

/**
 * `truncated` is never optional here either, and for a sharper reason than on
 * `ForgeIssuesResult`: the one caller of this read uses it to decide whether a
 * marker is ABSENT, and "absent from the 200 comments I could read" is not
 * "absent". A reader that ignores this flag posts duplicates.
 */
export type ForgeIssueCommentsResult =
  { available: true; comments: ForgeIssueComment[]; truncated: boolean } | ForgeUnavailable
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
  /** T2.2 only: a candidate that RAN and answered "this schema cannot do
   * that" (see `parseGlabHierarchyMutation`/`parseGlabHierarchyChildren`).
   * Distinct from `error`: nothing was mutated (a GraphQL query that never
   * validates never reaches a resolver), so, unlike a write `error`, the
   * ladder is safe to keep walking on this outcome even in write mode. */
  | { kind: 'unsupported'; message: string }
  /**
   * T2.2's hierarchy writes are the first candidates in this file that need
   * a READ (resolving an id) before the actual WRITE — and a failure of that
   * read must NOT trip the "a write never replays" guard below: nothing was
   * written yet, so trying the other forge is exactly as safe as it is for
   * any other read failure. `blocked` names that: a candidate that could not
   * even ATTEMPT its write, as opposed to `error`, which from here on means
   * the write itself was attempted and its outcome is unknown.
   */
  | { kind: 'blocked'; message: string }

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

/**
 * `answeredBy` names which CLI actually produced the value — `undefined`
 * when the answer came from a cache hit rather than a live probe (see
 * `realParentOf`/`realHasChildren`). MAJEUR 3: `guardOneLevel` uses this to
 * PIN a subsequent write to the same forge the guard actually read its
 * state from — a guard answered by `gh` proves nothing about GitLab's
 * state, so a write is never allowed to fall through to `glab` on that
 * guard's authority.
 */
type Attempt<T> = ({ available: true; value: T } & { answeredBy?: ForgeCli }) | ForgeUnavailable

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
    if (outcome.kind === 'blocked') {
      // The READ that a write needs before it can run failed: nothing was
      // ever written, so — unlike `error` below — this never trips the
      // write-mode "stop, do not replay" rule (MAJEUR 4).
      detail = `${candidate.cli}: ${outcome.message}`
      continue
    }
    if (outcome.kind === 'unsupported') {
      // A candidate that RAN and got a definitive schema-level "no" — today
      // only GitLab's hierarchy mutation/query produce this, and it is
      // always the LAST candidate the ladder tries (`candidatesFor` never
      // puts anything after glab), so there is never a further candidate
      // left to fall through to. Stopping here rather than folding it into
      // `detail` keeps the name distinct from `cli-error` on the way out.
      return {
        available: false,
        reason: 'unsupported',
        detail: `${candidate.cli}: ${outcome.message}`,
      }
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
    return { available: true, value: outcome.value, answeredBy: candidate.cli }
  }
  return detail === null
    ? { available: false, reason: 'no-cli' }
    : { available: false, reason: 'cli-error', detail }
}

/**
 * detectForgeHint skips the obviously wrong CLI; an unrecognized (self-hosted)
 * remote probes both, gh first then glab — same rule as forge-mrs.listOpenMrs.
 *
 * `pin`, when given (MAJEUR 3), narrows the ladder to that ONE cli
 * regardless of `hint`: used to keep a guarded write from landing on a
 * forge the guard never actually read.
 */
function candidatesFor<T>(
  cwd: string,
  gh: Candidate<T>,
  glab: Candidate<T>,
  pin?: ForgeCli,
): Candidate<T>[] {
  // The hint rule itself lives in degraded-mode.ts (T2.7 round-2, majeur 3):
  // the workspace header announces availability by asking which CLIs could
  // serve THIS repo, and two copies of that rule drifting apart is exactly
  // how the header came to promise a forge the ladder below never launches.
  const byCli: Record<ForgeCli, Candidate<T>> = { gh, glab }
  return forgeCandidates(detectForgeHint(cwd))
    .filter((cli) => pin === undefined || cli === pin)
    .map((cli) => byCli[cli])
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

/**
 * Same ladder as `ask`, but PINNED to one forge: `pin` narrows the candidate
 * list to that single binary, so a call cannot fall through to a forge whose
 * state nothing verified.
 *
 * Two callers, one rule. `linkChildIssue`'s write pins to the forge
 * `guardOneLevel` actually read from (T2.2 MAJEUR 3). `getIssue` →
 * `listLabels`/`createLabel`/`setLabels` pins the whole T3.7 triple to the
 * forge that supplied the label set being recomposed (MAJEUR 2) — without it,
 * a self-hosted remote where `gh` fails the read and succeeds the write PUTs
 * GitLab's label set onto GitHub, which `setLabels` being a TOTAL replacement
 * turns into a destruction rather than a degradation.
 *
 * Takes `gh`/`glab` pre-bundled into one object rather than as two separate
 * parameters, only to stay under this file's `max-params` budget (4) once
 * `pin` is added — `ask` above is called far more often and stays plain.
 */
function askPinned<T>(
  opts: ForgeIssuesOptions,
  mode: LadderMode,
  candidates: { gh: Candidate<T>; glab: Candidate<T> },
  pin: ForgeCli | null,
): Promise<Attempt<T>> {
  return attempt(
    opts.cwd,
    opts.execFn ?? defaultExec,
    () => candidatesFor(opts.cwd, candidates.gh, candidates.glab, pin ?? undefined),
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
 *
 * `unsupported` maps to no code either, for the reason D8 decision 2 spells
 * out: the forge WAS reached and answered honestly that it cannot do this —
 * closer to `invalid-input` than to a `forge_unreachable` outage — and the
 * hierarchy stops no task, so it borrows none of the vocabulary that
 * qualifies why one did.
 */
export function forgeIssueReason(result: ForgeUnavailable): TaskReason | null {
  if (result.reason === 'invalid-input' || result.reason === 'unsupported') {
    return null
  }
  // The composition lives in degraded-mode.ts, the one place D9's rule is
  // written: the motif first and verbatim, the producer's own words after.
  return taskReason('forge_unreachable', forgeReasonDetail(result.reason, result.detail))
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

/**
 * One issue past the cap is what proves there are more; the extra one is
 * never returned. `forceTruncated` lets a caller who has an EXPLICIT signal
 * from the forge that more pages exist — GraphQL's own `hasNextPage: true`
 * — say so even when the page walk had to stop short of the cap for some
 * other reason (no cursor to reach the next page with): deriving
 * `truncated` from length ALONE would then silently look like a complete
 * list.
 */
function capPage(all: ForgeIssue[], forceTruncated = false): IssuePage {
  return {
    issues: all.slice(0, ISSUE_LIST_MAX),
    truncated: forceTruncated || all.length > ISSUE_LIST_MAX,
  }
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
  // `answeredBy` rides along so a caller that will WRITE back what it read can
  // pin that write to the same forge (MAJEUR 2). It is dropped rather than set
  // to `undefined` so `toEqual` on a plain result keeps working.
  return result.available
    ? {
        available: true,
        issue: result.value,
        ...(result.answeredBy ? { answeredBy: result.answeredBy } : {}),
      }
    : result
}

// --- Comments, read side (T3.5) ----------------------------------------------

type CommentPage = { comments: ForgeIssueComment[]; truncated: boolean }

/**
 * Every note that CAN carry a marker — i.e. every note a person or a bot
 * actually wrote. GitLab's system notes ("added ~bug", "changed the
 * description", "mentioned in merge request !12", "closed") are generated by
 * the server from an activity, never from a body anyone supplied, so no
 * codesema comment can ever be one: counting them is free of information and
 * costly in function.
 *
 * Costly how, concretely: `capComments` refuses to answer past
 * `ISSUE_COMMENT_LIST_MAX`, `publishTaskRecap` refuses to write on a refusal
 * to answer, and nothing ever lowers that count again — so a lively ticket
 * whose 200th note happens to be a label change loses its recap PERMANENTLY,
 * behind a `forge_unreachable` that reads transitory and invites a retry that
 * cannot ever succeed. GitLab mints one such note per label, assignment,
 * milestone, state change, cross-reference and description edit, and T3.7 —
 * the next ticket in this very chain — WRITES LABELS. The guard now bites on
 * the volume of real comments, which is the volume the marker could hide in.
 *
 * glab's `--system-logs` flag is NOT this filter and cannot be used as one:
 * it gates the text RENDERING only (`if note.System && !opts.ShowSystemLogs
 * { continue }`, commands/issuable/view/issuable_view.go, glab 1.53.0), while
 * `--output json` marshals `IssueWithNotes{*Issue, Notes}` whole — system
 * notes included — read off the source rather than recalled.
 */
function commentsOnly(all: readonly ForgeIssueComment[]): ForgeIssueComment[] {
  return all.filter((comment) => !comment.system)
}

/**
 * One comment past the cap is what proves there are more; the extra one is
 * never returned. `forceTruncated` is for the caller who KNOWS more notes
 * exist beyond what it read but can no longer prove it from a length — see
 * `glabCommentsCandidate`, where the system filter can turn 300 fetched notes
 * into 0 comments and make a page walk that stopped short look complete. Same
 * escape hatch, and the same reason, as `capPage`'s.
 */
function capComments(all: readonly ForgeIssueComment[], forceTruncated = false): CommentPage {
  const comments = commentsOnly(all)
  return {
    comments: comments.slice(0, ISSUE_COMMENT_LIST_MAX),
    truncated: forceTruncated || comments.length > ISSUE_COMMENT_LIST_MAX,
  }
}

/**
 * gh paginates the comments connection internally behind `--json comments`:
 * one call, and `truncated` can only ever report OUR cap being exceeded. What
 * gh itself decided to stop fetching is not observable from the payload — a
 * limit named here rather than left implied, since this read's whole job is to
 * prove an absence.
 */
function ghCommentsCandidate(id: string): Candidate<CommentPage> {
  return oneCall('gh', ['issue', 'view', id, '--json', 'comments'], (stdout) => {
    const comments = parseGhIssueComments(stdout)
    return comments === null ? null : capComments(comments)
  })
}

/**
 * glab cannot: `issue view --comments` pages the notes with GitLab's own
 * `--page`/`--per-page` (default 20), clamped at 100 server-side — so the
 * pages are walked exactly like `glabListCandidate` walks the issue list, and
 * for the same reason: a default `--per-page` would truncate in silence.
 */
function glabCommentsCandidate(id: string): Candidate<CommentPage> {
  return {
    cli: 'glab',
    run: async (execFn, cwd) => {
      const all: ForgeIssueComment[] = []
      for (let page = 1; page <= GLAB_MAX_COMMENT_PAGES; page += 1) {
        // prettier-ignore
        const args = ['issue', 'view', id, '--comments', '--output', 'json', '--per-page', GLAB_PER_PAGE, '--page', String(page)]
        const outcome = await execFn('glab', args, cwd)
        if (outcome.kind !== 'ok') {
          return outcome
        }
        const batch = parseGlabIssueNotes(outcome.stdout)
        if (batch === null) {
          return { kind: 'error', message: UNREADABLE }
        }
        all.push(...batch)
        if (batch.length < GLAB_PAGE_SIZE) {
          // A short page is the end of the notes — but the pages before it can
          // already have overshot the cap, so the cap applies HERE too.
          return { kind: 'ok', value: capComments(all) }
        }
        // No in-loop cap check, deliberately: `GLAB_MAX_COMMENT_PAGES` IS the
        // cap, being sized from it (3 × 100 > 200), so a `break` on the count
        // could only ever fire on the last iteration — one statement before
        // the loop bound ends it anyway. `glabListCandidate` still carries
        // that dead break; here it was removed rather than kept for symmetry,
        // because a statement no input can make matter is a statement no test
        // can hold in place.
      }
      // Every page came back full and the walk ran out of pages: notes exist
      // past the last one read, and after the system filter no length can say
      // so any more — 300 fetched system notes leave 0 comments, which would
      // otherwise read as a complete, empty answer and let a duplicate recap
      // through. Same "a full page proves nothing" rule the issue hierarchy
      // walk already applies.
      return { kind: 'ok', value: capComments(all, true) }
    },
  }
}

/**
 * The existing comments of an issue, for the recap publication's marker search
 * (T3.5). A READ: it may walk the whole ladder, and a failure on one CLI costs
 * nothing to retry on the other.
 *
 * GitLab's SYSTEM notes are not in the answer and are not counted against the
 * cap (`commentsOnly`); GitHub's payload never carried any. The asymmetry is
 * named rather than smoothed over (D8): the two forges do hand back different
 * things here, `parseGlabIssueNotes` still reports `system` faithfully for
 * anyone who needs the activity trail, and this ONE reader drops them because
 * its ONE question — "is our marker already on this issue?" — is a question
 * no system note can answer.
 */
export async function listIssueComments(
  opts: ForgeIssuesOptions & { number: number },
): Promise<ForgeIssueCommentsResult> {
  if (!isIssueNumber(opts.number)) {
    return refuse(`invalid issue number: ${String(opts.number)}`)
  }
  const id = String(opts.number)
  const result = await ask(opts, 'read', ghCommentsCandidate(id), glabCommentsCandidate(id))
  return result.available
    ? { available: true, comments: result.value.comments, truncated: result.value.truncated }
    : result
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
  opts: ForgeIssuesOptions & ForgePinned & { number: number; labels: string[] },
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
  // `pin`, when the caller read the current set first, is what forbids this
  // TOTAL replacement from landing on a forge that never supplied that set
  // (MAJEUR 2). Absent, the ordinary write ladder applies.
  const result = await askPinned(
    opts,
    'write',
    { gh: oneCall('gh', ghArgs, done), glab: oneCall('glab', glabArgs, done) },
    opts.pin ?? null,
  )
  return result.available ? { available: true } : result
}

// --- Repo label catalog: read it, then create only what is missing (T3.7) ----
//
// The two operations the lazy, idempotent creation of the cycle labels needs,
// and the only two in this file that go through the LABEL porcelain rather
// than `api`: D5 says porcelain wherever it covers the operation, and both
// CLIs cover `label list` and `label create` (`gh label list --help` /
// `glab label list --help`, gh 2.46.0 and glab 1.53.0). The asymmetries are
// documented, not smoothed over (D8):
//   - gh takes the new label's name POSITIONALLY (`gh label create <name>`),
//     glab takes it as a flag (`--name`). That is why `createLabel` refuses a
//     name starting with `-` before any spawn — on gh, and on gh alone, such a
//     name would be read by the binary as a flag;
//   - the colour is BARE hex on gh (`--color E99695`) and `#`-prefixed on
//     glab, whose own default is written `#428BCA`;
//   - gh paginates internally behind one `--limit`, glab exposes GitLab's
//     `--page`/`--per-page` and clamps a page at 100 — the same split
//     `listIssues` already lives with.

/**
 * Hard cap on one `listLabels` answer, and the same doctrine as
 * `ISSUE_LIST_MAX`: what the cap leaves out is REPORTED (`truncated: true`),
 * never dropped in silence. The number matters less than the honesty — a
 * caller holding a capped catalog must not conclude "this label does not
 * exist" from a name it cannot see.
 */
export const LABEL_LIST_MAX = 200
const GH_LABEL_LIMIT = String(LABEL_LIST_MAX + 1)
const GLAB_MAX_LABEL_PAGES = Math.ceil((LABEL_LIST_MAX + 1) / GLAB_PAGE_SIZE)

/** Six hex digits, bare: `#` is added for glab and never for gh (see above). */
export const FORGE_LABEL_COLOR = '5B4B8A'

type LabelPage = { labels: string[]; truncated: boolean }

/** One label past the cap is what proves there are more; the extra is never returned. */
function capLabels(all: string[]): LabelPage {
  return { labels: all.slice(0, LABEL_LIST_MAX), truncated: all.length > LABEL_LIST_MAX }
}

function ghLabelListCandidate(): Candidate<LabelPage> {
  const args = ['label', 'list', '--limit', GH_LABEL_LIMIT, '--json', 'name']
  return oneCall('gh', args, (stdout) => {
    const names = parseLabelNames(stdout)
    return names === null ? null : capLabels(names)
  })
}

function glabLabelListCandidate(): Candidate<LabelPage> {
  return {
    cli: 'glab',
    run: async (execFn, cwd) => {
      const all: string[] = []
      for (let page = 1; page <= GLAB_MAX_LABEL_PAGES; page += 1) {
        const args = [
          'label',
          'list',
          '--per-page',
          GLAB_PER_PAGE,
          '--page',
          String(page),
          '--output',
          'json',
        ]
        const outcome = await execFn('glab', args, cwd)
        if (outcome.kind !== 'ok') {
          return outcome
        }
        const batch = parseLabelNames(outcome.stdout)
        if (batch === null) {
          return { kind: 'error', message: UNREADABLE }
        }
        all.push(...batch)
        if (batch.length < GLAB_PAGE_SIZE) {
          // A short page ends the list — but the pages before it may already
          // have overshot the cap, so it is applied here too (listIssues'
          // lesson: skipping it returned 250 names with truncated:false).
          return { kind: 'ok', value: capLabels(all) }
        }
        if (all.length > LABEL_LIST_MAX) {
          break
        }
      }
      return { kind: 'ok', value: capLabels(all) }
    },
  }
}

/**
 * `truncated` is never optional, for the same reason it is not on
 * `listIssues`: a caller cannot hold a capped catalog without being handed the
 * fact that it is capped (invariant 2). Here it is load-bearing rather than
 * merely honest — see `ensureCycleLabel` in task-labels.ts, which declines to
 * create anything at all while it cannot prove a name absent.
 */
export type ForgeLabelsResult =
  { available: true; labels: string[]; truncated: boolean } | ForgeUnavailable

export async function listLabels(
  opts: ForgeIssuesOptions & ForgePinned,
): Promise<ForgeLabelsResult> {
  // Pinned by the same caller and for the same reason as `createLabel` below:
  // GitHub's catalog answers nothing about GitLab's, so a triple that read an
  // issue on one forge asks that forge — and only it — what it already holds.
  const result = await askPinned(
    opts,
    'read',
    { gh: ghLabelListCandidate(), glab: glabLabelListCandidate() },
    opts.pin ?? null,
  )
  return result.available
    ? { available: true, labels: result.value.labels, truncated: result.value.truncated }
    : result
}

/**
 * Creates ONE label. Deliberately NOT idempotent by itself — neither forge
 * offers an idempotent create (`gh label create --force` UPDATES the colour
 * and description of an existing label, which is a mutation of somebody
 * else's label, not a no-op) — so idempotence is the CALLER's, built on
 * `listLabels`: ask first, create only what is provably missing.
 *
 * The name goes through `sanitizeIssueLabels`, the very check `setLabels`
 * applies, so a name that could never be WRITTEN back onto an issue is
 * refused before it is created; and a leading `-` is refused on top of it,
 * because gh's name is positional and its binary would read such a name as a
 * flag. Both refusals are `invalid-input`: nothing was launched, so this is
 * our input and not the forge's health.
 */
export async function createLabel(
  opts: ForgeIssuesOptions & ForgePinned & { name: string; description?: string | undefined },
): Promise<ForgeWriteResult> {
  const checked = sanitizeIssueLabels([opts.name])
  if (!checked.ok) {
    return refuse(checked.detail)
  }
  const name = checked.labels[0] ?? ''
  if (name.startsWith('-')) {
    return refuse(`label ${JSON.stringify(name)} refused: a leading "-" would be read as a flag`)
  }
  const description = sanitizeIssueTitle(opts.description)
  const said = description ? [`--description=${description}`] : []
  const result = await askPinned(
    opts,
    'write',
    {
      gh: oneCall('gh', ['label', 'create', name, `--color=${FORGE_LABEL_COLOR}`, ...said], done),
      glab: oneCall(
        'glab',
        ['label', 'create', `--name=${name}`, `--color=#${FORGE_LABEL_COLOR}`, ...said],
        done,
      ),
    },
    opts.pin ?? null,
  )
  return result.available ? { available: true } : result
}

// --- Hierarchy: parent → child, one level (T2.2, D8) -------------------------

/**
 * child → parent — an ACCELERATOR, never the source of truth (review MAJEUR
 * 3): the one-level guard below asks the FORGE for the real current parent
 * before it lets a link through, and only consults this cache to skip that
 * ask when the answer is already known. It is seeded by a successful
 * `listChildIssues` and kept in sync by a successful
 * `linkChildIssue`/`unlinkChildIssue`; a caller that shares ONE instance
 * across calls gets fewer redundant reads, but correctness never depends on
 * it being shared — a fresh `Map()` per call (the default) still asks the
 * forge and still gets the right answer, just with one more round trip.
 */
export type IssueHierarchyCache = Map<number, number>

export type ForgeHierarchyOptions = ForgeIssuesOptions & {
  hierarchy?: IssueHierarchyCache | undefined
}

/** `hierarchy` is `unknown` the moment it crosses a boundary this module
 * does not control (a caller that lost its types, same posture as
 * `sanitizeIssueTitle`): a plain object or `null` degrades to a fresh cache
 * rather than throwing on `.get`. */
function hierarchyCacheOf(opts: ForgeHierarchyOptions): IssueHierarchyCache {
  return opts.hierarchy instanceof Map ? opts.hierarchy : new Map<number, number>()
}

function ghIssuePath(number: number): string {
  return `repos/{owner}/{repo}/issues/${number}`
}

/**
 * Bridges a FAILURE during the pre-write id resolution to `blocked` (see
 * that `CandidateOutcome` member's own comment): `missing` and `invalid`
 * already mean "nothing ran" and pass through unchanged, only a genuine
 * `error` here — the READ itself failed — is remapped, so a write-mode
 * ladder never treats an unreachable RESOLVE as an unreachable WRITE
 * (MAJEUR 4).
 */
function blockedOnResolve(
  outcome: Exclude<CandidateOutcome<unknown>, { kind: 'ok' }>,
): CandidateOutcome<never> {
  return outcome.kind === 'error' ? { kind: 'blocked', message: outcome.message } : outcome
}

/**
 * GitHub's sub-issues write endpoints take the CHILD's internal database
 * `id` in the body, never its repo-scoped `number` — one resolve READ before
 * the write itself, whose failure is `blocked`, not `error` (nothing was
 * written yet). The PARENT keeps riding its plain `number` in the URL,
 * exactly like every other issue endpoint in this file.
 */
function ghLinkCandidate(parent: number, child: number): Candidate<true> {
  return {
    cli: 'gh',
    run: async (execFn, cwd) => {
      const resolved = await execFn('gh', ['api', ghIssuePath(child)], cwd)
      if (resolved.kind !== 'ok') {
        return blockedOnResolve(resolved)
      }
      const childId = ghIssueDatabaseId(resolved.stdout)
      if (childId === null) {
        return { kind: 'blocked', message: UNREADABLE }
      }
      const outcome = await execFn(
        'gh',
        [
          'api',
          `${ghIssuePath(parent)}/sub_issues`,
          '--method',
          'POST',
          `--field=sub_issue_id=${childId}`,
        ],
        cwd,
      )
      return outcome.kind === 'ok' ? { kind: 'ok', value: true } : outcome
    },
  }
}

/** Same resolve-then-write shape as `ghLinkCandidate`; the removal endpoint
 * is singular (`sub_issue`, not `sub_issues`) — the shape itself is
 * correct, checked against GitHub's current REST docs, but an EARLIER
 * "verified … gh 2.46.0" note here was a false attestation: gh 2.46.0
 * shipped 2024-03-20, while the sub-issues REST API was only announced
 * 2024-12-12 (general availability later still) — no version of `gh` at
 * that release date could have documented an endpoint that did not exist
 * yet. The local `gh --version` a prior pass consulted shows the CLI
 * binary's own build date, not the REST API surface's, and the two are
 * unrelated. */
function ghUnlinkCandidate(parent: number, child: number): Candidate<true> {
  return {
    cli: 'gh',
    run: async (execFn, cwd) => {
      const resolved = await execFn('gh', ['api', ghIssuePath(child)], cwd)
      if (resolved.kind !== 'ok') {
        return blockedOnResolve(resolved)
      }
      const childId = ghIssueDatabaseId(resolved.stdout)
      if (childId === null) {
        return { kind: 'blocked', message: UNREADABLE }
      }
      const outcome = await execFn(
        'gh',
        [
          'api',
          `${ghIssuePath(parent)}/sub_issue`,
          '--method',
          'DELETE',
          `--field=sub_issue_id=${childId}`,
        ],
        cwd,
      )
      return outcome.kind === 'ok' ? { kind: 'ok', value: true } : outcome
    },
  }
}

/**
 * GitHub documents "up to 100 sub-issues per parent issue" — a PRODUCT
 * limit stated in GitHub's own docs, not a guarantee this REST endpoint's
 * pagination enforces, and not this module's choice either: a product
 * limit is exactly the kind of number a later GitHub release can raise
 * without this endpoint's shape changing at all. `per_page=100` is
 * separately the documented maximum for `per_page` itself on this
 * endpoint, so a single call is still the most this module can ever ask
 * for in one round trip — but treating a FULL page (100 back) as proof the
 * list is complete would silently reopen the exact truncation this file's
 * `capPage` exists to catch everywhere else. A page shorter than 100 IS
 * proof of completeness (there is no gap GitHub could be hiding past it);
 * a full page is not, so `truncated` follows the page length rather than
 * being hard-coded to `false`.
 */
const GH_SUBISSUES_PAGE_SIZE = 100

function ghChildrenCandidate(parent: number): Candidate<IssuePage> {
  return {
    cli: 'gh',
    run: async (execFn, cwd) => {
      const args = [
        'api',
        `${ghIssuePath(parent)}/sub_issues`,
        '--method',
        'GET',
        `--field=per_page=${GH_SUBISSUES_PAGE_SIZE}`,
      ]
      const outcome = await execFn('gh', args, cwd)
      if (outcome.kind !== 'ok') {
        return outcome
      }
      const issues = parseGhSubIssueList(outcome.stdout)
      return issues === null
        ? { kind: 'error', message: UNREADABLE }
        : { kind: 'ok', value: { issues, truncated: issues.length >= GH_SUBISSUES_PAGE_SIZE } }
    },
  }
}

/**
 * `gh api` formats EVERY REST error the same way — verified straight from
 * `cli/cli`'s `pkg/cmd/api/api.go` (`parseErrorResponse`:
 * `fmt.Sprintf("%s (HTTP %d)", parsedBody.Message, statusCode)`, printed as
 * `gh: %s`) — so a bare `404` inside that text says only "some 4xx/5xx
 * happened to embed these three digits somewhere", not "there is no
 * parent": a locked-issue 422 whose title mentions "/docs/404", a proxy's
 * literal `404 Not Found` HTML page relayed as a 502, a rate-limit message
 * linking a docs URL that ends in `#404`, all contain the substring `404`
 * and are NOT "no parent found".
 *
 * GitHub's own answer to an issue with no parent was checked live against
 * `GET https://api.github.com/repos/cli/cli/issues/1/parent`: the body is
 * `{"message": "No parent issue found", ...}`, which `gh api` turns into
 * exactly `gh: No parent issue found (HTTP 404)` — that specific phrase,
 * not the bare status code, is the only signal this endpoint gives to tell
 * "no parent" apart from every other 404. A plain "issue not found" 404
 * answers `{"message": "Not Found"}` instead (checked the same way against
 * a nonexistent issue number) and must NOT be read as "no parent".
 *
 * This distinction is not a nicety: GitHub's own product documentation
 * allows up to EIGHT levels of nested sub-issues — the forge does not
 * refuse a second level on its own. This CLI's one-level guard is the
 * ONLY thing enforcing D8 on GitHub, so guessing "no parent" from an
 * ambiguous 404 would let a real second level through. A message that does
 * not match the recognized signature is therefore surfaced as an ordinary
 * `error`, never guessed as `ok: null` — fail CLOSED (refuse to link),
 * never fail open.
 */
const GH_NO_PARENT_FOUND = /no parent issue found.*\(http 404\)/i

function ghParentCandidate(number: number): Candidate<number | null> {
  return {
    cli: 'gh',
    run: async (execFn, cwd) => {
      const outcome = await execFn('gh', ['api', `${ghIssuePath(number)}/parent`], cwd)
      if (outcome.kind === 'error' && GH_NO_PARENT_FOUND.test(outcome.message)) {
        return { kind: 'ok', value: null }
      }
      if (outcome.kind !== 'ok') {
        return outcome
      }
      const parentNumber = ghIssueNumberFromRest(outcome.stdout)
      return parentNumber === null
        ? { kind: 'error', message: UNREADABLE }
        : { kind: 'ok', value: parentNumber }
    },
  }
}

/** The cheapest existence probe GitHub's REST offers: `per_page=1` on the
 * same endpoint `ghChildrenCandidate` uses, read only for non-emptiness. */
function ghHasChildrenCandidate(number: number): Candidate<boolean> {
  return {
    cli: 'gh',
    run: async (execFn, cwd) => {
      const args = [
        'api',
        `${ghIssuePath(number)}/sub_issues`,
        '--method',
        'GET',
        '--field=per_page=1',
      ]
      const outcome = await execFn('gh', args, cwd)
      if (outcome.kind !== 'ok') {
        return outcome
      }
      const batch = parseGhSubIssueList(outcome.stdout)
      return batch === null
        ? { kind: 'error', message: UNREADABLE }
        : { kind: 'ok', value: batch.length > 0 }
    },
  }
}

function glabIssuePath(number: number): string {
  return `projects/:fullpath/issues/${number}`
}

/** The CANONICAL global id form (`work_item_id_type.rb` warns the
 * `gid://gitlab/Issue/<id>` compatibility alias "will be removed without
 * notice"): every mutation and query in this file builds its id this way. */
function glabIssueGid(id: number): string {
  return `gid://gitlab/WorkItem/${id}`
}

/**
 * GitLab's hierarchy lives behind GraphQL (work items), which — unlike
 * `gh api`'s `{owner}/{repo}` or `glab api`'s own `:fullpath` REST
 * placeholder — cannot resolve a project-scoped `iid` on its own: a GraphQL
 * variable is never substituted from the working directory the way a REST
 * endpoint PATH is (both CLIs document identically that every field but
 * `query`/`operationName` is read as a plain variable). Each id is therefore
 * resolved first through the REST shortcut this file already uses for
 * `setLabels` (`projects/:fullpath/…`), reading the plain `id` field a
 * GraphQL global id is built from — one round trip GitHub's link/unlink does
 * not pay, since GitHub's write only ever needs the CHILD resolved. A
 * resolve failure is `blocked`, not `error` — see that type's comment.
 */
async function glabResolveId(
  execFn: ForgeIssuesExecFn,
  cwd: string,
  number: number,
): Promise<CandidateOutcome<number>> {
  const outcome = await execFn('glab', ['api', glabIssuePath(number)], cwd)
  if (outcome.kind !== 'ok') {
    return blockedOnResolve(outcome)
  }
  const id = glabIssueDatabaseId(outcome.stdout)
  return id === null ? { kind: 'blocked', message: UNREADABLE } : { kind: 'ok', value: id }
}

/** Same REST resolve as `glabResolveId`, but for the ONE candidate that also
 * needs an absolute URL to hand out (`glabChildrenCandidate`): `WorkItemType`
 * has no `web_url` of its own, only a relative `webPath`, so the origin is
 * read once off the resolved PARENT's own REST answer and reused for every
 * child on the page. */
async function glabResolveRef(
  execFn: ForgeIssuesExecFn,
  cwd: string,
  number: number,
): Promise<CandidateOutcome<{ id: number; origin: string }>> {
  const outcome = await execFn('glab', ['api', glabIssuePath(number)], cwd)
  if (outcome.kind !== 'ok') {
    return blockedOnResolve(outcome)
  }
  const ref = glabIssueRestRef(outcome.stdout)
  return ref === null ? { kind: 'blocked', message: UNREADABLE } : { kind: 'ok', value: ref }
}

/** Verified against the documented mutation shape (glab 1.53.0 ships the
 * GraphQL client, not the schema — the query text itself is this module's
 * own): `workItemUpdate(input: {id, hierarchyWidget: {parentId}})`. Exported
 * (round 5, MINEUR 3) so its own test can lock the literal string apart from
 * the module that sends it — a typo here (`hierarchywidget`) is invisible to
 * every other test, since GitLab's OWN error for an unknown input argument
 * (`looksLikeSchemaGap`) matches our own misspelling just as readily as a
 * real schema gap, presenting our bug as an edition incapability. */
export const GLAB_HIERARCHY_SET_PARENT =
  'mutation($id: WorkItemID!, $parentId: WorkItemID!) { workItemUpdate(input: {id: $id, hierarchyWidget: {parentId: $parentId}}) { errors } }'

/**
 * Clears whatever parent `id` CURRENTLY has — GitLab's mutation takes no
 * `parentId` to confirm against, unlike GitHub's DELETE, which validates the
 * (parent, child) pair through the URL and the body together and refuses if
 * `child` is not actually `parent`'s sub-issue. This is a real asymmetry,
 * not smoothed over (D8): on GitLab, `unlinkChildIssue(parent, child)`
 * detaches `child` from its real parent whatever that is, trusting the
 * caller's `parent` argument rather than re-verifying it — documented in the
 * README rather than papered over with an extra read this ticket does not
 * otherwise need.
 *
 * Exported (round 5, MINEUR 3) for the same reason as `GLAB_HIERARCHY_SET_PARENT`:
 * a typo in the literal string is otherwise locked by nothing.
 */
export const GLAB_HIERARCHY_CLEAR_PARENT =
  'mutation($id: WorkItemID!) { workItemUpdate(input: {id: $id, hierarchyWidget: {parentId: null}}) { errors } }'

function glabLinkCandidate(parent: number, child: number): Candidate<true> {
  return {
    cli: 'glab',
    run: async (execFn, cwd) => {
      const childResolved = await glabResolveId(execFn, cwd, child)
      if (childResolved.kind !== 'ok') {
        return childResolved
      }
      const parentResolved = await glabResolveId(execFn, cwd, parent)
      if (parentResolved.kind !== 'ok') {
        return parentResolved
      }
      const args = [
        'api',
        'graphql',
        `--field=query=${GLAB_HIERARCHY_SET_PARENT}`,
        `--field=id=${glabIssueGid(childResolved.value)}`,
        `--field=parentId=${glabIssueGid(parentResolved.value)}`,
      ]
      const outcome = await execFn('glab', args, cwd)
      if (outcome.kind !== 'ok') {
        return outcome
      }
      return parseGlabHierarchyMutation(outcome.stdout)
    },
  }
}

function glabUnlinkCandidate(child: number): Candidate<true> {
  return {
    cli: 'glab',
    run: async (execFn, cwd) => {
      const childResolved = await glabResolveId(execFn, cwd, child)
      if (childResolved.kind !== 'ok') {
        return childResolved
      }
      const args = [
        'api',
        'graphql',
        `--field=query=${GLAB_HIERARCHY_CLEAR_PARENT}`,
        `--field=id=${glabIssueGid(childResolved.value)}`,
      ]
      const outcome = await execFn('glab', args, cwd)
      if (outcome.kind !== 'ok') {
        return outcome
      }
      return parseGlabHierarchyMutation(outcome.stdout)
    },
  }
}

/**
 * `first: 100` in the query text is GitLab's own `default_max_page_size`
 * (asking for more, e.g. 200, is silently CLAMPED rather than refused — the
 * exact silent-truncation shape T2.1's review already flagged once): reaching
 * `ISSUE_LIST_MAX` (200) needs a real cursor walk, `after` fed from the
 * previous page's `endCursor`, `pageInfo.hasNextPage` deciding when to stop —
 * the authoritative signal GraphQL hands over for free, preferred here to the
 * "short page" heuristic the REST paths in this file use when they have
 * nothing better.
 */
const GLAB_CHILDREN_PAGE_SIZE = 100
const GLAB_CHILDREN_MAX_PAGES = Math.ceil((ISSUE_LIST_MAX + 1) / GLAB_CHILDREN_PAGE_SIZE)

function glabChildrenCandidate(parent: number): Candidate<IssuePage> {
  return {
    cli: 'glab',
    run: async (execFn, cwd) => {
      const parentRef = await glabResolveRef(execFn, cwd, parent)
      if (parentRef.kind !== 'ok') {
        return parentRef
      }
      const { id, origin } = parentRef.value
      const all: ForgeIssue[] = []
      let cursor: string | null = null
      // Tracks whether the LAST page we actually saw claimed more were
      // coming. Loop exhaustion (hitting GLAB_CHILDREN_MAX_PAGES, or the
      // `all.length > ISSUE_LIST_MAX` break below) falls through to the
      // return after the loop — that return must NOT derive `truncated`
      // from length alone, or a short/empty final page (e.g. filtered out
      // by authorization) with `hasNextPage: true` would silently look
      // like a complete list, the exact failure mode this file already
      // guards against for the "no cursor" branch below.
      let lastHadNextPage = false
      for (let page = 1; page <= GLAB_CHILDREN_MAX_PAGES; page += 1) {
        const args = [
          'api',
          'graphql',
          `--field=query=${GLAB_HIERARCHY_CHILDREN_QUERY}`,
          `--field=id=${glabIssueGid(id)}`,
          ...(cursor === null ? [] : [`--field=after=${cursor}`]),
        ]
        const outcome = await execFn('glab', args, cwd)
        if (outcome.kind !== 'ok') {
          return outcome
        }
        const parsed = parseGlabHierarchyChildren(outcome.stdout, origin)
        if (parsed.kind !== 'ok') {
          return parsed
        }
        all.push(...parsed.value.issues)
        lastHadNextPage = parsed.value.hasNextPage
        if (!parsed.value.hasNextPage) {
          // The forge itself says this was the last page: length alone
          // decides `truncated` (it can still be true, having overshot the
          // cap on this very page).
          return { kind: 'ok', value: capPage(all) }
        }
        if (parsed.value.endCursor === null) {
          // The forge said "more" but gave no cursor to reach them: there is
          // nothing left this walk CAN do, but that is not the same as the
          // list being complete — `hasNextPage: true` is forced through as
          // `truncated: true` rather than silently looking whole because the
          // page we did get happened to be short of the cap.
          return { kind: 'ok', value: capPage(all, true) }
        }
        if (all.length > ISSUE_LIST_MAX) {
          break
        }
        cursor = parsed.value.endCursor
      }
      return { kind: 'ok', value: capPage(all, lastHadNextPage) }
    },
  }
}

function glabParentCandidate(number: number): Candidate<number | null> {
  return {
    cli: 'glab',
    run: async (execFn, cwd) => {
      const resolved = await glabResolveId(execFn, cwd, number)
      if (resolved.kind !== 'ok') {
        return resolved
      }
      const args = [
        'api',
        'graphql',
        `--field=query=${GLAB_HIERARCHY_PARENT_QUERY}`,
        `--field=id=${glabIssueGid(resolved.value)}`,
      ]
      const outcome = await execFn('glab', args, cwd)
      if (outcome.kind !== 'ok') {
        return outcome
      }
      return parseGlabHierarchyParent(outcome.stdout)
    },
  }
}

function glabHasChildrenCandidate(number: number): Candidate<boolean> {
  return {
    cli: 'glab',
    run: async (execFn, cwd) => {
      const resolved = await glabResolveId(execFn, cwd, number)
      if (resolved.kind !== 'ok') {
        return resolved
      }
      const args = [
        'api',
        'graphql',
        `--field=query=${GLAB_HIERARCHY_HAS_CHILDREN_QUERY}`,
        `--field=id=${glabIssueGid(resolved.value)}`,
      ]
      const outcome = await execFn('glab', args, cwd)
      if (outcome.kind !== 'ok') {
        return outcome
      }
      return parseGlabHierarchyHasChildren(outcome.stdout)
    },
  }
}

/**
 * Answers "does `number` already have a real parent" — the CACHE is an
 * accelerator, the FORGE is authoritative (MAJEUR 3): a cache hit skips the
 * read (and is trusted, since only a successful link/unlink/list ever writes
 * one), a cache miss asks `ghParentCandidate`/`glabParentCandidate` for the
 * real, current answer rather than assuming "not known" means "does not
 * exist".
 */
async function realParentOf(
  opts: ForgeHierarchyOptions,
  number: number,
  hierarchy: IssueHierarchyCache,
): Promise<Attempt<number | null>> {
  const cached = hierarchy.get(number)
  if (cached !== undefined) {
    return { available: true, value: cached }
  }
  return ask(opts, 'read', ghParentCandidate(number), glabParentCandidate(number))
}

/** Mirror of `realParentOf`: "does `number` already have at least one
 * child". A cache HIT (something maps TO `number`) is trusted directly; a
 * cache miss still asks the forge, since local absence never proves real
 * absence. */
async function realHasChildren(
  opts: ForgeHierarchyOptions,
  number: number,
  hierarchy: IssueHierarchyCache,
): Promise<Attempt<boolean>> {
  for (const knownParent of hierarchy.values()) {
    if (knownParent === number) {
      return { available: true, value: true }
    }
  }
  return ask(opts, 'read', ghHasChildrenCandidate(number), glabHasChildrenCandidate(number))
}

/**
 * A guard that cleared: `pin` is the ONE forge whose live state the guard
 * actually verified, or `null` when every guard read was a cache hit (no
 * live forge was consulted, so nothing constrains the write's choice of
 * forge any more than it already didn't before T2.2's guard existed).
 */
type GuardCleared = { available: true; pin: ForgeCli | null }

/**
 * D8's one substantive rule — the hierarchy is ONE level — enforced against
 * the REAL forge state, not just this process's memory (MAJEUR 3):
 *   1. auto-reference is refused purely locally, before anything else, on
 *      the cheapest possible check;
 *   2. `parent` must not already have a real parent (covers BOTH "second
 *      level" and "link a parent to its own child": if `parent`'s real
 *      parent happens to BE `child`, this check alone refuses it);
 *   3. `child` must not already have real children — the mirror direction:
 *      a parent-with-children cannot become someone's child either.
 * Both non-trivial checks are FORGE reads before any WRITE is attempted —
 * "avant tout appel à la forge" (design.md decision 3) is honoured for the
 * write itself, never replayed or risked, while the read that decides
 * whether to attempt it is exactly what the spec asks this module to trust
 * over its own unproven memory.
 *
 * `pin` on a clean pass names which forge those reads actually came from
 * (round 4 fix): a guard that read GitHub's state proves nothing about
 * GitLab's, so the caller must not let a subsequent write fall through to
 * the other forge on this guard's authority — see `linkChildIssue`, which
 * threads `pin` into the write-mode `ask()` call.
 */
async function guardOneLevel(
  opts: ForgeHierarchyOptions,
  parent: number,
  child: number,
  hierarchy: IssueHierarchyCache,
): Promise<ForgeUnavailable | GuardCleared> {
  if (parent === child) {
    return refuse(`issue ${parent} cannot be linked to itself`)
  }
  const parentOfParent = await realParentOf(opts, parent, hierarchy)
  if (!parentOfParent.available) {
    return parentOfParent
  }
  if (parentOfParent.value !== null) {
    hierarchy.set(parent, parentOfParent.value)
    return refuse(
      `issue ${parent} is already a child of ${parentOfParent.value}: the hierarchy is one level only (D8)`,
    )
  }
  const childHasChildren = await realHasChildren(opts, child, hierarchy)
  if (!childHasChildren.available) {
    return childHasChildren
  }
  if (childHasChildren.value) {
    return refuse(`issue ${child} already has children: the hierarchy is one level only (D8)`)
  }
  // Both reads run sequentially against the same forge/hint, so a
  // disagreement here would mean the two live reads landed on DIFFERENT
  // forges (e.g. gh answered one, glab answered the other because gh had
  // gone unreachable in between) — a guard that split across two forges
  // verified neither's state as a whole, so it pins nothing usable and the
  // safest call is to refuse rather than trust either half.
  if (
    parentOfParent.answeredBy !== undefined &&
    childHasChildren.answeredBy !== undefined &&
    parentOfParent.answeredBy !== childHasChildren.answeredBy
  ) {
    return refuse(
      `the hierarchy guard read parent state from ${parentOfParent.answeredBy} and children state from ${childHasChildren.answeredBy}: cannot pin the write to a single forge`,
    )
  }
  return { available: true, pin: parentOfParent.answeredBy ?? childHasChildren.answeredBy ?? null }
}

/**
 * Refuses a cycle or a second level against the REAL forge state (see
 * `guardOneLevel`) before attempting the write. On success, records
 * `child → parent` in `hierarchy` so a later call sharing the same cache can
 * skip a read it would otherwise repeat.
 */
export async function linkChildIssue(
  opts: ForgeHierarchyOptions & { parent: number; child: number },
): Promise<ForgeWriteResult> {
  if (!isIssueNumber(opts.parent)) {
    return refuse(`invalid parent issue number: ${String(opts.parent)}`)
  }
  if (!isIssueNumber(opts.child)) {
    return refuse(`invalid child issue number: ${String(opts.child)}`)
  }
  const hierarchy = hierarchyCacheOf(opts)
  const guard = await guardOneLevel(opts, opts.parent, opts.child, hierarchy)
  if (!guard.available) {
    return guard
  }
  const result = await askPinned(
    opts,
    'write',
    {
      gh: ghLinkCandidate(opts.parent, opts.child),
      glab: glabLinkCandidate(opts.parent, opts.child),
    },
    guard.pin,
  )
  if (!result.available) {
    return result
  }
  hierarchy.set(opts.child, opts.parent)
  return { available: true }
}

export async function unlinkChildIssue(
  opts: ForgeHierarchyOptions & { parent: number; child: number },
): Promise<ForgeWriteResult> {
  if (!isIssueNumber(opts.parent)) {
    return refuse(`invalid parent issue number: ${String(opts.parent)}`)
  }
  if (!isIssueNumber(opts.child)) {
    return refuse(`invalid child issue number: ${String(opts.child)}`)
  }
  const hierarchy = hierarchyCacheOf(opts)
  const result = await ask(
    opts,
    'write',
    ghUnlinkCandidate(opts.parent, opts.child),
    glabUnlinkCandidate(opts.child),
  )
  if (!result.available) {
    return result
  }
  // Only evict the entry this call is actually about: a cache that already
  // recorded a DIFFERENT parent for `child` is not this call's to erase (it
  // would be erasing a fact this unlink had nothing to do with).
  if (hierarchy.get(opts.child) === opts.parent) {
    hierarchy.delete(opts.child)
  }
  return { available: true }
}

/**
 * Never claims a link that is not there (spec: "rien ne prétend que le lien
 * existe"): a successful read REPLACES whatever `hierarchy` remembered for
 * this parent, so a child unlinked through the forge directly (outside this
 * process) is not kept alive by a stale cache entry.
 */
export async function listChildIssues(
  opts: ForgeHierarchyOptions & { parent: number },
): Promise<ForgeIssuesResult> {
  if (!isIssueNumber(opts.parent)) {
    return refuse(`invalid parent issue number: ${String(opts.parent)}`)
  }
  const hierarchy = hierarchyCacheOf(opts)
  const result = await ask(
    opts,
    'read',
    ghChildrenCandidate(opts.parent),
    glabChildrenCandidate(opts.parent),
  )
  if (!result.available) {
    return result
  }
  for (const [child, knownParent] of hierarchy) {
    if (knownParent === opts.parent) {
      hierarchy.delete(child)
    }
  }
  for (const child of result.value.issues) {
    hierarchy.set(child.number, opts.parent)
  }
  return { available: true, issues: result.value.issues, truncated: result.value.truncated }
}
