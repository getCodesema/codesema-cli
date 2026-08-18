// Ship (T5): the "Confirm complete" gesture of a task. Pushes the task branch
// to origin from the MAIN repo (branch refs are shared with the worktree, so
// the worktree can stay untouched — or already be gone) and opens the MR/PR
// through the forge CLI the user already has: gh or glab, picked with the same
// origin-hint rule as the MR list (forge-mrs.ts). A missing forge CLI degrades
// the ship to "push only" instead of failing it: the push DID succeed, the MR
// is one manual step away, and the note says so explicitly.

import { execFile } from 'node:child_process'
import { sanitizeRecord, type ReviewRecord, type TaskRecord } from './contract.js'
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
  { kind: 'ok'; stdout: string } | { kind: 'missing' } | { kind: 'error'; message: string }

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
          resolve({ kind: 'error', message })
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

export type ShipOutcome =
  { pushed: true; mrUrl: string | null; note: string | null } | { pushed: false; error: string }

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
  return {
    pushed: true,
    mrUrl: null,
    note:
      note ??
      'no forge CLI (gh or glab) available — branch pushed, open the merge request manually',
  }
}

/**
 * Push + MR creation. The push is the gate: if it fails, nothing shipped and
 * the caller keeps the task status unchanged. Past the push, every outcome is
 * a successful ship — mrUrl null with an explanatory note when no forge CLI
 * could open the MR (not installed, no matching remote, tool error).
 */
export async function shipTask(opts: ShipTaskOptions): Promise<ShipOutcome> {
  const execGit = opts.execGit ?? defaultExecGit
  const push = await execGit(['push', '-u', 'origin', opts.task.branch], opts.cwd)
  if (push.kind === 'missing') {
    return { pushed: false, error: 'git push failed: git not found' }
  }
  if (push.kind === 'error') {
    return { pushed: false, error: `git push failed: ${push.message}` }
  }
  return createMr(opts, opts.execForge ?? defaultExecForge)
}
