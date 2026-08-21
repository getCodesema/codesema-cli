// Ship (T5): the "Confirm complete" gesture of a task. Pushes the task branch
// to origin from the MAIN repo (branch refs are shared with the worktree, so
// the worktree can stay untouched — or already be gone) and opens the MR/PR
// through the forge CLI the user already has: gh or glab, picked with the same
// origin-hint rule as the MR list (forge-mrs.ts). A missing forge CLI degrades
// the ship to "push only" instead of failing it: the push DID succeed, the MR
// is one manual step away, and the note says so explicitly.
//
// The degraded outcomes below are D9's "no recap posted" half, and the rule
// they answer to is written once, in degraded-mode.ts. Each one carries
// `forge_unreachable` BESIDE the note it already produced (never instead of
// it) plus the motif verbatim in `detail` — `no-remote`, `no-cli`,
// `cli-error`, `offline` — so a reader can tell "install a CLI" from "the
// CLI failed" from "there is no remote at all" from "this machine never
// reached the host". Everything the remote ANSWERED (a rejected push, a
// declining hook, a refused credential) stays deliberately uncoded.

import { execFile } from 'node:child_process'
import { sanitizeRecord, type ReasonCode, type ReviewRecord, type TaskRecord } from './contract.js'
import type { ForgeDegradation } from './degraded-mode.js'
import { detectForgeHint, subprocessEnv } from './git.js'
import { t } from './i18n.js'
import { readJson } from './record.js'

/** Pushes and MR creations talk to the network: much looser than forge-mrs's 8s list timeout. */
export const SHIP_EXEC_TIMEOUT_MS = 60_000
/** Bound for the last-turn summary embedded in the MR description. */
const MR_BODY_SUMMARY_MAX = 4000
/** Bound for CLI error messages surfaced in journal events. */
const SHIP_ERROR_MAX = 500

/**
 * Same three-way split as forge-mrs's runForgeCli — 'missing' (binary not
 * installed) must stay distinct from 'error' so a missing gh falls through to
 * glab silently while a real failure surfaces its message — plus the stderr
 * text, which forge-mrs discards but the ship's error events need.
 */
export type ShipCliOutcome =
  | { kind: 'ok'; stdout: string }
  | { kind: 'missing' }
  /**
   * The command RAN and failed. `status` is its exit code when there was one
   * (a spawn that never produced a process has none), and it is the only
   * dependable way to tell git's own failures apart: git LOCALISES its
   * messages — `git remote get-url origin` on a repo without one answers
   * "error: Pas de serveur remote 'origin'" on a French box (measured, git
   * 2.53.0) — while the exit code is the same everywhere. OPTIONAL: a caller
   * that does not care keeps working, and an outcome without it is read as
   * "which failure this was is unknown", never as a particular one.
   */
  | { kind: 'error'; message: string; status?: number }

export type ShipGitExecFn = (args: string[], cwd: string) => Promise<ShipCliOutcome>
export type ShipForgeExecFn = (
  cli: 'gh' | 'glab',
  args: string[],
  cwd: string,
) => Promise<ShipCliOutcome>

function execCli(cmd: string, args: string[], cwd: string): Promise<ShipCliOutcome> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      // GIT_TERMINAL_PROMPT=0: a push against a remote that wants credentials
      // must fail fast with a readable error, not hang until the timeout.
      {
        cwd,
        encoding: 'utf8',
        timeout: SHIP_EXEC_TIMEOUT_MS,
        env: { ...subprocessEnv(), GIT_TERMINAL_PROMPT: '0' },
      },
      (err, stdout, stderr) => {
        if (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            resolve({ kind: 'missing' })
            return
          }
          const message = (stderr.trim() || err.message).slice(0, SHIP_ERROR_MAX)
          // execFile reports the exit code in `code` for a process that RAN,
          // and a string errno (ENOENT, E2BIG…) for one that never started.
          resolve({
            kind: 'error',
            message,
            ...(typeof err.code === 'number' ? { status: err.code } : {}),
          })
          return
        }
        resolve({ kind: 'ok', stdout })
      },
    )
  })
}

const defaultExecGit: ShipGitExecFn = (args, cwd) => execCli('git', args, cwd)
const defaultExecForge: ShipForgeExecFn = (cli, args, cwd) => execCli(cli, args, cwd)

/**
 * First https URL in the CLI output: both `gh pr create` and `glab mr create`
 * print the created MR/PR URL on stdout (verified gh 2.46.0 / glab 1.53.0).
 * Null when the tool succeeded but printed no URL — the ship still counts.
 */
export function extractMrUrl(raw: string): string | null {
  const match = /https:\/\/\S+/.exec(raw)
  return match ? match[0].replace(/[.,)\]]+$/, '') : null
}

/**
 * Best-effort detection of the "an MR already exists for this branch" failure
 * a second `gh pr create` / `glab mr create` run reports. Matched on the
 * common "already exists" wording both CLIs use (gh additionally prints the
 * existing PR's URL in that message, which extractMrUrl can then recover).
 * Deliberately loose: a phrasing this misses simply keeps the current
 * error-note behavior, it never turns a real failure into a success.
 */
export function isMrAlreadyExistsError(message: string): boolean {
  return /already exists/i.test(message)
}

/** Best-effort load of the task's archived review; null on any miss (same tolerance as buildFixTurnPrompt). */
function loadReview(task: TaskRecord): ReviewRecord | null {
  if (!task.review_ref) {
    return null
  }
  try {
    return sanitizeRecord(readJson(task.review_ref))
  } catch {
    return null
  }
}

/**
 * MR description: the agent's last summary, the local review verdict, and an
 * honest provenance note. The summary is the response of the last turn that
 * has one (the very last turn always does on the ship path — its 'done'
 * outcome is what triggered the review), bounded so a chatty agent cannot
 * blow up the forge's description limit.
 */
export function buildMrDescription(task: TaskRecord): string {
  const parts: string[] = []
  const summary = task.turns.findLast((turn) => turn.response)?.response
  if (summary) {
    const codePoints = Array.from(summary)
    parts.push(
      codePoints.length > MR_BODY_SUMMARY_MAX
        ? `${codePoints.slice(0, MR_BODY_SUMMARY_MAX - 1).join('')}…`
        : summary,
    )
  }
  const review = loadReview(task)
  if (review) {
    parts.push(
      t(
        'ship.mrReviewLine',
        { verdict: review.review.verdict, n: review.review.findings.length },
        review.review.findings.length,
      ),
    )
  }
  parts.push(`---\n${t('ship.mrGeneratedNote')}`)
  return parts.join('\n\n')
}

export type ShipTaskOptions = {
  /** MAIN repo root: the push and the forge CLI both run here, never in the worktree. */
  cwd: string
  task: TaskRecord
  /** Test seams — the defaults run real git / gh / glab. */
  execGit?: ShipGitExecFn
  execForge?: ShipForgeExecFn
}

/**
 * The motif of a degradation, VERBATIM as the vocabulary names it
 * (degraded-mode.ts) — never a reworded sentence. It travels next to
 * `reasonCode`, and the caller composes the reason's `detail` from the two so
 * `no-cli` can never be read as `cli-error`. OPTIONAL everywhere: an outcome
 * that names no degradation carries neither field.
 */
type ShipDegradation = { reasonCode?: ReasonCode; detail?: ShipMotif }

/**
 * The motifs a ship can name. The three the forge client itself produces,
 * plus `offline` — the one D9's title lists that no forge client can ever
 * answer, because the push dies before any forge is asked (see
 * `transportFailure` below).
 */
type ShipMotif = ForgeDegradation | 'offline'

export type ShipOutcome =
  | ({
      pushed: true
      mrUrl: string | null
      note: string | null
      /**
       * Names the degradation when the ship landed short of an MR. OPTIONAL:
       * a ship that opened its merge request has nothing to name, and the
       * `note` stays the readable half of the story either way.
       */
    } & ShipDegradation)
  /**
   * Nothing shipped. `error` is the readable half and has always been there;
   * the two optional fields name it when the cause is a forge codesema could
   * not reach, and stay absent for every other push failure — a rejected
   * non-fast-forward, a hook, a credential prompt — which `forge_unreachable`
   * would misname.
   */
  | ({ pushed: false; error: string } & ShipDegradation)

type ForgeCandidate = { cli: 'gh' | 'glab'; args: string[] }

/**
 * MR-creation commands, in probe order. Same selection rule as
 * forge-mrs.listOpenMrs: the origin hint skips the obviously wrong CLI, an
 * unrecognized (self-hosted) remote tries both. Flags verified against
 * gh 2.46.0 and glab 1.53.0.
 */
function forgeCandidates(cwd: string, task: TaskRecord): ForgeCandidate[] {
  const hint = detectForgeHint(cwd)
  // The MR targets the base BRANCH on the forge: strip the remote-tracking
  // prefix a detected base like 'origin/develop' carries.
  const base = task.base.replace(/^origin\//, '')
  const description = buildMrDescription(task)
  const candidates: ForgeCandidate[] = []
  if (hint !== 'gitlab') {
    // prettier-ignore
    candidates.push({
      cli: 'gh',
      args: ['pr', 'create', '--head', task.branch, '--base', base, '--title', task.title, '--body', description],
    })
  }
  if (hint !== 'github') {
    // prettier-ignore
    candidates.push({
      cli: 'glab',
      args: ['mr', 'create', '--source-branch', task.branch, '--target-branch', base, '--title', task.title, '--description', description, '--yes'],
    })
  }
  return candidates
}

/** Post-push MR creation: by construction always a pushed:true outcome. */
async function createMr(opts: ShipTaskOptions, execForge: ShipForgeExecFn): Promise<ShipOutcome> {
  // Journal note, not UI copy: raw English like every other event payload.
  let note: string | null = null
  for (const candidate of forgeCandidates(opts.cwd, opts.task)) {
    const outcome = await execForge(candidate.cli, candidate.args, opts.cwd)
    if (outcome.kind === 'missing') {
      continue
    }
    if (outcome.kind === 'error') {
      if (isMrAlreadyExistsError(outcome.message)) {
        // An MR already exists for this branch (a re-ship of a work-on task
        // whose branch had one open, typically): the push DID land the
        // commits on it, so this is a degraded success, not a failure. gh
        // prints the existing PR's URL inside the error message — recover it
        // when present.
        return {
          pushed: true,
          mrUrl: extractMrUrl(outcome.message),
          note: `${candidate.cli}: a merge request already exists for this branch — the push updated it`,
        }
      }
      // Keep trying (a dual-remote setup may have the other CLI working) but
      // remember the failure: it is the honest note if nothing else succeeds.
      note = `${candidate.cli} failed: ${outcome.message}`
      continue
    }
    const mrUrl = extractMrUrl(outcome.stdout)
    return {
      pushed: true,
      mrUrl,
      note: mrUrl ? null : `${candidate.cli} created the merge request but printed no URL`,
    }
  }
  if (note !== null) {
    // A forge CLI DID run and failed: its own message stays the honest note.
    //
    // This used to be left UNCODED, on the argument that "the forge answered,
    // so forge_unreachable would misname it". T2.7 overturns that: D2 defines
    // `forge_unreachable` as "the forge could not be reached: no gh/glab
    // available, no network, an API that refused" (contract/src/reasons.ts),
    // and a `gh` that exits non-zero on `pr create` IS an API that refused.
    // The three DP14 questions all answer yes — it qualifies a refusal (no MR
    // was opened), terminal-vs-retryable is meaningful (retryable: the same
    // call can succeed later), and a machine reads it (T3.6 will not merge
    // without an MR). Leaving it uncoded made the ONE forge degradation a
    // human is most likely to hit the only one no machine could see.
    //
    // `detail: 'cli-error'` is what keeps it distinguishable from the
    // `no-cli` case below, which shares the code and means the opposite
    // thing for what the user must do about it.
    return { pushed: true, mrUrl: null, note, reasonCode: 'forge_unreachable', detail: 'cli-error' }
  }
  return {
    pushed: true,
    mrUrl: null,
    note: 'no forge CLI (gh or glab) available — branch pushed, open the merge request manually',
    // The push DID land: the work is safe on origin and the MR is one manual
    // (or one retried) step away — a retryable degradation, not a failure.
    reasonCode: 'forge_unreachable',
    detail: 'no-cli',
  }
}

/**
 * Journal note, not UI copy: raw English like every other payload in this file.
 * Deliberately NOT exported: a test that imported it would compare the message
 * to the constant that produces it and prove nothing. What the tests pin is
 * the pair (readable message, coded motif) at the surface where a human and a
 * machine actually read it.
 */
const SHIP_NO_REMOTE_ERROR =
  'no origin remote is configured for this repo — there is nothing to push the branch to, and no merge request can be opened'

/** Exit code git uses for "there is no remote by that name" (git 2.53.0). */
const GIT_NO_SUCH_REMOTE = 2

/**
 * Is there an `origin` to push to? Asked through the SAME injected git seam as
 * the push itself, so a test that stubs git stubs this too and no test ever
 * needs a real remote.
 *
 * TRI-state, and that is the whole point (round-2 adversarial review, majeur
 * 1). `false` is claimed only when git ANSWERED that there is no such remote —
 * exit code 2, the same signal `probeOriginRemote` reads, and the only one
 * that survives a localised git. Everything else (git not installed, a `cwd`
 * that is not a repo or cannot be read, a timeout) is `null`: "I could not
 * ask". Collapsing those into `false` is how a repo that HAS an origin got
 * refused with "no origin remote is configured for this repo" the moment git
 * went missing — the exact "right decision, wrong announcement" mistake this
 * module writes down and then made.
 *
 * A remote whose URL is blank is `false`, not `null`: git answered, and the
 * answer is nothing to push to. `probeOriginRemote` says the same, so the
 * header and the refusal cannot disagree about one repo.
 */
async function originRemote(execGit: ShipGitExecFn, cwd: string): Promise<boolean | null> {
  const outcome = await execGit(['remote', 'get-url', 'origin'], cwd)
  if (outcome.kind === 'ok') {
    return outcome.stdout.trim() !== ''
  }
  return outcome.kind === 'error' && outcome.status === GIT_NO_SUCH_REMOTE ? false : null
}

/**
 * Does this push failure mean the remote host was never reached?
 *
 * The list is SHORT on purpose, and every entry is a phrase libcurl or
 * OpenSSH prints — never one of git's own. That is what makes them usable:
 * git translates its own wrapper (`fatal: unable to access …` comes out
 * `fatal: impossible d'accéder à …` on a French box, measured on git 2.53.0)
 * while the library's half stays in English whatever the locale is. A rule
 * written on git's wrapper would code a failure in one language and nothing
 * at all in another.
 *
 * Deliberately NOT in the list, each for a measured reason:
 *
 *  - `unable to access` — the wrapper libcurl's message hangs off. It also
 *    wraps `The requested URL returned error: 403` (measured against a local
 *    403), and a forge that ANSWERED 403 refused us, it was not unreachable.
 *    `forge_unreachable` is a RETRYABLE code: pinning it on a permission
 *    problem tells a machine to keep trying something that will never work.
 *  - `Could not read from remote repository` — ssh's epilogue, printed just
 *    as much for a rejected key as for a dead network.
 *  - a rejected push (non-fast-forward, a hook, a protected branch) carries
 *    none of these and stays UNCODED, which is the point of a short list: a
 *    wrong code is worse than no code, because D2 is what a resume decision
 *    is made on.
 */
const TRANSPORT_FAILURES: readonly string[] = [
  // libcurl "Could not resolve host: <h>", and ssh's "Could not resolve
  // hostname <h>: <why>" by the same prefix. Both measured.
  'could not resolve host',
  // libcurl "Failed to connect to <h> port <p> after <n> ms: <why>" — which
  // is also where an ENETUNREACH surfaces on the https transport. Measured.
  'failed to connect to',
  // ssh "connect to host <h> port <p>: Connection refused". Measured.
  'connection refused',
  // Both transports print exactly this. Measured on ssh.
  'connection timed out',
]

function transportFailure(message: string): boolean {
  const said = message.toLowerCase()
  return TRANSPORT_FAILURES.some((phrase) => said.includes(phrase))
}

/**
 * Push + MR creation. The push is the gate: if it fails, nothing shipped and
 * the caller keeps the task status unchanged. Past the push, every outcome is
 * a successful ship — mrUrl null with an explanatory note when no forge CLI
 * could open the MR (not installed, no matching remote, tool error).
 */
export async function shipTask(opts: ShipTaskOptions): Promise<ShipOutcome> {
  const execGit = opts.execGit ?? defaultExecGit
  // D9 (degraded-mode.ts): no remote, no ship — REFUSED, and named. Without
  // this gate the push still failed, but with git's own words and no
  // `reason_code` at all: the one degradation D9 is most about ("a repo with
  // no remote") was the one the product could not name. Checked before the
  // push rather than after, so the refusal is not a network error message.
  //
  // `null` — could not ask — deliberately falls THROUGH to the push instead
  // of refusing: we have nothing honest to announce, so we let the push
  // happen and git's own words be the answer. That is also what keeps the
  // "git not found" branch below reachable.
  if ((await originRemote(execGit, opts.cwd)) === false) {
    return {
      pushed: false,
      error: SHIP_NO_REMOTE_ERROR,
      reasonCode: 'forge_unreachable',
      detail: 'no-remote',
    }
  }
  const push = await execGit(['push', '-u', 'origin', opts.task.branch], opts.cwd)
  if (push.kind === 'missing') {
    return { pushed: false, error: 'git push failed: git not found' }
  }
  if (push.kind === 'error') {
    const error = `git push failed: ${push.message}`
    // D9's third motif, and the most common of the three: the repo has a
    // remote and a forge CLI, and the machine simply cannot reach the host.
    // The push dies before any forge is asked anything, so nothing else in
    // this file would ever have named it. Everything the short list above
    // does not recognise stays uncoded, on purpose.
    return transportFailure(push.message)
      ? { pushed: false, error, reasonCode: 'forge_unreachable', detail: 'offline' }
      : { pushed: false, error }
  }
  return createMr(opts, opts.execForge ?? defaultExecForge)
}
