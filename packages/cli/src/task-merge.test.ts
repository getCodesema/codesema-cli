import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { DEFAULT_MERGE_SETTINGS, saveRepoConfig, type MergeSettings } from './config.js'
import {
  acceptanceCriterionId,
  type AcceptanceCriterion,
  type CriterionVerdict,
  type Finding,
  type ReviewRecord,
  type TaskChecks,
  type TaskRecord,
  type Verdict,
} from './contract.js'
import { PROBE_TIMEOUT_MS } from './git.js'
import {
  branchAncestry,
  criteriaDraftProposed,
  effectiveMergePolicyIsAuto,
  isMergeConflictError,
  MERGE_GIT_TIMEOUT_MS,
  mergeReadiness,
  mergeTask,
  type BranchAncestry,
  type MergeCondition,
  type MergeInputs,
} from './task-merge.js'
import { checksBlockReady } from './task-review.js'
import type { ShipCliOutcome, ShipForgeExecFn } from './task-ship.js'
import { appendTaskEvent } from './tasks-store.js'

// --- rig ------------------------------------------------------------------

const cleanups: string[] = []

afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codesema-task-merge-'))
  cleanups.push(dir)
  return dir
}

/** Real git repo whose origin URL steers detectForgeHint (no network, no CLI). */
function makeRepoWithOrigin(url: string): string {
  const repo = makeDir()
  const run = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  run(['init', '-b', 'main'])
  run(['config', 'user.email', 'dev@example.test'])
  run(['config', 'user.name', 'Dev'])
  run(['remote', 'add', 'origin', url])
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  run(['add', '.'])
  run(['commit', '-m', 'base'])
  return repo
}

const git = (repo: string, args: string[]): string =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trimEnd()

const CRITERIA_TEXTS = [
  'WHEN the user submits a valid payload THE SYSTEM SHALL persist the rate limit',
  'WHEN the bucket is empty THE SYSTEM SHALL reject the request',
] as const

const sampleCriteria = (): AcceptanceCriterion[] =>
  CRITERIA_TEXTS.map((text) => ({ id: acceptanceCriterionId(text), text }))

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const now = new Date().toISOString()
  return {
    version: 1,
    id: 'abcdef123456',
    title: 'Add rate limiting',
    status: 'shipped',
    base: 'origin/main',
    branch: 'codesema/task-add-rate-limiting',
    worktree: '/nowhere/worktree',
    agent_session_id: null,
    turns: [],
    review_ref: null,
    work_ms: 0,
    wait_ms: 0,
    auto_ship: true,
    work_on: false,
    isolation: 'policy',
    created_at: now,
    updated_at: now,
    ...overrides,
  }
}

function makeReview(
  verdict: Verdict = 'approve',
  findings: Finding[] = [],
  criteria?: CriterionVerdict[],
): ReviewRecord {
  return {
    version: 1,
    meta: {
      title: 'task review',
      branch: 'codesema/task-add-rate-limiting',
      target: 'main',
      merge_base: 'abc',
      repo_root: '/nowhere',
      created_at: new Date().toISOString(),
    },
    commits: [],
    diff: '',
    review: {
      verdict,
      summary: 'summary',
      findings,
      narrative: null,
      ...(criteria ? { criteria } : {}),
    },
  }
}

const finding = (severity: Finding['severity'], kind: Finding['kind'] = 'design'): Finding => ({
  file: 'src/a.ts',
  line: 1,
  severity,
  kind,
  title: 'x',
  message: 'y',
})

function makeChecks(over: Partial<TaskChecks> = {}): TaskChecks {
  return {
    head_sha: 'abc',
    started_at: '2026-08-21T10:00:00.000Z',
    finished_at: '2026-08-21T10:01:00.000Z',
    status: 'passed',
    checks: [{ command: 'bun test', status: 'passed', exit_code: 0, duration_ms: 5, tail: '' }],
    error: null,
    ...over,
  }
}

const upToDate: BranchAncestry = { kind: 'up_to_date', target: 'origin/main' }

/** Every sample criterion judged `met`, so a test can vary ONE thing at a time. */
const metVerdicts = (): CriterionVerdict[] =>
  sampleCriteria().map((criterion) => ({ criterion_id: criterion.id, status: 'met' as const }))

/** Everything green, so a test can knock exactly one condition out. */
function greenInputs(over: Partial<MergeInputs> = {}): MergeInputs {
  return {
    review: makeReview('approve', [], metVerdicts()),
    checks: makeChecks(),
    criteriaDraftProposed: false,
    ancestry: upToDate,
    ...over,
  }
}

const greenTask = (over: Partial<TaskRecord> = {}): TaskRecord =>
  makeTask({ criteria: sampleCriteria(), review_ref: '/nowhere/review.json', ...over })

const settings = (over: Partial<MergeSettings> = {}): MergeSettings => ({
  ...DEFAULT_MERGE_SETTINGS,
  ...over,
})

const condition = (readiness: { conditions: MergeCondition[] }, id: string): MergeCondition =>
  readiness.conditions.find((entry) => entry.id === id) as MergeCondition

/** A forge exec seam that records the argv and answers whatever it is told to. */
function recordingForge(answer: ShipCliOutcome = { kind: 'ok', stdout: '' }): {
  exec: ShipForgeExecFn
  calls: { cli: string; args: string[] }[]
} {
  const calls: { cli: string; args: string[] }[] = []
  return {
    calls,
    exec: (cli, args) => {
      calls.push({ cli, args })
      return Promise.resolve(answer)
    },
  }
}

// --- the conjunction itself ------------------------------------------------

describe('mergeReadiness: the four conditions of D12', () => {
  test('all four satisfied is the only ready state, and it names no blocker', () => {
    const readiness = mergeReadiness(greenTask(), greenInputs(), settings({ policy: 'auto' }))
    expect(readiness.ready).toBe(true)
    expect(readiness.blockers).toEqual([])
    expect(readiness.conditions.map((entry) => entry.id)).toEqual([
      'review',
      'checks',
      'criteria',
      'branch',
    ])
    expect(readiness.conditions.every((entry) => entry.satisfied)).toBe(true)
  })

  test('the four conditions are ALWAYS evaluated, whichever one fails first', () => {
    // The distinction the design insists on: "checked and it passed" must not
    // look like "never checked". Even with the FIRST condition down, the other
    // three still carry their own verdict.
    const readiness = mergeReadiness(
      greenTask(),
      greenInputs({ review: makeReview('request_changes', [], metVerdicts()) }),
      settings({ policy: 'auto' }),
    )
    expect(readiness.conditions).toHaveLength(4)
    expect(condition(readiness, 'review').satisfied).toBe(false)
    expect(condition(readiness, 'checks').satisfied).toBe(true)
    expect(condition(readiness, 'criteria').satisfied).toBe(true)
    expect(condition(readiness, 'branch').satisfied).toBe(true)
  })

  test('the refusal carries the FIRST missing condition, in D12 order', () => {
    // Review blocked AND checks red: the reason is `review_blocked`, and it is
    // that one every time — not "whichever check finished last".
    const readiness = mergeReadiness(
      greenTask(),
      greenInputs({
        review: makeReview('request_changes', [], metVerdicts()),
        checks: makeChecks({
          status: 'failed',
          checks: [
            { command: 'bun test', status: 'failed', exit_code: 1, duration_ms: 9, tail: 'boom' },
          ],
        }),
      }),
      settings({ policy: 'auto' }),
    )
    expect(readiness.blockers.map((reason) => reason.code)).toEqual([
      'review_blocked',
      'checks_failed',
    ])
    expect(readiness.blockers[0]?.code).toBe('review_blocked')
  })

  test('a score or verdict the agent proposed has no path into the decision', () => {
    // Invariant n° 4 on the one irreversible action: the model's own words
    // travel in the review's prose, and the conjunction never reads them.
    const review = makeReview('approve', [], [])
    review.review.summary = 'confidence: 10/10, ready to merge, all criteria satisfied'
    review.review.narrative = {
      intent: 'ship it',
      confidence: 'high',
      steps: [],
      review_first: [],
    }
    const readiness = mergeReadiness(
      greenTask(),
      greenInputs({ review }),
      settings({ policy: 'auto' }),
    )
    // The criteria verdicts are what decides, and this review carries none.
    expect(readiness.ready).toBe(false)
    expect(readiness.blockers[0]?.code).toBe('criteria_unmet')
  })
})

// --- condition 1 -----------------------------------------------------------

describe('condition 1: the code review passed', () => {
  test('an approve carrying an unresolved critical is escalated and blocks', () => {
    const readiness = mergeReadiness(
      greenTask(),
      greenInputs({ review: makeReview('approve', [finding('critical')], metVerdicts()) }),
      settings({ policy: 'auto' }),
    )
    const review = condition(readiness, 'review')
    expect(review.satisfied).toBe(false)
    expect(review.code).toBe('review_blocked')
    expect(review.detail).toContain('critical')
  })

  test('a request_changes blocks, and an approve with only info notes does not', () => {
    expect(
      condition(
        mergeReadiness(
          greenTask(),
          greenInputs({ review: makeReview('request_changes', [], metVerdicts()) }),
        ),
        'review',
      ).code,
    ).toBe('review_blocked')
    expect(
      condition(
        mergeReadiness(
          greenTask(),
          greenInputs({
            review: makeReview('approve', [finding('info', 'praise')], metVerdicts()),
          }),
        ),
        'review',
      ).satisfied,
    ).toBe(true)
  })

  test('no archived review at all blocks, and says THAT rather than a verdict', () => {
    const review = condition(mergeReadiness(greenTask(), greenInputs({ review: null })), 'review')
    expect(review.code).toBe('review_blocked')
    expect(review.detail).toContain('no end-of-turn review is archived')
  })
})

// --- condition 2 (DP1) -----------------------------------------------------

describe('condition 2: checks green, strictly (DP1)', () => {
  const checksOf = (inputs: Partial<MergeInputs>, over: Partial<MergeSettings> = {}) =>
    condition(mergeReadiness(greenTask(), greenInputs(inputs), settings(over)), 'checks')

  test('passed is the only satisfying status', () => {
    expect(checksOf({ checks: makeChecks() }).satisfied).toBe(true)
  })

  test('failed is checks_failed, never checks_unavailable', () => {
    const checks = checksOf({
      checks: makeChecks({
        status: 'failed',
        checks: [
          { command: 'bun test', status: 'failed', exit_code: 1, duration_ms: 4, tail: 'x' },
        ],
      }),
    })
    expect(checks.code).toBe('checks_failed')
    expect(checks.detail).toContain('bun test')
  })

  test('an individual timeout is checks_failed even on a run labelled passed', () => {
    // `runChecks` already folds a timeout into `failed`; this is the defensive
    // read of an older or hand-edited snapshot, and it must not slip through as
    // "unavailable" — the condition WAS evaluated, and it lost.
    const checks = checksOf({
      checks: makeChecks({
        status: 'passed',
        checks: [
          { command: 'bun test', status: 'timeout', exit_code: null, duration_ms: 99, tail: '' },
        ],
      }),
    })
    expect(checks.code).toBe('checks_failed')
    expect(checks.discriminant).toBeUndefined()
  })

  test('unconfigured with the valve shut is checks_unavailable/unconfigured', () => {
    const checks = checksOf({ checks: makeChecks({ status: 'unconfigured', checks: [] }) })
    expect(checks.code).toBe('checks_unavailable')
    expect(checks.discriminant).toBe('unconfigured')
    expect(checks.satisfied).toBe(false)
  })

  test('unconfigured with the valve open is satisfied BY CONSENT, and says so', () => {
    const checks = checksOf(
      { checks: makeChecks({ status: 'unconfigured', checks: [] }) },
      { allowMergeWithoutChecks: true },
    )
    expect(checks.satisfied).toBe(true)
    expect(checks.consented).toBe(true)
    expect(checks.code).toBeUndefined()
    expect(checks.detail).toContain('consent')
  })

  test('error is checks_unavailable/runtime_error EVEN with the valve open', () => {
    for (const allow of [false, true]) {
      const checks = checksOf(
        { checks: makeChecks({ status: 'error', checks: [], error: 'no container runtime' }) },
        { allowMergeWithoutChecks: allow },
      )
      expect(checks.satisfied).toBe(false)
      expect(checks.code).toBe('checks_unavailable')
      expect(checks.discriminant).toBe('runtime_error')
      expect(checks.consented).toBeUndefined()
    }
  })

  test('no run at all is unavailable too, and the valve never covers it either', () => {
    for (const allow of [false, true]) {
      const checks = checksOf({ checks: null }, { allowMergeWithoutChecks: allow })
      expect(checks.code).toBe('checks_unavailable')
      expect(checks.discriminant).toBe('no_run')
    }
    expect(checksOf({ checks: makeChecks({ status: 'running' }) }).discriminant).toBe('no_run')
  })

  test('the refusal names the way out, and offers the valve ONLY for unconfigured', () => {
    const unconfigured = checksOf({ checks: makeChecks({ status: 'unconfigured', checks: [] }) })
    expect(unconfigured.detail).toContain('configure checks')
    expect(unconfigured.detail).toContain("mergePolicy to 'human'")
    expect(unconfigured.detail).toContain('allowMergeWithoutChecks')

    const broken = checksOf({ checks: makeChecks({ status: 'error', checks: [], error: 'nope' }) })
    expect(broken.detail).toContain("mergePolicy to 'human'")
    // Not even mentioned to be ruled out: a refusal is read for what to DO,
    // and printing the one key that looks like a fix is how it gets reached for.
    expect(broken.detail).not.toContain('allowMergeWithoutChecks')
    expect(broken.detail).toContain('nope')
  })
})

describe('the ready ✓ / auto-merge ✗ asymmetry is deliberate (DP1, non-regression of T3.1)', () => {
  // Both halves in ONE assertion, because the whole point of DP1 is that they
  // disagree ON PURPOSE: T3.1 decides what a HUMAN is shown ("ready to
  // merge"), T3.6 decides an irreversible ACTION. Folding either into the
  // other — making `checksBlockReady` block on these, or making the merge
  // accept them — is a single-line change nothing else in the repo would
  // notice.
  test('unconfigured and error stay non-blocking for "ready", and block the auto-merge', () => {
    for (const status of ['unconfigured', 'error'] as const) {
      const checks = makeChecks({ status, checks: [], error: 'no container runtime' })
      // T3.1's bar, imported unchanged: still not a red run.
      expect(checksBlockReady(checks)).toBe(false)
      // T3.6's bar: not evaluable, so not merged — and never under the code
      // that would claim the checks failed.
      const entry = condition(mergeReadiness(greenTask(), greenInputs({ checks })), 'checks')
      expect(entry.satisfied).toBe(false)
      expect(entry.code).toBe('checks_unavailable')
      expect(entry.code).not.toBe('checks_failed')
    }
  })

  test('a red run blocks BOTH, under the same code', () => {
    const checks = makeChecks({
      status: 'failed',
      checks: [{ command: 'bun test', status: 'failed', exit_code: 1, duration_ms: 3, tail: '' }],
    })
    expect(checksBlockReady(checks)).toBe(true)
    expect(condition(mergeReadiness(greenTask(), greenInputs({ checks })), 'checks').code).toBe(
      'checks_failed',
    )
  })
})

// --- condition 3 (DP2) -----------------------------------------------------

describe('condition 3: criteria satisfied, and present (DP2)', () => {
  const criteriaOf = (task: TaskRecord, inputs: Partial<MergeInputs> = {}) =>
    condition(mergeReadiness(task, greenInputs(inputs)), 'criteria')

  test('every criterion met satisfies the condition', () => {
    expect(criteriaOf(greenTask()).satisfied).toBe(true)
  })

  test('one criterion unmet is criteria_unmet, and names it', () => {
    const criteria = sampleCriteria()
    const entry = criteriaOf(greenTask(), {
      review: makeReview(
        'approve',
        [],
        [
          { criterion_id: criteria[0]!.id, status: 'met' },
          { criterion_id: criteria[1]!.id, status: 'unmet' },
        ],
      ),
    })
    expect(entry.code).toBe('criteria_unmet')
    expect(entry.detail).toContain(criteria[1]!.id)
    expect(entry.detail).toContain('1 of 2')
  })

  test('a settled unclear no longer satisfies the merge condition (D26)', () => {
    // D18 (task-review.ts) still SHIPS this task — a sincere unclear is not a
    // failure. But the AUTOMATIC merge is a different gate: nobody judged it
    // but the model, and D26 refuses until a human does, by merging the
    // branch itself.
    const criteria = sampleCriteria()
    const entry = criteriaOf(greenTask(), {
      review: makeReview(
        'approve',
        [],
        [
          { criterion_id: criteria[0]!.id, status: 'met' },
          {
            criterion_id: criteria[1]!.id,
            status: 'unclear',
            question: 'does this match the sibling helper?',
          },
        ],
      ),
    })
    expect(entry.satisfied).toBe(false)
    expect(entry.code).toBe('criteria_judgment_open')
    expect(entry.detail).toContain(criteria[1]!.id)
    expect(entry.detail).toContain('1 of 2')
    expect(entry.detail).toContain('To decide')
    // Plain language, no jargon (product rule): never the raw status word.
    expect(entry.detail).not.toContain('unclear')
  })

  test('an unmet criterion still outranks an open judgment call on the SAME task', () => {
    // The two D26 conditions are checked in order: real work first. A task
    // with both an unmet criterion and an open judgment call is refused for
    // the unmet one — fixing it is always possible, deciding a judgment call
    // by merging is not what an agent should be nudged toward.
    const criteria = sampleCriteria()
    const entry = criteriaOf(greenTask(), {
      review: makeReview(
        'approve',
        [],
        [
          { criterion_id: criteria[0]!.id, status: 'unmet' },
          { criterion_id: criteria[1]!.id, status: 'unclear' },
        ],
      ),
    })
    expect(entry.code).toBe('criteria_unmet')
  })

  test('a criterion the archive never judged counts as unclear, never as met', () => {
    const criteria = sampleCriteria()
    const entry = criteriaOf(greenTask(), {
      review: makeReview('approve', [], [{ criterion_id: criteria[0]!.id, status: 'met' }]),
    })
    expect(entry.code).toBe('criteria_unmet')
    expect(entry.detail).toContain('unclear')
  })

  test('no criterion ever written is criteria_missing/absent, NEVER criteria_unmet', () => {
    const entry = criteriaOf(makeTask({ review_ref: '/nowhere/review.json' }))
    expect(entry.code).toBe('criteria_missing')
    expect(entry.discriminant).toBe('absent')
    expect(entry.detail).toContain('no acceptance criterion was ever written')
  })

  test('a proposed but unvalidated draft is criteria_missing/pending_validation', () => {
    const entry = criteriaOf(makeTask({ review_ref: '/nowhere/review.json' }), {
      criteriaDraftProposed: true,
    })
    expect(entry.code).toBe('criteria_missing')
    expect(entry.discriminant).toBe('pending_validation')
    expect(entry.detail).toContain('never validated')
  })

  test('a ticket-bound task is judged on its issue snapshot, like the T3.2 gate is', () => {
    // `taskCriteria` — the same function the gate judges against — falls back
    // to the frozen ticket snapshot. Reading `record.criteria` alone would
    // refuse to merge a ticket whose every criterion the gate marked met.
    const criteria = sampleCriteria()
    const task = makeTask({
      review_ref: '/nowhere/review.json',
      issue_snapshot: {
        body_hash: 'sha256:t2:abc',
        criteria,
        taken_at: new Date().toISOString(),
      },
    })
    expect(criteriaOf(task).satisfied).toBe(true)
  })
})

// --- condition 4 -----------------------------------------------------------

describe('condition 4: the branch is up to date with its target', () => {
  test('a branch whose target is an ancestor of its tip is up to date', () => {
    const repo = makeRepoWithOrigin('git@github.com:o/r.git')
    execFileSync('git', ['checkout', '-b', 'feat/x'], { cwd: repo, stdio: 'ignore' })
    writeFileSync(join(repo, 'b.txt'), 'b\n')
    execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['commit', '-m', 'work'], { cwd: repo, stdio: 'ignore' })
    const ancestry = branchAncestry(repo, makeTask({ base: 'main', branch: 'feat/x' }))
    expect(ancestry).toEqual({ kind: 'up_to_date', target: 'main' })
    expect(
      condition(mergeReadiness(greenTask(), greenInputs({ ancestry })), 'branch').satisfied,
    ).toBe(true)
  })

  test('a target that moved on leaves the branch behind, and it is a LOCAL read', () => {
    const repo = makeRepoWithOrigin('git@github.com:o/r.git')
    execFileSync('git', ['checkout', '-b', 'feat/x'], { cwd: repo, stdio: 'ignore' })
    writeFileSync(join(repo, 'b.txt'), 'b\n')
    execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['commit', '-m', 'work'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['checkout', 'main'], { cwd: repo, stdio: 'ignore' })
    writeFileSync(join(repo, 'c.txt'), 'c\n')
    execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['commit', '-m', 'target moved'], { cwd: repo, stdio: 'ignore' })

    const ancestry = branchAncestry(repo, makeTask({ base: 'main', branch: 'feat/x' }))
    expect(ancestry.kind).toBe('behind')
    const entry = condition(mergeReadiness(greenTask(), greenInputs({ ancestry })), 'branch')
    expect(entry.code).toBe('branch_diverged')
    expect(entry.detail).toContain('behind its target')
  })

  test('an unresolvable target says SO, it does not claim the branch is behind', () => {
    const repo = makeRepoWithOrigin('git@github.com:o/r.git')
    const ancestry = branchAncestry(repo, makeTask({ base: 'nope/gone', branch: 'main' }))
    expect(ancestry.kind).toBe('unresolved')
    const entry = condition(mergeReadiness(greenTask(), greenInputs({ ancestry })), 'branch')
    expect(entry.code).toBe('branch_diverged')
    expect(entry.detail).toContain('could not be compared')
    expect(entry.detail).not.toContain('behind its target')
  })

  test('a missing branch ref is unresolved too, never up to date', () => {
    const repo = makeRepoWithOrigin('git@github.com:o/r.git')
    const ancestry = branchAncestry(repo, makeTask({ base: 'main', branch: 'never/existed' }))
    expect(ancestry.kind).toBe('unresolved')
  })
})

// --- the reads cannot hang the workspace (adversarial review, MAJEUR 2) ----
//
// `branchAncestry` makes up to four `execFileSync` git calls, and
// `readMergeInputs` runs them BEFORE the merge policy is even read — so every
// auto-shipped turn pays them, under the default `mergePolicy: 'human'` too,
// inside the workspace process. `execFileSync` blocks that process whole: SSE,
// HTTP, every other project's turns, the event loop itself. Unbounded, a
// repository whose worktree sits on a suspended network mount freezes the
// workspace until the mount comes back — which for a dead mount is never.
// Measured before the fix: 18 s of freeze and ZERO event-loop ticks against a
// git that merely slept 6 s.
//
// `git.ts` states the doctrine and names this caller: `tryGit` carries no
// default bound because the repository's own commits and pushes are
// legitimately slow, and "the callers that run UNATTENDED and can hang on
// something outside git itself … set it explicitly".
//
// The proof needs a git that really hangs, so it runs in a CHILD process with
// a shim first on PATH — never by mutating this process's own PATH, which
// would leak into whatever else `bun test` is running beside this file.
describe("the merge gate's git reads are bounded (MAJEUR 2)", () => {
  /**
   * A `git` that answers everything instantly with exit 0, EXCEPT the one
   * call named by `CODESEMA_TEST_HANG`, which sleeps far past any bound.
   * `exec sleep` on purpose: the shell replaces itself with `sleep`, so the
   * SIGTERM `execFileSync`'s timeout sends reaches the process that is
   * actually sleeping and leaves no orphan behind.
   */
  function makeGitShim(): string {
    const dir = makeDir()
    const script = [
      '#!/bin/sh',
      // `git rev-parse --verify --quiet <ref>` — $4 is the ref.
      'if [ "$1" = "rev-parse" ] && [ "$CODESEMA_TEST_HANG" = "rev-parse" ]; then exec sleep 12; fi',
      'if [ "$1" = "rev-parse" ] && [ "$CODESEMA_TEST_HANG" = "$4" ]; then exec sleep 12; fi',
      'if [ "$1" = "merge-base" ] && [ "$CODESEMA_TEST_HANG" = "merge-base" ]; then exec sleep 12; fi',
      'if [ "$1" = "remote" ] && [ "$CODESEMA_TEST_HANG" = "remote" ]; then exec sleep 12; fi',
      'exit 0',
      '',
    ].join('\n')
    const path = join(dir, 'git')
    writeFileSync(path, script, { mode: 0o755 })
    return dir
  }

  /**
   * Runs `branchAncestry` in a child whose PATH starts with the shim, and
   * reports what it answered and how long it blocked. `timeoutMs` omitted
   * means the child takes the PRODUCTION default — which is what makes the
   * default itself provable.
   */
  async function ancestryAgainstHangingGit(
    hang: string,
    timeoutMs?: number,
  ): Promise<{ elapsedMs: number; ancestry: BranchAncestry }> {
    const shim = makeGitShim()
    // A real directory: `execFileSync` fails instantly on a `cwd` that does
    // not exist, which would make every one of these tests pass without ever
    // reaching the shim.
    const cwd = makeDir()
    const record = makeTask({ base: 'main', branch: 'feat/x' })
    const modulePath = join(import.meta.dir, 'task-merge.ts')
    const script = [
      `const { branchAncestry } = await import(${JSON.stringify(modulePath)})`,
      `const record = ${JSON.stringify(record)}`,
      `const started = Date.now()`,
      `const ancestry = branchAncestry(${JSON.stringify(cwd)}, record${
        timeoutMs === undefined ? '' : `, ${timeoutMs}`
      })`,
      `process.stdout.write(JSON.stringify({ elapsedMs: Date.now() - started, ancestry }))`,
    ].join('\n')
    const child = Bun.spawn([process.execPath, '-e', script], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, PATH: `${shim}:${process.env.PATH ?? ''}`, CODESEMA_TEST_HANG: hang },
    })
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    await child.exited
    if (!stdout.trim()) {
      throw new Error(`the child produced nothing: ${stderr}`)
    }
    return JSON.parse(stdout) as { elapsedMs: number; ancestry: BranchAncestry }
  }

  // Not a magic number in the module: the value is the promise, and it is
  // tighter than PROBE_TIMEOUT_MS on purpose (these are local ref reads, not
  // an external CLI spawn).
  test('the budget is a named, tight constant', () => {
    expect(MERGE_GIT_TIMEOUT_MS).toBe(5000)
    expect(MERGE_GIT_TIMEOUT_MS).toBeLessThan(PROBE_TIMEOUT_MS)
  })

  // The mutation this kills: dropping `bounded()` from the target-ref lookup.
  // Unbounded, the three candidate reads sit for 36 s against this shim.
  test('a target ref that never answers gives up, it does not wait', async () => {
    const { elapsedMs, ancestry } = await ancestryAgainstHangingGit('rev-parse', 300)
    expect(ancestry.kind).toBe('unresolved')
    // The TOTAL budget, not three of them: the three candidates share one
    // deadline, so a mount answering nothing costs one bound, not one each.
    expect(elapsedMs).toBeLessThan(3000)
  }, 60_000)

  // The mutation this kills: dropping `bounded()` from the branch-ref read.
  test('a branch ref that never answers gives up too', async () => {
    const { elapsedMs, ancestry } = await ancestryAgainstHangingGit('feat/x', 300)
    expect(ancestry.kind).toBe('unresolved')
    expect(elapsedMs).toBeLessThan(3000)
  }, 60_000)

  // The mutation this kills: dropping `bounded()` from the ancestry read —
  // the ONE call that is not a ref lookup, and the one that walks commits.
  test('an ancestry test that never answers gives up, and refuses cautiously', async () => {
    const { elapsedMs, ancestry } = await ancestryAgainstHangingGit('merge-base', 300)
    // A read that could not answer is never read as "up to date": the gate
    // refuses, which is the safe side of this decision.
    expect(ancestry.kind).toBe('behind')
    expect(elapsedMs).toBeLessThan(3000)
  }, 60_000)

  // The forge-hint read is bounded too, and it is an ASSUMED WIDENING rather
  // than part of the finding: `detectForgeHint` was already unbounded on the
  // ship's own path before this ticket. It runs here from the same workspace
  // process, on the same repository, one step after the three reads above —
  // leaving it alone would have moved the freeze rather than closed it.
  //
  // The mutation this kills: dropping the `{ timeoutMs: … }` from
  // `mergeCandidates`'s `detectForgeHint` call. Every other test in this file
  // injects `inputs` AND `execForge`, so nothing else makes this call at all.
  test('the forge-hint read is bounded as well', async () => {
    const shim = makeGitShim()
    const cwd = makeDir()
    const modulePath = join(import.meta.dir, 'task-merge.ts')
    const script = [
      `const { mergeTask } = await import(${JSON.stringify(modulePath)})`,
      `const started = Date.now()`,
      `const outcome = await mergeTask({`,
      `  cwd: ${JSON.stringify(cwd)},`,
      `  runnerAutoMerge: true,`,
      `  task: ${JSON.stringify(greenTask())},`,
      `  settings: ${JSON.stringify(settings({ policy: 'auto', strategy: 'merge' }))},`,
      // Injected: this test is about the ONE git read left on this path.
      `  inputs: ${JSON.stringify(greenInputs())},`,
      `  execForge: () => Promise.resolve({ kind: 'ok', stdout: 'https://forge/mr/1' }),`,
      `})`,
      `process.stdout.write(JSON.stringify({ elapsedMs: Date.now() - started, kind: outcome.kind }))`,
    ].join('\n')
    const child = Bun.spawn([process.execPath, '-e', script], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        PATH: `${shim}:${process.env.PATH ?? ''}`,
        CODESEMA_TEST_HANG: 'remote',
      },
    })
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    await child.exited
    if (!stdout.trim()) {
      throw new Error(`the child produced nothing: ${stderr}`)
    }
    const result = JSON.parse(stdout) as { elapsedMs: number; kind: string }
    // A hint that could not be read is 'unknown', which probes BOTH CLIs —
    // the cautious answer, and the merge still happens.
    expect(result.kind).toBe('merged')
    expect(result.elapsedMs).toBeLessThan(MERGE_GIT_TIMEOUT_MS + 4000)
  }, 60_000)

  // The mutation this kills: `timeoutMs: number = MERGE_GIT_TIMEOUT_MS` →
  // `timeoutMs?: number`, which leaves PRODUCTION unbounded while all three
  // tests above — every one of them injecting a bound — stay green. The
  // window is two-sided on purpose: it fails both for no bound at all (this
  // shim sleeps 12 s) and for a bound that is not the constant.
  test('production takes the bound WITHOUT being handed one', async () => {
    const { elapsedMs, ancestry } = await ancestryAgainstHangingGit('feat/x')
    expect(ancestry.kind).toBe('unresolved')
    expect(elapsedMs).toBeGreaterThanOrEqual(MERGE_GIT_TIMEOUT_MS - 500)
    expect(elapsedMs).toBeLessThan(MERGE_GIT_TIMEOUT_MS + 4000)
  }, 60_000)
})

// --- policy, argv and the merge itself ------------------------------------

describe('mergeTask under mergePolicy: human (the default)', () => {
  test('all four green: the conditions are journaled and NOTHING is called', async () => {
    const repo = makeRepoWithOrigin('git@github.com:o/r.git')
    const forge = recordingForge()
    const outcome = await mergeTask({
      runnerAutoMerge: true,
      cwd: repo,
      task: greenTask(),
      settings: settings(),
      inputs: greenInputs(),
      execForge: forge.exec,
    })
    expect(outcome.kind).toBe('held')
    expect(outcome.readiness.ready).toBe(true)
    expect(forge.calls).toEqual([])
    expect(outcome.events.map((event) => event.data.name)).toEqual([
      'condition_met',
      'condition_met',
      'condition_met',
      'condition_met',
      'policy_human',
    ])
  })

  test('a missing condition under human refuses nothing: it says what it saw', async () => {
    const repo = makeRepoWithOrigin('git@github.com:o/r.git')
    const forge = recordingForge()
    const outcome = await mergeTask({
      runnerAutoMerge: true,
      cwd: repo,
      task: greenTask(),
      settings: settings(),
      inputs: greenInputs({ review: makeReview('request_changes', [], metVerdicts()) }),
      execForge: forge.exec,
    })
    expect(outcome.kind).toBe('held')
    expect(forge.calls).toEqual([])
    expect(outcome.events.at(-1)?.data).toMatchObject({ name: 'policy_human', ready: false })
  })
})

describe('mergeTask under mergePolicy: auto', () => {
  const auto = (over: Partial<MergeSettings> = {}) =>
    settings({ policy: 'auto', strategy: 'merge', ...over })

  test('four green conditions call gh pr merge with the expected argv', async () => {
    const repo = makeRepoWithOrigin('git@github.com:o/r.git')
    const forge = recordingForge({ kind: 'ok', stdout: 'Merged pull request #7' })
    const outcome = await mergeTask({
      runnerAutoMerge: true,
      cwd: repo,
      task: greenTask(),
      settings: auto(),
      inputs: greenInputs(),
      execForge: forge.exec,
    })
    expect(outcome.kind).toBe('merged')
    expect(forge.calls).toEqual([
      { cli: 'gh', args: ['pr', 'merge', 'codesema/task-add-rate-limiting', '--merge'] },
    ])
    expect(outcome.events.at(-1)?.data).toMatchObject({ name: 'merged', cli: 'gh' })
  })

  test('a gitlab origin drives glab, non-interactively and without deferred merging', async () => {
    const repo = makeRepoWithOrigin('git@gitlab.com:o/r.git')
    const forge = recordingForge({ kind: 'ok', stdout: '' })
    await mergeTask({
      runnerAutoMerge: true,
      cwd: repo,
      task: greenTask(),
      settings: auto(),
      inputs: greenInputs(),
      execForge: forge.exec,
    })
    expect(forge.calls).toEqual([
      {
        cli: 'glab',
        args: ['mr', 'merge', 'codesema/task-add-rate-limiting', '--auto-merge=false', '--yes'],
      },
    ])
  })

  test('no mergeStrategy refuses the auto-merge BEFORE any forge call, with the way out', async () => {
    const repo = makeRepoWithOrigin('git@github.com:o/r.git')
    const forge = recordingForge()
    const outcome = await mergeTask({
      runnerAutoMerge: true,
      cwd: repo,
      task: greenTask(),
      settings: settings({ policy: 'auto' }),
      inputs: greenInputs(),
      execForge: forge.exec,
    })
    expect(outcome.kind).toBe('refused')
    expect(outcome.kind === 'refused' && outcome.reason.code).toBe('merge_strategy_unconfigured')
    expect(outcome.kind === 'refused' && outcome.reason.detail).toContain('mergeStrategy')
    expect(forge.calls).toEqual([])
    expect(outcome.events.at(-1)?.data).toMatchObject({
      name: 'refused',
      message: expect.stringContaining('mergeStrategy'),
    })
  })

  test('an explicit strategy reaches the argv, per CLI', async () => {
    const gh = recordingForge()
    await mergeTask({
      runnerAutoMerge: true,
      cwd: makeRepoWithOrigin('git@github.com:o/r.git'),
      task: greenTask(),
      settings: auto({ strategy: 'squash' }),
      inputs: greenInputs(),
      execForge: gh.exec,
    })
    expect(gh.calls[0]?.args).toContain('--squash')

    const glab = recordingForge()
    await mergeTask({
      runnerAutoMerge: true,
      cwd: makeRepoWithOrigin('git@gitlab.com:o/r.git'),
      task: greenTask(),
      settings: auto({ strategy: 'rebase' }),
      inputs: greenInputs(),
      execForge: glab.exec,
    })
    expect(glab.calls[0]?.args).toContain('--rebase')
  })

  test("glab has no merge-commit flag: 'merge' sends none rather than inventing one", async () => {
    const glab = recordingForge()
    await mergeTask({
      runnerAutoMerge: true,
      cwd: makeRepoWithOrigin('git@gitlab.com:o/r.git'),
      task: greenTask(),
      settings: auto({ strategy: 'merge' }),
      inputs: greenInputs(),
      execForge: glab.exec,
    })
    expect(glab.calls[0]?.args).toEqual([
      'mr',
      'merge',
      'codesema/task-add-rate-limiting',
      '--auto-merge=false',
      '--yes',
    ])
  })

  test('the branch is NOT deleted by default, and is on request', async () => {
    const kept = recordingForge()
    await mergeTask({
      runnerAutoMerge: true,
      cwd: makeRepoWithOrigin('git@github.com:o/r.git'),
      task: greenTask(),
      settings: auto(),
      inputs: greenInputs(),
      execForge: kept.exec,
    })
    expect(kept.calls[0]?.args).not.toContain('--delete-branch')

    const deleted = recordingForge()
    await mergeTask({
      runnerAutoMerge: true,
      cwd: makeRepoWithOrigin('git@github.com:o/r.git'),
      task: greenTask(),
      settings: auto({ deleteBranch: true }),
      inputs: greenInputs(),
      execForge: deleted.exec,
    })
    expect(deleted.calls[0]?.args).toContain('--delete-branch')
  })

  test('a ticketed merge reads the merge commit back: the proof travels on the journal', async () => {
    const answers: ShipCliOutcome[] = [
      { kind: 'ok', stdout: 'Merged pull request https://github.com/o/r/pull/7' },
      { kind: 'ok', stdout: JSON.stringify([{ number: 7, mergeCommit: { oid: 'A1B2C3D4E5F6' } }]) },
    ]
    const calls: { cli: string; args: string[] }[] = []
    const outcome = await mergeTask({
      runnerAutoMerge: true,
      cwd: makeRepoWithOrigin('git@github.com:o/r.git'),
      task: greenTask({ hub_ticket: { id: 'tkt-1', title: 'x' } }),
      settings: auto(),
      inputs: greenInputs(),
      execForge: (cli, args) => {
        calls.push({ cli, args })
        return Promise.resolve(answers[calls.length - 1] as ShipCliOutcome)
      },
    })
    expect(outcome.kind).toBe('merged')
    expect(calls[1]?.args).toContain('number,mergeCommit')
    const merged = outcome.events.find((event) => event.data.name === 'merged')
    expect(merged?.data.sha).toBe('a1b2c3d4e5f6')
    expect(outcome.events.some((event) => event.data.name === 'merged_sha_unknown')).toBe(false)
  })

  test('a landed merge whose commit cannot be read says merged_sha_unknown out loud', async () => {
    const forge = recordingForge({ kind: 'ok', stdout: 'Merged pull request #7' })
    const outcome = await mergeTask({
      runnerAutoMerge: true,
      cwd: makeRepoWithOrigin('git@github.com:o/r.git'),
      task: greenTask({ hub_ticket: { id: 'tkt-1', title: 'x' } }),
      settings: auto(),
      inputs: greenInputs(),
      execForge: forge.exec,
    })
    expect(outcome.kind).toBe('merged')
    const unknown = outcome.events.find((event) => event.data.name === 'merged_sha_unknown')
    expect(unknown?.data.message).toContain('webhook')
    const merged = outcome.events.find((event) => event.data.name === 'merged')
    expect(merged && 'sha' in merged.data).toBe(false)
  })

  test('a task with no hub_ticket never pays the proof read', async () => {
    const forge = recordingForge({ kind: 'ok', stdout: 'Merged pull request #7' })
    const outcome = await mergeTask({
      runnerAutoMerge: true,
      cwd: makeRepoWithOrigin('git@github.com:o/r.git'),
      task: greenTask(),
      settings: auto(),
      inputs: greenInputs(),
      execForge: forge.exec,
    })
    expect(outcome.kind).toBe('merged')
    expect(forge.calls).toHaveLength(1)
  })

  test('the merged report to the hub carries changed_files, computed from the ancestry target to the merge commit', async () => {
    const repo = makeRepoWithOrigin('git@github.com:o/r.git')
    const baseSha = git(repo, ['rev-parse', 'HEAD'])
    writeFileSync(join(repo, 'b.txt'), 'b\n')
    execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['commit', '-m', 'add b'], { cwd: repo, stdio: 'ignore' })
    const mergeSha = git(repo, ['rev-parse', 'HEAD'])

    const answers: ShipCliOutcome[] = [
      { kind: 'ok', stdout: 'Merged pull request https://github.com/o/r/pull/7' },
      { kind: 'ok', stdout: JSON.stringify([{ number: 7, mergeCommit: { oid: mergeSha } }]) },
    ]
    const calls: { cli: string; args: string[] }[] = []
    const reported: { type: string; changed_files?: string[] }[] = []
    const outcome = await mergeTask({
      runnerAutoMerge: true,
      cwd: repo,
      task: greenTask({ hub_ticket: { id: 'tkt-1', title: 'x' } }),
      settings: auto(),
      inputs: greenInputs({ ancestry: { kind: 'up_to_date', target: baseSha } }),
      execForge: (cli, args) => {
        calls.push({ cli, args })
        return Promise.resolve(answers[calls.length - 1] as ShipCliOutcome)
      },
      reportHub: async (_cwd, _record, transition) => {
        reported.push(transition as { type: string; changed_files?: string[] })
      },
    })
    expect(outcome.kind).toBe('merged')
    expect(reported).toHaveLength(1)
    expect(reported[0]?.type).toBe('merged')
    expect(reported[0]?.changed_files).toEqual(['b.txt'])
  })

  test('a git diff failure never blocks the merged report, only the changed_files field', async () => {
    const repo = makeRepoWithOrigin('git@github.com:o/r.git')
    const answers: ShipCliOutcome[] = [
      { kind: 'ok', stdout: 'Merged pull request https://github.com/o/r/pull/7' },
      { kind: 'ok', stdout: JSON.stringify([{ number: 7, mergeCommit: { oid: 'a1b2c3d4e5f6' } }]) },
    ]
    const calls: { cli: string; args: string[] }[] = []
    const reported: { type: string; changed_files?: string[] }[] = []
    const outcome = await mergeTask({
      runnerAutoMerge: true,
      cwd: repo,
      task: greenTask({ hub_ticket: { id: 'tkt-1', title: 'x' } }),
      settings: auto(),
      // Branch condition still holds (up_to_date), but the target names no
      // real ref in this repo, so the diff itself cannot run.
      inputs: greenInputs({ ancestry: { kind: 'up_to_date', target: 'not-a-real-ref' } }),
      execForge: (cli, args) => {
        calls.push({ cli, args })
        return Promise.resolve(answers[calls.length - 1] as ShipCliOutcome)
      },
      reportHub: async (_cwd, _record, transition) => {
        reported.push(transition as { type: string; changed_files?: string[] })
      },
    })
    expect(outcome.kind).toBe('merged')
    expect(reported).toHaveLength(1)
    expect(reported[0]?.type).toBe('merged')
    expect(reported[0] && 'changed_files' in reported[0]).toBe(false)
  })

  test('a missing condition emits NO merge command at all', async () => {
    for (const inputs of [
      { review: makeReview('request_changes', [], metVerdicts()) },
      { checks: makeChecks({ status: 'unconfigured', checks: [] }) },
      { checks: makeChecks({ status: 'error', checks: [], error: 'no runtime' }) },
      { ancestry: { kind: 'behind', target: 'origin/main' } as BranchAncestry },
    ]) {
      const forge = recordingForge()
      const outcome = await mergeTask({
        runnerAutoMerge: true,
        cwd: makeRepoWithOrigin('git@github.com:o/r.git'),
        task: greenTask(),
        settings: auto({ allowMergeWithoutChecks: false }),
        inputs: greenInputs(inputs),
        execForge: forge.exec,
      })
      expect(outcome.kind).toBe('refused')
      expect(forge.calls).toEqual([])
    }
  })

  test('two conditions missing: the refusal is the FIRST one, and it is stable', async () => {
    // `mergeReadiness` orders the blockers; THIS is the assertion that the
    // merge step then takes the head of that list rather than the tail — the
    // difference between a message that is reproducible for a given task and
    // one that depends on which condition happened to be evaluated last.
    const forge = recordingForge()
    const outcome = await mergeTask({
      runnerAutoMerge: true,
      cwd: makeRepoWithOrigin('git@github.com:o/r.git'),
      task: greenTask(),
      settings: auto(),
      inputs: greenInputs({
        review: makeReview('request_changes', [], metVerdicts()),
        checks: makeChecks({ status: 'unconfigured', checks: [] }),
        ancestry: { kind: 'behind', target: 'origin/main' },
      }),
      execForge: forge.exec,
    })
    expect(outcome.kind).toBe('refused')
    expect(outcome.kind === 'refused' && outcome.reason.code).toBe('review_blocked')
    // Not the last one, and not one of the middle ones.
    expect(outcome.kind === 'refused' && outcome.reason.code).not.toBe('branch_diverged')
    expect(outcome.readiness.blockers.map((reason) => reason.code)).toEqual([
      'review_blocked',
      'checks_unavailable',
      'branch_diverged',
    ])
    // ...and the refusal line carries that code too, not just the record.
    const refusal = outcome.events.at(-1)
    expect(refusal?.data.name).toBe('refused')
    expect(refusal?.reason_code).toBe('review_blocked')
    expect(forge.calls).toEqual([])
    // M26. Every UNMET condition line carries its OWN code, and every
    // satisfied one carries none: the journal is read one line at a time by a
    // machine as well as by a human, and "this condition was checked and it
    // passed" has to stay distinguishable from "this one lost, and here is
    // which D2 code it lost under" — the whole point of journaling the four
    // conditions rather than only the refusal.
    expect(
      outcome.events
        .filter((event) => event.data.name?.toString().startsWith('condition_'))
        .map((event) => [event.data.condition, event.reason_code ?? null]),
    ).toEqual([
      ['review', 'review_blocked'],
      ['checks', 'checks_unavailable'],
      ['criteria', null],
      ['branch', 'branch_diverged'],
    ])
  })

  test('a task with no criteria emits no merge command either (DP2)', async () => {
    const forge = recordingForge()
    const outcome = await mergeTask({
      runnerAutoMerge: true,
      cwd: makeRepoWithOrigin('git@github.com:o/r.git'),
      task: makeTask({ review_ref: '/nowhere/review.json' }),
      settings: auto(),
      inputs: greenInputs(),
      execForge: forge.exec,
    })
    expect(outcome.kind).toBe('refused')
    expect(outcome.kind === 'refused' && outcome.reason.code).toBe('criteria_missing')
    expect(forge.calls).toEqual([])
  })

  test('the consent valve unblocks an unconfigured repo, and the merge happens', async () => {
    const forge = recordingForge()
    const outcome = await mergeTask({
      runnerAutoMerge: true,
      cwd: makeRepoWithOrigin('git@github.com:o/r.git'),
      task: greenTask(),
      settings: auto({ allowMergeWithoutChecks: true }),
      inputs: greenInputs({ checks: makeChecks({ status: 'unconfigured', checks: [] }) }),
      execForge: forge.exec,
    })
    expect(outcome.kind).toBe('merged')
    expect(forge.calls).toHaveLength(1)
    // The degradation is SAID, not absorbed: its own journal name.
    expect(outcome.events.map((event) => event.data.name)).toContain('condition_consented')
  })

  test('the valve never covers a broken runtime, and no command is emitted', async () => {
    const forge = recordingForge()
    const outcome = await mergeTask({
      runnerAutoMerge: true,
      cwd: makeRepoWithOrigin('git@github.com:o/r.git'),
      task: greenTask(),
      settings: auto({ allowMergeWithoutChecks: true }),
      inputs: greenInputs({
        checks: makeChecks({ status: 'error', checks: [], error: 'docker is not running' }),
      }),
      execForge: forge.exec,
    })
    expect(outcome.kind).toBe('refused')
    expect(outcome.kind === 'refused' && outcome.reason.code).toBe('checks_unavailable')
    expect(forge.calls).toEqual([])
  })
})

describe('arm/runner integration: runnerAutoMerge overrides mergePolicy for a ticketed task', () => {
  // `runnerAutoMerge` is GLOBAL-ONLY (config.ts, REPO_IGNORED_GLOBAL_ONLY_KEYS):
  // `mergeTask` never reads config at all any more, global or repo. The
  // caller (`runMergeStep`, task-server.ts) resolves the boolean once from
  // the global file and hands it in as `opts.runnerAutoMerge`, so every test
  // below sets it directly, with no config directory to isolate.
  const ticketedGreenTask = (over: Partial<TaskRecord> = {}): TaskRecord =>
    greenTask({ hub_ticket: { id: 'tkt-1', title: 'x' }, ...over })

  test('a ticketed task merges under mergePolicy human when runnerAutoMerge is true', async () => {
    const repo = makeRepoWithOrigin('git@github.com:o/r.git')
    const forge = recordingForge({ kind: 'ok', stdout: '' })
    const outcome = await mergeTask({
      cwd: repo,
      runnerAutoMerge: true,
      task: ticketedGreenTask(),
      settings: settings({ policy: 'human', strategy: 'merge' }),
      inputs: greenInputs(),
      execForge: forge.exec,
    })
    expect(outcome.kind).toBe('merged')
    // Two calls since the proof read: the merge itself, then the bounded
    // merged-list read that fetches the merge commit for the hub report.
    expect(forge.calls.length).toBe(2)
  })

  test('runnerAutoMerge: false holds a ticketed task, like any human-policy task', async () => {
    const repo = makeRepoWithOrigin('git@github.com:o/r.git')
    const forge = recordingForge()
    const outcome = await mergeTask({
      cwd: repo,
      runnerAutoMerge: false,
      task: ticketedGreenTask(),
      settings: settings({ policy: 'human' }),
      inputs: greenInputs(),
      execForge: forge.exec,
    })
    expect(outcome.kind).toBe('held')
    expect(forge.calls).toEqual([])
  })

  test('mergeTask never reads config itself: a repo file setting runnerAutoMerge has no effect', async () => {
    const repo = makeRepoWithOrigin('git@github.com:o/r.git')
    // Global-only per REPO_IGNORED_GLOBAL_ONLY_KEYS: silently stripped from a
    // repo file already. Written here anyway, on purpose, so this test would
    // still catch it if `mergeTask` ever read config back on its own.
    saveRepoConfig(repo, { runnerAutoMerge: true })
    const forge = recordingForge()
    const outcome = await mergeTask({
      cwd: repo,
      runnerAutoMerge: false,
      task: ticketedGreenTask(),
      settings: settings({ policy: 'human' }),
      inputs: greenInputs(),
      execForge: forge.exec,
    })
    expect(outcome.kind).toBe('held')
    expect(forge.calls).toEqual([])
  })

  test('a task with no hub_ticket keeps mergePolicy human untouched even when runnerAutoMerge is true', async () => {
    const repo = makeRepoWithOrigin('git@github.com:o/r.git')
    const forge = recordingForge()
    const outcome = await mergeTask({
      cwd: repo,
      runnerAutoMerge: true,
      task: greenTask(),
      settings: settings({ policy: 'human' }),
      inputs: greenInputs(),
      execForge: forge.exec,
    })
    expect(outcome.kind).toBe('held')
    expect(forge.calls).toEqual([])
  })

  test('a repo-wide mergePolicy: auto merges regardless of runnerAutoMerge', async () => {
    const repo = makeRepoWithOrigin('git@github.com:o/r.git')
    const forge = recordingForge({ kind: 'ok', stdout: '' })
    const outcome = await mergeTask({
      cwd: repo,
      runnerAutoMerge: false,
      task: ticketedGreenTask(),
      settings: settings({ policy: 'auto', strategy: 'merge' }),
      inputs: greenInputs(),
      execForge: forge.exec,
    })
    expect(outcome.kind).toBe('merged')
  })

  test('a ticketed task still holds under human policy when a condition is unmet', async () => {
    const repo = makeRepoWithOrigin('git@github.com:o/r.git')
    const forge = recordingForge()
    const outcome = await mergeTask({
      cwd: repo,
      runnerAutoMerge: true,
      task: ticketedGreenTask(),
      settings: settings({ policy: 'human' }),
      inputs: greenInputs({ checks: makeChecks({ status: 'failed' }) }),
      execForge: forge.exec,
    })
    // Auto-merging the four conditions is not a bypass of the four conditions:
    // a red run still refuses, exactly as it would under an ordinary auto policy.
    expect(outcome.kind).toBe('refused')
    expect(forge.calls).toEqual([])
  })
})

// D20: extracted from mergeTask's own inline calc so task-server.ts's ship()
// can ask the SAME question before mergeTask ever runs. The four cases below
// are the exact ones the describe block above already exercises through
// mergeTask's observable behavior — this is the same truth table, asserted
// directly against the exported function.
describe('effectiveMergePolicyIsAuto: the exact question mergeTask answers, exported', () => {
  test('an explicit auto policy is auto, hub_ticket or not', () => {
    expect(effectiveMergePolicyIsAuto(greenTask(), settings({ policy: 'auto' }), false)).toBe(true)
  })

  test('a human policy with no hub_ticket is never auto', () => {
    expect(effectiveMergePolicyIsAuto(greenTask(), settings({ policy: 'human' }), true)).toBe(false)
  })

  test('a hub ticket with runnerAutoMerge overrides a human policy to auto', () => {
    const ticketed = greenTask({ hub_ticket: { id: 'tkt-1', title: 'x' } })
    expect(effectiveMergePolicyIsAuto(ticketed, settings({ policy: 'human' }), true)).toBe(true)
  })

  test('a hub ticket WITHOUT runnerAutoMerge does not override a human policy', () => {
    const ticketed = greenTask({ hub_ticket: { id: 'tkt-1', title: 'x' } })
    expect(effectiveMergePolicyIsAuto(ticketed, settings({ policy: 'human' }), false)).toBe(false)
  })

  test('a repo-wide auto policy is untouched by runnerAutoMerge either way', () => {
    const ticketed = greenTask({ hub_ticket: { id: 'tkt-1', title: 'x' } })
    expect(effectiveMergePolicyIsAuto(ticketed, settings({ policy: 'auto' }), false)).toBe(true)
  })
})

describe('what the merge never does', () => {
  test('a conflict is merge_conflict, and the branch and worktree are untouched', async () => {
    const repo = makeRepoWithOrigin('git@github.com:o/r.git')
    execFileSync('git', ['checkout', '-b', 'codesema/task-add-rate-limiting'], {
      cwd: repo,
      stdio: 'ignore',
    })
    writeFileSync(join(repo, 'b.txt'), 'b\n')
    execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['commit', '-m', 'work'], { cwd: repo, stdio: 'ignore' })
    const branchesBefore = git(repo, ['branch', '--format=%(refname:short)'])
    const headBefore = git(repo, ['rev-parse', 'HEAD'])
    const statusBefore = git(repo, ['status', '--porcelain'])

    const forge = recordingForge({
      kind: 'error',
      message: 'Pull request is not mergeable: the merge commit cannot be cleanly created',
    })
    const outcome = await mergeTask({
      runnerAutoMerge: true,
      cwd: repo,
      task: greenTask(),
      settings: settings({ policy: 'auto', strategy: 'merge' }),
      inputs: greenInputs(),
      execForge: forge.exec,
    })
    expect(outcome.kind).toBe('failed')
    expect(outcome.kind === 'failed' && outcome.reason.code).toBe('merge_conflict')
    expect(outcome.kind === 'failed' && outcome.reason.detail).toContain('nothing was rebased')
    // Nothing rebased, reset or deleted: the repo is exactly as it was.
    expect(git(repo, ['branch', '--format=%(refname:short)'])).toBe(branchesBefore)
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(headBefore)
    expect(git(repo, ['status', '--porcelain'])).toBe(statusBefore)
    // And only ONE call: a conflict is a fact about the branch, so the other
    // CLI is never asked to disagree.
    expect(forge.calls).toHaveLength(1)
  })

  test('no forge CLI is forge_unreachable, said and coded', async () => {
    const repo = makeRepoWithOrigin('git@example.test:o/r.git')
    const forge = recordingForge({ kind: 'missing' })
    const outcome = await mergeTask({
      runnerAutoMerge: true,
      cwd: repo,
      task: greenTask(),
      settings: settings({ policy: 'auto', strategy: 'merge' }),
      inputs: greenInputs(),
      execForge: forge.exec,
    })
    expect(outcome.kind).toBe('failed')
    expect(outcome.kind === 'failed' && outcome.reason.code).toBe('forge_unreachable')
    // An unrecognized remote probes BOTH CLIs before giving up.
    expect(forge.calls.map((call) => call.cli)).toEqual(['gh', 'glab'])
  })

  test('a forge that refuses for its own reason is coded and quotes it', async () => {
    const repo = makeRepoWithOrigin('git@github.com:o/r.git')
    const forge = recordingForge({
      kind: 'error',
      message: 'GraphQL: Base branch was modified. Review and try the merge again.',
    })
    const outcome = await mergeTask({
      runnerAutoMerge: true,
      cwd: repo,
      task: greenTask(),
      settings: settings({ policy: 'auto', strategy: 'merge' }),
      inputs: greenInputs(),
      execForge: forge.exec,
    })
    expect(outcome.kind).toBe('failed')
    expect(outcome.kind === 'failed' && outcome.reason.code).toBe('forge_unreachable')
    expect(outcome.kind === 'failed' && outcome.reason.detail).toContain('Base branch was modified')
  })

  test('a conflict is recognized in either CLI’s wording, and nothing else is', () => {
    expect(isMergeConflictError('this merge request has conflicts')).toBe(true)
    expect(
      isMergeConflictError(
        'Pull request is not mergeable: the merge commit cannot be cleanly created',
      ),
    ).toBe(true)
    expect(isMergeConflictError('could not resolve host: github.com')).toBe(false)
  })
})

// D20: a crash between an EARLIER call's forge merge landing and the caller
// (task-server.ts's runMergeStep) recording it resumes on the SAME branch —
// mergeTask must not ask the forge to merge an already-merged branch a
// second time without at least checking first.
describe('D20 idempotence: a branch the forge already merged is never merged twice', () => {
  test('a forge error is re-read as merged when the branch is already merged there', async () => {
    const repo = makeRepoWithOrigin('git@github.com:o/r.git')
    const calls: string[][] = []
    const execForge: ShipForgeExecFn = (_cli, args) => {
      calls.push(args)
      if (args.includes('merge')) {
        return Promise.resolve({ kind: 'error', message: 'GraphQL: pull request is not open' })
      }
      return Promise.resolve({ kind: 'ok', stdout: JSON.stringify([{ number: 42 }]) })
    }
    const task = greenTask()
    const outcome = await mergeTask({
      runnerAutoMerge: true,
      cwd: repo,
      task,
      settings: settings({ policy: 'auto', strategy: 'merge' }),
      inputs: greenInputs(),
      execForge,
    })
    expect(outcome.kind).toBe('merged')
    expect(outcome.kind === 'merged' && outcome.cli).toBe('gh')
    // No URL: this call never merged anything, an EARLIER one did.
    expect(outcome.kind === 'merged' && outcome.url).toBeNull()
    // Exactly two calls: the merge attempt, then the read-only check — never a
    // second merge attempt, and never a third call once the first two agree.
    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual([
      'pr',
      'list',
      `--head=${task.branch}`,
      '--state',
      'merged',
      '--limit',
      '1',
      '--json',
      'number,mergeCommit',
    ])
    const mergedEvent = outcome.events.find((event) => event.data.name === 'merged')
    expect(mergedEvent?.data.already_merged).toBe(true)
  })

  test('a real conflict never asks whether the branch already merged', async () => {
    const repo = makeRepoWithOrigin('git@github.com:o/r.git')
    const forge = recordingForge({
      kind: 'error',
      message: 'Pull request is not mergeable: the merge commit cannot be cleanly created',
    })
    const outcome = await mergeTask({
      runnerAutoMerge: true,
      cwd: repo,
      task: greenTask(),
      settings: settings({ policy: 'auto', strategy: 'merge' }),
      inputs: greenInputs(),
      execForge: forge.exec,
    })
    expect(outcome.kind).toBe('failed')
    expect(outcome.kind === 'failed' && outcome.reason.code).toBe('merge_conflict')
    // The one call: a conflict is a fact about the branch, not a reason to
    // wonder whether it already landed.
    expect(forge.calls).toHaveLength(1)
  })

  test('an unreadable already-merged check falls through to the ordinary failure', async () => {
    const repo = makeRepoWithOrigin('git@github.com:o/r.git')
    let call = 0
    const execForge: ShipForgeExecFn = () => {
      call += 1
      return Promise.resolve(
        call === 1
          ? { kind: 'error', message: 'GraphQL: pull request is not open' }
          : { kind: 'error', message: 'rate limited' },
      )
    }
    const outcome = await mergeTask({
      runnerAutoMerge: true,
      cwd: repo,
      task: greenTask(),
      settings: settings({ policy: 'auto', strategy: 'merge' }),
      inputs: greenInputs(),
      execForge,
    })
    expect(outcome.kind).toBe('failed')
    expect(outcome.kind === 'failed' && outcome.reason.code).toBe('forge_unreachable')
  })
})

// --- the default exec is really wired (M38, M67) ---------------------------
//
// Every test above injects `execForge`, which is what makes them fast and
// hermetic — and it leaves the ONE line production actually takes,
// `opts.execForge ?? ((cli, args, cwd) => execCli(cli, args, cwd))`, exercised
// by nothing at all: replacing that default with a stub that answers `missing`
// left the whole suite green (M38). `extractMrUrl(outcome.stdout)` sits on the
// same unexercised line and survived the same way (M67).
//
// A CHILD process with a `gh` shim first on PATH, never this process's own
// PATH: mutating it here would leak into whatever else `bun test` runs beside
// this file. The `gh` is one we wrote, in a tmpdir — no forge, no network, and
// nothing that could merge anything anywhere.
describe('the merge really runs a forge CLI when nothing is injected', () => {
  test('the default exec reaches gh, with the argv, and reads the URL back', async () => {
    const repo = makeRepoWithOrigin('git@github.com:o/r.git')
    const shim = makeDir()
    const argvLog = join(shim, 'argv.txt')
    writeFileSync(
      join(shim, 'gh'),
      [
        '#!/bin/sh',
        `printf '%s\\n' "$@" > '${argvLog}'`,
        "echo 'Merged pull request https://github.com/o/r/pull/9 (squash)'",
        'exit 0',
        '',
      ].join('\n'),
      { mode: 0o755 },
    )
    const modulePath = join(import.meta.dir, 'task-merge.ts')
    const script = [
      `const { mergeTask } = await import(${JSON.stringify(modulePath)})`,
      `const outcome = await mergeTask({`,
      `  cwd: ${JSON.stringify(repo)},`,
      `  runnerAutoMerge: true,`,
      `  task: ${JSON.stringify(greenTask())},`,
      `  settings: ${JSON.stringify(settings({ policy: 'auto', strategy: 'merge' }))},`,
      `  inputs: ${JSON.stringify(greenInputs())},`,
      `})`,
      `process.stdout.write(`,
      `  JSON.stringify({ kind: outcome.kind, cli: outcome.cli ?? null, url: outcome.url ?? null }),`,
      `)`,
    ].join('\n')
    const child = Bun.spawn([process.execPath, '-e', script], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, PATH: `${shim}:${process.env.PATH ?? ''}` },
    })
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    await child.exited
    if (!stdout.trim()) {
      throw new Error(`the child produced nothing: ${stderr}`)
    }
    const outcome = JSON.parse(stdout) as { kind: string; cli: string | null; url: string | null }
    expect(outcome.kind).toBe('merged')
    expect(outcome.cli).toBe('gh')
    // M67: the URL is READ BACK from what the CLI printed, not invented and
    // not dropped — it is what T3.5's recap comment links to.
    expect(outcome.url).toBe('https://github.com/o/r/pull/9')
    // M38: the shim really ran, and with the argv this module composes.
    expect(readFileSync(argvLog, 'utf8').trimEnd().split('\n')).toEqual([
      'pr',
      'merge',
      'codesema/task-add-rate-limiting',
      '--merge',
    ])
  }, 30_000)
})

describe('criteriaDraftProposed: the only trace a turn-1 draft ever leaves', () => {
  // T2.5 keeps the draft in MEMORY and never writes it to the record, so the
  // journal line is the whole evidence — and it is what separates DP2's two
  // discriminants. Read from real files here, because the point of the fact
  // is precisely that it survives the process that produced it.
  const TASK_ID = 'abcdef123456'

  test('a draft_proposed line is found, and neither of its neighbours is mistaken for it', () => {
    const cwd = makeDir()
    appendTaskEvent(cwd, TASK_ID, { type: 'turn_started', data: { turn: 1 } })
    expect(criteriaDraftProposed(cwd, TASK_ID)).toBe(false)
    // The OTHER turn-1 outcome: a reply that carried no protocol at all. It
    // must not read as "criteria were proposed".
    appendTaskEvent(cwd, TASK_ID, { type: 'criteria', data: { name: 'draft_unparsed' } })
    expect(criteriaDraftProposed(cwd, TASK_ID)).toBe(false)
    appendTaskEvent(cwd, TASK_ID, { type: 'criteria', data: { name: 'draft_proposed', count: 3 } })
    expect(criteriaDraftProposed(cwd, TASK_ID)).toBe(true)
  })

  test('an unknown task answers false rather than throwing', () => {
    expect(criteriaDraftProposed(makeDir(), TASK_ID)).toBe(false)
  })
})

describe('an unusable merge setting is named, never absorbed', () => {
  test('the degraded keys ride the task journal as their own line', async () => {
    const outcome = await mergeTask({
      runnerAutoMerge: true,
      cwd: makeRepoWithOrigin('git@github.com:o/r.git'),
      task: greenTask(),
      settings: settings(),
      inputs: greenInputs(),
      execForge: recordingForge().exec,
      degradedKeys: ['mergePolicy'],
    })
    expect(outcome.events[0]?.data).toMatchObject({
      name: 'config_degraded',
      keys: 'mergePolicy',
    })
  })
})
