import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import {
  acceptanceCriterionId,
  type AcceptanceCriterion,
  type CriterionVerdict,
  type RecapRecord,
  type ReviewRecord,
  type TaskChecks,
  type TaskEvent,
  type TaskRecord,
} from './contract.js'
import {
  generateRecap,
  lastTurnResponse,
  readTaskRecap,
  recapOptionsFor,
  renderRecapMarkdown,
  writeTaskRecap,
  type DiffFilesFn,
  type GenerateRecapOptions,
  type GenerateRecapResult,
  type RecapModelContribution,
} from './task-recap.js'
import { createTask, taskDir } from './tasks-store.js'

// --- rig ----------------------------------------------------------------------

const cleanups: string[] = []

afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function tmpCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codesema-task-recap-'))
  cleanups.push(dir)
  return dir
}

/** A bare TaskRecord good enough for generateRecap: no store I/O needed unless a test wants it. */
function fakeTask(over: Partial<TaskRecord> = {}): TaskRecord {
  const now = new Date().toISOString()
  return {
    version: 1,
    id: 'aaaaaaaaaaaa',
    title: 'Add rate limiting',
    status: 'reviewing',
    base: 'main',
    branch: 'codesema/task-rate-limit',
    worktree: '/does/not/matter',
    agent_session_id: null,
    turns: [],
    review_ref: null,
    work_ms: 0,
    wait_ms: 0,
    auto_ship: false,
    work_on: false,
    isolation: 'policy',
    created_at: now,
    updated_at: now,
    ...over,
  }
}

/** Never touches git: every test that does not care about the diff seam gets a fixed answer. */
const noopDiff: DiffFilesFn = () => []

function baseOptions(over: Partial<GenerateRecapOptions> = {}): GenerateRecapOptions {
  return {
    cwd: '/unused',
    task: fakeTask(),
    diffFilesFn: noopDiff,
    readTaskChecksFn: () => null,
    readTaskEventsFn: () => [],
    ...over,
  }
}

/**
 * `generateRecap` returns `recap: RecapRecord | null` (null only when the
 * task has no usable branch — see the dedicated describe block below). Every
 * OTHER test in this file exercises a task that DOES have one, so `recap` is
 * always non-null there; this wrapper asserts that once, instead of every
 * call site repeating an `if (!recap) throw` or a non-null assertion.
 */
function generate(
  opts: GenerateRecapOptions,
): { recap: RecapRecord } & Omit<GenerateRecapResult, 'recap'> {
  const result = generateRecap(opts)
  expect(result.recap).not.toBeNull()
  return { ...result, recap: result.recap as RecapRecord }
}

// --- files[]: diff baseline..branch, or the degraded fallback -----------------

describe('generateRecap: files[]', () => {
  test('reads files from the baseline..branch diff, exactly as the seam returns them', () => {
    let seenRange: string | undefined
    let seenCwd: string | undefined
    const diffFilesFn: DiffFilesFn = (range, cwd) => {
      seenRange = range
      seenCwd = cwd
      return ['src/a.ts', 'src/b.ts']
    }
    const { recap, degradations } = generate(
      baseOptions({
        cwd: '/repo',
        task: fakeTask({ baseline_sha: 'deadbeef', branch: 'feature', base: 'main' }),
        diffFilesFn,
      }),
    )
    expect(seenRange).toBe('deadbeef..feature')
    expect(seenCwd).toBe('/repo')
    expect(recap.files).toEqual(['src/a.ts', 'src/b.ts'])
    expect(degradations.some((d) => d.field === 'files')).toBe(false)
  })

  test('no baseline_sha: falls back to base...branch and reports the degradation', () => {
    let seenRange: string | undefined
    const diffFilesFn: DiffFilesFn = (range) => {
      seenRange = range
      return ['src/c.ts']
    }
    const { recap, degradations } = generate(
      baseOptions({
        task: fakeTask({ branch: 'feature', base: 'main' }), // no baseline_sha
        diffFilesFn,
      }),
    )
    expect(seenRange).toBe('main...feature')
    expect(recap.files).toEqual(['src/c.ts'])
    const degradation = degradations.find((d) => d.field === 'files')
    expect(degradation).toBeDefined()
    expect(degradation?.reason).toContain('no baseline_sha recorded')
    // The measurement DID succeed here — the reason must claim exactly that,
    // not the "also failed" wording of the next test.
    expect(degradation?.reason).not.toContain('also failed')
  })

  test('git failure on the primary range: files[] is empty, never invented, and it degrades', () => {
    const { recap, degradations } = generate(
      baseOptions({
        task: fakeTask({ baseline_sha: 'deadbeef' }),
        diffFilesFn: () => null,
      }),
    )
    expect(recap.files).toEqual([])
    expect(degradations.find((d) => d.field === 'files')?.reason).toContain('git diff failed')
  })

  test('no baseline_sha AND the fallback diff also fails: the reason says so, never "measured from" a range that produced nothing', () => {
    const { recap, degradations } = generate(
      baseOptions({
        task: fakeTask({ branch: 'feature', base: 'main' }), // no baseline_sha
        diffFilesFn: () => null, // the base...branch fallback fails too
      }),
    )
    expect(recap.files).toEqual([])
    const d = degradations.find((x) => x.field === 'files')
    expect(d?.reason).toContain('also failed')
    // The bug this guards against: claiming a successful measurement over a
    // range that in fact produced nothing.
    expect(d?.reason).not.toContain('files[] measured from')
  })

  test('every files[] degradation is RETURNED (this generator has no caller yet — no journal event, no API call is fabricated here)', () => {
    const { degradations } = generate(baseOptions({ task: fakeTask() })) // no baseline_sha
    expect(degradations.length).toBeGreaterThan(0)
    expect(degradations.every((d) => typeof d.reason === 'string' && d.reason.length > 0)).toBe(
      true,
    )
  })

  test('the default diff seam quotes non-ASCII paths and scopes the diff with -- ., matching prep.ts/preview.ts', () => {
    // generateRecap is called WITHOUT diffFilesFn here, so this exercises the
    // real `defaultDiffFiles` — through `tryGit`, which this test cannot
    // intercept, so it is proven at the git-argv level via a real repo below
    // (see 'the default diff seam runs real git'). This test only pins the
    // OPTIONS-level contract: the seam signature stays (range, cwd) and never
    // grows a shell string.
    const seenArgs: unknown[] = []
    const diffFilesFn: DiffFilesFn = (range, cwd) => {
      seenArgs.push(range, cwd)
      return []
    }
    generate(baseOptions({ task: fakeTask({ baseline_sha: 'abc' }), diffFilesFn }))
    expect(seenArgs).toEqual(['abc..codesema/task-rate-limit', '/unused'])
  })
})

// --- tests[]: TaskChecks persisted, with its own semantics preserved ----------

describe('generateRecap: tests[]', () => {
  const checksOf = (over: Partial<TaskChecks>): TaskChecks => ({
    head_sha: 'abc123',
    started_at: '2026-08-14T10:00:00.000Z',
    finished_at: '2026-08-14T10:01:00.000Z',
    status: 'passed',
    checks: [],
    error: null,
    ...over,
  })

  test('reflects each check command and status verbatim', () => {
    const { recap } = generate(
      baseOptions({
        readTaskChecksFn: () =>
          checksOf({
            status: 'failed',
            checks: [
              { command: 'bun test', status: 'passed', exit_code: 0, duration_ms: 10, tail: '' },
              {
                command: 'bun run lint',
                status: 'failed',
                exit_code: 1,
                duration_ms: 10,
                tail: '',
              },
            ],
          }),
      }),
    )
    expect(recap.tests).toEqual([
      { command: 'bun test', status: 'passed' },
      { command: 'bun run lint', status: 'failed' },
    ])
  })

  test('unconfigured is never presented as green: a synthetic entry names it', () => {
    const { recap } = generate(
      baseOptions({ readTaskChecksFn: () => checksOf({ status: 'unconfigured', checks: [] }) }),
    )
    expect(recap.tests).toHaveLength(1)
    expect(recap.tests[0]?.status).toBe('unconfigured')
    expect(recap.tests[0]?.synthetic).toBe(true)
    // The property the spec actually cares about: an unconfigured run must not
    // vacuously satisfy "every test passed".
    expect(recap.tests.every((t) => t.status === 'passed')).toBe(false)
  })

  test('error is named, with the readable cause as its label, and marked synthetic', () => {
    const { recap } = generate(
      baseOptions({
        readTaskChecksFn: () =>
          checksOf({ status: 'error', checks: [], error: 'no container runtime found' }),
      }),
    )
    expect(recap.tests).toEqual([
      { command: 'no container runtime found', status: 'error', synthetic: true },
    ])
  })

  test('a real check entry never carries synthetic: true', () => {
    const { recap } = generate(
      baseOptions({
        readTaskChecksFn: () =>
          checksOf({
            status: 'passed',
            checks: [
              { command: 'bun test', status: 'passed', exit_code: 0, duration_ms: 1, tail: '' },
            ],
          }),
      }),
    )
    expect(recap.tests[0]?.synthetic).toBeUndefined()
  })

  test('no checks.json persisted: tests[] is empty and the absence is returned', () => {
    const { recap, degradations } = generate(baseOptions({ readTaskChecksFn: () => null }))
    expect(recap.tests).toEqual([])
    const d = degradations.find((x) => x.field === 'tests')
    expect(d?.reason).toContain('no checks.json persisted')
  })
})

// --- criteria[]: the review's per-criterion verdicts, denormalized -----------

describe('generateRecap: criteria[]', () => {
  const TICKET: AcceptanceCriterion[] = [
    {
      id: acceptanceCriterionId('WHEN a ticket is launched THE SYSTEM SHALL lint its body'),
      text: 'WHEN a ticket is launched THE SYSTEM SHALL lint its body',
    },
    {
      id: acceptanceCriterionId('WHEN a section is missing THE SYSTEM SHALL name that section'),
      text: 'WHEN a section is missing THE SYSTEM SHALL name that section',
    },
  ]

  test('recopies criterion_id, status and evidence unchanged, and denormalizes text', () => {
    const verdicts: CriterionVerdict[] = [
      { criterion_id: TICKET[0]!.id, status: 'met', evidence: 'diff shows it' },
    ]
    const { recap } = generate(
      baseOptions({ criteriaVerdicts: verdicts, acceptanceCriteria: TICKET }),
    )
    expect(recap.criteria).toEqual([
      {
        criterion_id: TICKET[0]!.id,
        status: 'met',
        evidence: 'diff shows it',
        text: TICKET[0]!.text,
      },
    ])
  })

  test('a verdict whose criterion cannot be resolved keeps id and status, without a caption', () => {
    const verdicts: CriterionVerdict[] = [{ criterion_id: TICKET[0]!.id, status: 'unmet' }]
    const { recap } = generate(baseOptions({ criteriaVerdicts: verdicts })) // no acceptanceCriteria given
    expect(recap.criteria).toEqual([{ criterion_id: TICKET[0]!.id, status: 'unmet' }])
  })

  test('no verdicts: criteria is ABSENT (never an empty array), and this is NOT a degradation (DP12)', () => {
    // Every OTHER source available, so the only thing left unexplained is
    // criteria — which must stay silent (DP12: absence is the normal state).
    const { recap, degradations } = generate(
      baseOptions({
        task: fakeTask({ baseline_sha: 'deadbeef' }),
        readTaskChecksFn: () => ({
          head_sha: 'abc',
          started_at: 't',
          finished_at: 't',
          status: 'unconfigured',
          checks: [],
          error: null,
        }),
        modelOutput: { summary: 'ok' },
      }),
    )
    expect(recap.criteria).toBeUndefined()
    expect('criteria' in recap).toBe(false)
    expect(degradations).toEqual([]) // criteria is not a RecapDegradation field at all
  })
})

// --- cost: read from the record, never recomputed ----------------------------

describe('generateRecap: cost', () => {
  test('tokens are SUMMED from the turns that reported them', () => {
    const { recap } = generate(
      baseOptions({
        task: fakeTask({
          turns: [
            {
              prompt: 'a',
              response: 'x',
              question: null,
              started_at: 't',
              ended_at: 't',
              tokens: 100,
            },
            { prompt: 'b', response: 'y', question: null, started_at: 't', ended_at: 't' }, // no tokens: excluded, not counted as 0
            {
              prompt: 'c',
              response: 'z',
              question: null,
              started_at: 't',
              ended_at: 't',
              tokens: 50,
            },
          ],
        }),
      }),
    )
    expect(recap.tokens).toBe(150)
  })

  test('no turn reported tokens: tokens is absent, not zero', () => {
    const { recap } = generate(
      baseOptions({
        task: fakeTask({
          turns: [{ prompt: 'a', response: 'x', question: null, started_at: 't', ended_at: 't' }],
        }),
      }),
    )
    expect(recap.tokens).toBeUndefined()
  })

  test('cost_ticks / cost_basis are copied verbatim from the record, never recomputed', () => {
    const { recap } = generate(
      baseOptions({ task: fakeTask({ cost_ticks: 999, cost_basis: 'harness' }) }),
    )
    expect(recap.cost_ticks).toBe(999)
    expect(recap.cost_basis).toBe('harness')
  })

  test('no cost on the record: absent, never a lying zero', () => {
    const { recap } = generate(baseOptions())
    expect(recap.cost_ticks).toBeUndefined()
    expect(recap.cost_basis).toBeUndefined()
  })

  // Round 2, mineur: a hand-edited or truncated task.json can lose `turns`
  // the exact same way it can lose `branch` (this file's own doc comment on
  // `RecapDegradation['branch']` already names that class of corruption) —
  // `buildCost` must degrade to an honest empty cost, not throw through a
  // generator documented as "NEVER throws".
  test('a corrupted task.json with a non-array turns[] does not throw — cost degrades honestly', () => {
    const task = fakeTask({ turns: null as unknown as TaskRecord['turns'] })
    expect(() => generateRecap(baseOptions({ task }))).not.toThrow()
    const { recap } = generate(baseOptions({ task }))
    expect(recap.tokens).toBeUndefined()
  })
})

// --- branch / mr_url: read from the record and the ship's journal event ------

describe('generateRecap: branch / mr_url', () => {
  test('branch always comes from the record', () => {
    const { recap } = generate(baseOptions({ task: fakeTask({ branch: 'codesema/task-x' }) }))
    expect(recap.branch).toBe('codesema/task-x')
  })

  test('mr_url comes from the LATEST shipped journal event, never a string the model stated', () => {
    const events: TaskEvent[] = [
      {
        seq: 1,
        at: 't',
        type: 'shipped',
        data: { mr_url: 'https://example.com/pr/1', note: 'first ship' },
      },
      {
        seq: 2,
        at: 't',
        type: 'shipped',
        data: { mr_url: 'https://example.com/pr/2' },
      },
    ]
    const { recap } = generate(baseOptions({ readTaskEventsFn: () => events }))
    expect(recap.mr_url).toBe('https://example.com/pr/2')
  })

  test('not shipped yet: mr_url is absent, never a placeholder', () => {
    const { recap } = generate(baseOptions({ readTaskEventsFn: () => [] }))
    expect(recap.mr_url).toBeUndefined()
  })
})

// --- the one truly-exceptional case: no usable branch on the record ----------

describe('generateRecap: a task record with no usable branch', () => {
  test('recap is null (never fabricated), and the reason is returned — this is REACHABLE, not a hard invariant', () => {
    const result = generateRecap(baseOptions({ task: fakeTask({ branch: '' }) }))
    expect(result.recap).toBeNull()
    const d = result.degradations.find((x) => x.field === 'branch')
    expect(d).toBeDefined()
    expect(d?.reason).toContain('no usable branch')
  })

  test('never throws for this case — a hand-edited or truncated task.json is exactly what produces it', () => {
    expect(() => generateRecap(baseOptions({ task: fakeTask({ branch: '' }) }))).not.toThrow()
  })
})

// --- invariant 4: the model contributes summary/changes/decisions, and NOTHING else --

describe('generateRecap: the model contributes only summary/changes/decisions (invariant 4)', () => {
  test('summary, changes and decisions are read verbatim from the model', () => {
    const { recap } = generate(
      baseOptions({
        modelOutput: {
          summary: 'Added the recap.',
          changes: ['Added recap.ts'],
          decisions: ['Followed D10'],
        },
      }),
    )
    expect(recap.summary).toBe('Added the recap.')
    expect(recap.changes).toEqual(['Added recap.ts'])
    expect(recap.decisions).toEqual(['Followed D10'])
  })

  test('no model output: the three prose fields degrade honestly, and it is returned', () => {
    const { recap, degradations } = generate(baseOptions({ modelOutput: null }))
    expect(recap.summary).toBe('')
    expect(recap.changes).toEqual([])
    expect(recap.decisions).toEqual([])
    expect(degradations.find((x) => x.field === 'summary')?.reason).toContain(
      'no model output available',
    )
  })

  // Round 2, mineur: a model output that IS present but unshaped (`{}`, a
  // wrong-typed field, a bare string past the type) is exactly as unusable
  // as no output at all — it must degrade the same way, not silently render
  // three empty fields with no gap reported.
  //
  // Round 4, majeur 2: the round-3 guard tested only inputs that are ALREADY
  // empty or non-string at the raw level. `{summary: '   '}`, `{summary:
  // '\n\n'}` and blank-only bullets are raw values that LOOK present and
  // non-empty — it is `sanitizeRecap` (str()'s trim, sanitizeStringList's
  // drop of a blank entry) that empties them, one layer downstream of where
  // the round-3 check looked. Deciding on the raw value silently reported
  // `degradations: []` on every one of these.
  test('a present but unusable model output still degrades — presence alone is not usability, and neither is a value that only SANITIZES down to nothing', () => {
    for (const hostile of [
      {},
      { summary: 42 },
      'just a string',
      { summary: '   ' },
      { summary: '\n\n' },
      { changes: ['  ', ''] },
      { decisions: [''] },
    ] as unknown as RecapModelContribution[]) {
      const { recap, degradations } = generate(baseOptions({ modelOutput: hostile }))
      expect(recap.summary).toBe('')
      expect(recap.changes).toEqual([])
      expect(recap.decisions).toEqual([])
      const d = degradations.find((x) => x.field === 'summary')
      expect(d).toBeDefined()
      expect(d?.reason).toContain('model output present')
    }
  })

  test('STRUCTURAL rejection: a model output stuffed with numbers, statuses and URLs leaks NONE of it', () => {
    // A hostile/over-eager model response: everything a model must never be
    // allowed to inject, cast past the type so the test proves the RUNTIME
    // behavior, not just what TypeScript happens to let through today.
    const hostile = {
      summary: 'Everything is done.',
      changes: ['did stuff'],
      decisions: ['decided stuff'],
      files: ['fake-file-the-model-invented.ts'],
      files_count: 999,
      criteria: [{ criterion_id: 'ac-000000000000', status: 'met' }],
      tests: [{ command: 'fake test', status: 'passed' }],
      percent_complete: 100,
      cost_ticks: 1,
      cost_basis: 'harness',
      tokens: 1,
      branch: 'main',
      mr_url: 'https://evil.example/not-a-real-pr',
    } as unknown as Record<string, unknown>
    const { recap } = generate(
      baseOptions({
        modelOutput: hostile as unknown as RecapModelContribution,
        task: fakeTask({ branch: 'codesema/task-real' }),
        readTaskChecksFn: () => null,
        readTaskEventsFn: () => [],
      }),
    )
    // The prose the model was allowed to write DID come through:
    expect(recap.summary).toBe('Everything is done.')
    // Everything else is untouched by the hostile payload — it came from the
    // deterministic sources (or their honest absence), not from `hostile`:
    expect(recap.files).toEqual([]) // noopDiff via baseOptions, NOT hostile.files
    expect(recap.criteria).toBeUndefined() // no criteriaVerdicts given
    expect(recap.tests).toEqual([]) // readTaskChecksFn returns null
    expect(recap.cost_ticks).toBeUndefined() // record carries none
    expect(recap.tokens).toBeUndefined()
    expect(recap.branch).toBe('codesema/task-real') // from the RECORD, not hostile.branch
    expect(recap.mr_url).toBeUndefined() // no shipped event, not hostile.mr_url
    expect(JSON.stringify(recap)).not.toContain('evil.example')
    expect(JSON.stringify(recap)).not.toContain('fake-file-the-model-invented')
  })

  test('the facts win: the model undercounts files, the diff still reports every one of them', () => {
    const { recap } = generate(
      baseOptions({
        modelOutput: { summary: '3 fichiers modifiés dans cette tâche.' },
        diffFilesFn: () => ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'],
        task: fakeTask({ baseline_sha: 'deadbeef' }),
      }),
    )
    expect(recap.files).toHaveLength(5)
    // The prose is not rewritten either — it simply has no power over files[].
    expect(recap.summary).toBe('3 fichiers modifiés dans cette tâche.')
  })
})

// --- lastTurnResponse: the prose source for a recap generated before any ship

function fakeTurn(over: Partial<TaskRecord['turns'][number]> = {}): TaskRecord['turns'][number] {
  return {
    prompt: 'do it',
    response: null,
    question: null,
    started_at: '2026-01-01T00:00:00.000Z',
    ended_at: '2026-01-01T00:01:00.000Z',
    ...over,
  }
}

describe('lastTurnResponse', () => {
  test('the last turn carrying a response, not necessarily the last turn overall', () => {
    const task = fakeTask({
      turns: [
        fakeTurn({ response: 'first turn done' }),
        fakeTurn({ response: null, question: 'need more context' }),
      ],
    })
    expect(lastTurnResponse(task)).toEqual({ summary: 'first turn done' })
  })

  test('no turn has a response yet: null, not an empty string', () => {
    const task = fakeTask({ turns: [fakeTurn({ response: null })] })
    expect(lastTurnResponse(task)).toBeNull()
  })

  test('no turns at all: null', () => {
    const task = fakeTask({ turns: [] })
    expect(lastTurnResponse(task)).toBeNull()
  })

  test('a hand-edited task.json without turns degrades to null instead of throwing', () => {
    const task = fakeTask({ turns: undefined as unknown as TaskRecord['turns'] })
    expect(() => lastTurnResponse(task)).not.toThrow()
    expect(lastTurnResponse(task)).toBeNull()
  })

  test('the result feeds generateRecap as modelOutput.summary, changes/decisions stay empty', () => {
    const task = fakeTask({ turns: [fakeTurn({ response: 'Rewired the worktree cleanup.' })] })
    const contribution = lastTurnResponse(task)
    const { recap } = generate(
      baseOptions({ task, ...(contribution ? { modelOutput: contribution } : {}) }),
    )
    expect(recap.summary).toBe('Rewired the worktree cleanup.')
    expect(recap.changes).toEqual([])
    expect(recap.decisions).toEqual([])
  })
})

// --- recapOptionsFor: the shared entries for a recap built outside the ship -

function fakeReviewRecord(criteria: CriterionVerdict[]): ReviewRecord {
  return {
    version: 1,
    meta: {
      title: 'x',
      branch: 'codesema/task-x',
      target: 'main',
      merge_base: 'deadbeef',
      repo_root: '/unused',
      created_at: '2026-01-01T00:00:00.000Z',
    },
    commits: [],
    diff: '',
    review: {
      verdict: 'approve',
      summary: 'ok',
      findings: [],
      criteria,
    },
  } as unknown as ReviewRecord
}

describe('recapOptionsFor', () => {
  test('sources criteria from taskCriteria + the injected review reader, and modelOutput from the last turn', () => {
    const cwd = tmpCwd()
    const criterion: AcceptanceCriterion = {
      id: acceptanceCriterionId('WHEN a ticket is launched THE SYSTEM SHALL lint its body'),
      text: 'WHEN a ticket is launched THE SYSTEM SHALL lint its body',
    }
    const task = createTask(cwd, {
      title: 'x',
      prompt: 'x',
      autoShip: false,
      base: '',
      branch: 'codesema/task-x',
      worktree: '',
      isolation: 'policy',
    })
    task.criteria = [criterion]
    task.turns = [fakeTurn({ response: 'done' })]
    const verdicts: CriterionVerdict[] = [
      { criterion_id: criterion.id, status: 'met', evidence: 'ok' },
    ]
    const readTaskReviewFn = () => fakeReviewRecord(verdicts)

    const opts = recapOptionsFor(cwd, task, readTaskReviewFn)

    expect(opts.acceptanceCriteria).toEqual([criterion])
    expect(opts.criteriaVerdicts).toEqual(verdicts)
    expect(opts.modelOutput).toEqual({ summary: 'done' })
  })

  test('a task with no criteria at all: neither field is set (DP12)', () => {
    const cwd = tmpCwd()
    const task = createTask(cwd, {
      title: 'x',
      prompt: 'x',
      autoShip: false,
      base: '',
      branch: 'codesema/task-y',
      worktree: '',
      isolation: 'policy',
    })
    const opts = recapOptionsFor(cwd, task, () => null)
    expect(opts.acceptanceCriteria).toBeUndefined()
    expect(opts.criteriaVerdicts).toBeUndefined()
    expect(opts.modelOutput).toBeUndefined()
  })

  test('by default (no readTaskReviewFn override) it reads the real review archive', () => {
    const cwd = tmpCwd()
    const task = createTask(cwd, {
      title: 'x',
      prompt: 'x',
      autoShip: false,
      base: '',
      branch: 'codesema/task-z',
      worktree: '',
      isolation: 'policy',
    })
    const opts = recapOptionsFor(cwd, task)
    expect(opts.criteriaVerdicts).toBeUndefined()
    expect(opts.cwd).toBe(cwd)
    expect(opts.task).toBe(task)
  })
})

// --- real git, default diffFilesFn: the un-injected seam actually works ------

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'codesema-task-recap-git-'))
  cleanups.push(repo)
  const run = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  run(['init', '-b', 'main'])
  run(['config', 'user.email', 't@t'])
  run(['config', 'user.name', 't'])
  writeFileSync(join(repo, 'base.txt'), 'a\n')
  run(['add', '-A'])
  run(['commit', '-m', 'init: base'])
  return repo
}

describe('generateRecap: the default diff seam runs real git', () => {
  test('baseline..branch, computed by the real defaultDiffFiles', () => {
    const repo = makeRepo()
    const run = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
    const baseline = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim()
    run(['checkout', '-b', 'feature'])
    writeFileSync(join(repo, 'new.txt'), 'b\n')
    run(['add', '-A'])
    run(['commit', '-m', 'add new.txt'])

    const { recap } = generate({
      cwd: repo,
      task: fakeTask({ baseline_sha: baseline, branch: 'feature', base: 'main' }),
      readTaskChecksFn: () => null,
      readTaskEventsFn: () => [],
    })
    expect(recap.files).toEqual(['new.txt'])
  })

  test('a non-ASCII filename comes back as itself, not a quoted octal escape (core.quotePath=false)', () => {
    const repo = makeRepo()
    const run = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
    const baseline = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim()
    run(['checkout', '-b', 'feature'])
    writeFileSync(join(repo, 'café.ts'), 'x\n')
    run(['add', '-A'])
    run(['commit', '-m', 'add café.ts'])

    const { recap } = generate({
      cwd: repo,
      task: fakeTask({ baseline_sha: baseline, branch: 'feature', base: 'main' }),
      readTaskChecksFn: () => null,
      readTaskEventsFn: () => [],
    })
    expect(recap.files).toEqual(['café.ts'])
  })
})

// --- persistence: recap.json, atomic, sanitized on the way back in -----------

describe('writeTaskRecap / readTaskRecap', () => {
  test('round-trips through disk, atomically (no tmp file left behind)', () => {
    const cwd = tmpCwd()
    const record = createTask(cwd, {
      title: 'x',
      prompt: 'x',
      autoShip: false,
      base: 'main',
      branch: 'feature',
      worktree: '/x',
    })
    const { recap } = generate(baseOptions({ task: record }))
    const written = writeTaskRecap(cwd, record.id, recap)
    expect(readTaskRecap(cwd, record.id)).toEqual(written)
    expect(existsSync(join(taskDir(cwd, record.id), 'recap.json'))).toBe(true)
    expect(existsSync(join(taskDir(cwd, record.id), 'recap.json.tmp'))).toBe(false)
  })

  test('no recap written: absence is normal, never an error', () => {
    const cwd = tmpCwd()
    const record = createTask(cwd, {
      title: 'x',
      prompt: 'x',
      autoShip: false,
      base: 'main',
      branch: 'feature',
      worktree: '/x',
    })
    expect(readTaskRecap(cwd, record.id)).toBeNull()
  })

  test('corrupt file: null, never a crash', () => {
    const cwd = tmpCwd()
    const record = createTask(cwd, {
      title: 'x',
      prompt: 'x',
      autoShip: false,
      base: 'main',
      branch: 'feature',
      worktree: '/x',
    })
    writeFileSync(join(taskDir(cwd, record.id), 'recap.json'), '{ not json')
    expect(readTaskRecap(cwd, record.id)).toBeNull()
  })

  test('malformed id: read returns null, write throws loudly', () => {
    const cwd = tmpCwd()
    expect(readTaskRecap(cwd, '../oops')).toBeNull()
    const { recap } = generate(baseOptions())
    expect(() => writeTaskRecap(cwd, '../oops', recap)).toThrow()
  })

  // --- Round 5: the sanitizer on BOTH sides is load-bearing, not decorative.
  // Replacing `sanitizeRecap(raw)` with `raw as RecapRecord` in either
  // direction left every test above green: the "corrupt file" case only
  // exercises `JSON.parse` throwing, and the round-trip case writes a record
  // that is already clean, so neither one ever asks the sanitizer to CHANGE
  // anything. A hostile recap.json is what does.

  const HOSTILE_RECAP = {
    // Not 1: a future/forged version must not travel back out as-is.
    version: 99,
    summary: 'ok',
    changes: [],
    decisions: [],
    files: [],
    // An invented status: sanitizeRecapTestEntry drops the WHOLE entry rather
    // than degrading it to a green one.
    tests: [{ command: 'bun test', status: 'everything-passed' }],
    // Negative: optionalNonNegativeInt refuses it, and absence (not 0) is the
    // honest replacement.
    tokens: -5,
    cost_ticks: 7,
    // Out of the closed enum: cost_ticks and cost_basis fall together.
    cost_basis: 'vibes',
    branch: 'feature',
    // An unknown key the schema forbids: whitelisting drops it entirely.
    verdict: 'shipped',
  }

  // Exactly what sanitizeRecap makes of HOSTILE_RECAP, spelled out rather than
  // recomputed, so this test cannot agree with a broken sanitizer.
  const HOSTILE_RECAP_CLEANED: RecapRecord = {
    version: 1,
    summary: 'ok',
    changes: [],
    decisions: [],
    files: [],
    tests: [],
    branch: 'feature',
  }

  test('readTaskRecap runs the file through sanitizeRecap — a hand-written hostile recap.json never comes back as-is', () => {
    const cwd = tmpCwd()
    const record = createTask(cwd, {
      title: 'x',
      prompt: 'x',
      autoShip: false,
      base: 'main',
      branch: 'feature',
      worktree: '/x',
    })
    writeFileSync(
      join(taskDir(cwd, record.id), 'recap.json'),
      JSON.stringify(HOSTILE_RECAP),
      'utf8',
    )
    expect(readTaskRecap(cwd, record.id)).toEqual(HOSTILE_RECAP_CLEANED)
  })

  test('writeTaskRecap sanitizes BEFORE writing — the bytes on disk are the sanitized record, not the caller argument', () => {
    const cwd = tmpCwd()
    const record = createTask(cwd, {
      title: 'x',
      prompt: 'x',
      autoShip: false,
      base: 'main',
      branch: 'feature',
      worktree: '/x',
    })
    // The cast is the point: the typed signature does not stop a caller that
    // built its record from parsed JSON or from a widened type.
    const written = writeTaskRecap(cwd, record.id, HOSTILE_RECAP as unknown as RecapRecord)
    expect(written).toEqual(HOSTILE_RECAP_CLEANED)
    // And on disk, read back WITHOUT the sanitizer, so this asserts the file
    // itself rather than the reader's own cleanup.
    const onDisk: unknown = JSON.parse(
      readFileSync(join(taskDir(cwd, record.id), 'recap.json'), 'utf8'),
    )
    expect(onDisk).toEqual(HOSTILE_RECAP_CLEANED)
  })

  test('writeTaskRecap refuses a record with no usable branch rather than persisting a nameless recap', () => {
    const cwd = tmpCwd()
    const record = createTask(cwd, {
      title: 'x',
      prompt: 'x',
      autoShip: false,
      base: 'main',
      branch: 'feature',
      worktree: '/x',
    })
    expect(() =>
      writeTaskRecap(cwd, record.id, { ...HOSTILE_RECAP, branch: '   ' } as unknown as RecapRecord),
    ).toThrow()
    expect(existsSync(join(taskDir(cwd, record.id), 'recap.json'))).toBe(false)
  })
})

// --- renderRecapMarkdown: pure, stable, and honest about absence -------------

describe('renderRecapMarkdown', () => {
  const { recap: FULL } = generate(
    baseOptions({
      task: fakeTask({ branch: 'codesema/task-recap', cost_ticks: 42, cost_basis: 'lower_bound' }),
      diffFilesFn: () => ['packages/contract/src/recap.ts'],
      readTaskChecksFn: () => ({
        head_sha: 'abc',
        started_at: 't',
        finished_at: 't',
        status: 'failed',
        checks: [{ command: 'bun test', status: 'passed', exit_code: 0, duration_ms: 1, tail: '' }],
        error: null,
      }),
      readTaskEventsFn: () => [
        { seq: 1, at: 't', type: 'shipped', data: { mr_url: 'https://example.com/pr/9' } },
      ],
      modelOutput: { summary: 'Did the thing.', changes: ['Changed X'], decisions: ['Chose Y'] },
      criteriaVerdicts: [{ criterion_id: 'ac-000000000000', status: 'met', evidence: 'see diff' }],
    }),
  )

  test('is a pure function: same input, same output, every time', () => {
    const a = renderRecapMarkdown(FULL)
    const b = renderRecapMarkdown(structuredClone(FULL))
    expect(a).toBe(b)
    expect(renderRecapMarkdown(FULL)).toBe(a)
  })

  test('SNAPSHOT: the exact rendered document for a fixed input — any header, count or label change reddens this', () => {
    expect(renderRecapMarkdown(FULL)).toBe(
      '## Summary\n\n' +
        '> Did the thing.\n\n' +
        '## Changes\n\n' +
        '- Changed X\n\n' +
        '## Decisions\n\n' +
        '- Chose Y\n\n' +
        '## Files (1)\n\n' +
        '- `packages/contract/src/recap.ts`\n\n' +
        '## Tests\n\n' +
        '- [passed] `bun test`\n\n' +
        '## Acceptance criteria\n\n' +
        '- [met] ac-000000000000\n  evidence: see diff\n\n' +
        '## Cost\n\n' +
        '42 ticks (lower_bound)\n\n' +
        '**Branch:** `codesema/task-recap`\n' +
        '**Merge request:** `https://example.com/pr/9`',
    )
  })

  test('carries every section for a full record', () => {
    const md = renderRecapMarkdown(FULL)
    expect(md).toContain('Did the thing.')
    expect(md).toContain('Changed X')
    expect(md).toContain('Chose Y')
    expect(md).toContain('packages/contract/src/recap.ts')
    expect(md).toContain('[passed] `bun test`')
    expect(md).toContain('ac-000000000000')
    expect(md).toContain('see diff')
    expect(md).toContain('42 ticks (lower_bound)')
    expect(md).toContain('codesema/task-recap')
    expect(md).toContain('https://example.com/pr/9')
  })

  test('absent mr_url and unknown cost render nothing, not a zero or an invented link', () => {
    const { recap } = generate(baseOptions())
    const md = renderRecapMarkdown(recap)
    expect(md).not.toContain('Merge request')
    expect(md).not.toContain('## Cost')
    expect(md).not.toContain('undefined')
  })

  test('an empty summary renders an honest placeholder, not a blank section', () => {
    const { recap } = generate(baseOptions())
    expect(renderRecapMarkdown(recap)).toContain('No summary available')
  })

  // --- D26: the "To decide" section ------------------------------------------

  test('no unclear criterion: no "To decide" section at all', () => {
    // FULL's one criterion is 'met' — nothing to decide.
    expect(renderRecapMarkdown(FULL)).not.toContain('## To decide')
  })

  test('an open judgment call gets its own section, with the question named', () => {
    const { recap } = generate(
      baseOptions({
        criteriaVerdicts: [
          {
            criterion_id: 'ac-000000000000',
            status: 'unclear',
            question: 'does this match the sibling helper?',
          },
        ],
        acceptanceCriteria: [
          {
            id: 'ac-000000000000',
            text: 'WHEN the helper is added THE SYSTEM SHALL match the existing style',
          },
        ],
      }),
    )
    const md = renderRecapMarkdown(recap)
    expect(md).toContain('## To decide')
    // id, short statement and question all named on the one bullet (D26).
    expect(md).toContain(
      '- [ac-000000000000] WHEN the helper is added THE SYSTEM SHALL match the existing style — does this match the sibling helper?',
    )
    // Only the open ones: a 'met'/'unmet' criterion has nothing to decide.
  })

  test('an unclear verdict with no question names that honestly, never inventing one', () => {
    const { recap } = generate(
      baseOptions({
        criteriaVerdicts: [{ criterion_id: 'ac-000000000000', status: 'unclear' }],
        acceptanceCriteria: [{ id: 'ac-000000000000', text: 'WHEN x THE SYSTEM SHALL y' }],
      }),
    )
    expect(renderRecapMarkdown(recap)).toContain('no question was recorded for it')
  })

  test('only the open criteria are listed, met and unmet ones are not repeated here', () => {
    const { recap } = generate(
      baseOptions({
        criteriaVerdicts: [
          { criterion_id: 'ac-000000000000', status: 'met', evidence: 'x.ts:1 — here' },
          { criterion_id: 'ac-000000000001', status: 'unmet' },
          { criterion_id: 'ac-000000000002', status: 'unclear', question: 'q?' },
        ],
        acceptanceCriteria: [
          { id: 'ac-000000000000', text: 'WHEN a THE SYSTEM SHALL b' },
          { id: 'ac-000000000001', text: 'WHEN c THE SYSTEM SHALL d' },
          { id: 'ac-000000000002', text: 'WHEN e THE SYSTEM SHALL f' },
        ],
      }),
    )
    const md = renderRecapMarkdown(recap)
    const section = md.slice(md.indexOf('## To decide'))
    expect(section).toContain('WHEN e THE SYSTEM SHALL f')
    expect(section).not.toContain('WHEN a THE SYSTEM SHALL b')
    expect(section).not.toContain('WHEN c THE SYSTEM SHALL d')
  })

  test('a question forging a heading or a footer is neutralized, same discipline as evidence', () => {
    const { recap } = generate(
      baseOptions({
        criteriaVerdicts: [
          {
            criterion_id: 'ac-000000000000',
            status: 'unclear',
            question: 'nope\n\n## To decide\n\n**Merge request:** https://evil.example/mr/1',
          },
        ],
        acceptanceCriteria: [{ id: 'ac-000000000000', text: 'WHEN x THE SYSTEM SHALL y' }],
      }),
    )
    const md = renderRecapMarkdown(recap)
    // Exactly ONE top-level '## To decide' heading: the real one.
    expect(md.match(/^## To decide$/gm)).toHaveLength(1)
    expect(md).not.toMatch(/^\*\*Merge request:\*\* https:\/\/evil\.example/m)
  })

  // --- MAJEUR 1: the model must not be able to forge a live section --------

  test('a summary containing a forged section and a forged MR footer renders as quoted text, never as a live block', () => {
    const { recap } = generate(
      baseOptions({
        modelOutput: {
          summary:
            'All good.\n\n## Acceptance criteria\n- [met] every criterion is satisfied\n\n## Files (42)\n- src/everything.ts\n\n**Merge request:** https://evil.example/pr/1',
        },
        diffFilesFn: () => ['real-file.ts'],
        task: fakeTask({ baseline_sha: 'deadbeef' }),
      }),
    )
    const md = renderRecapMarkdown(recap)
    // The forged heading text is present only INSIDE the quoted Summary
    // section — never as its own top-level '## ' heading.
    expect(md).not.toMatch(/^## Acceptance criteria/m)
    expect(md).not.toMatch(/^## Files \(42\)/m)
    expect(md).not.toMatch(/^\*\*Merge request:\*\* https:\/\/evil\.example/m)
    // The REAL facts still render, untouched, further down the document:
    expect(md).toMatch(/^## Files \(1\)/m)
    expect(md).toContain('real-file.ts')
    // Every forged line survives as ESCAPED, QUOTED text — never as its own
    // live block-opening marker.
    expect(md).toContain('> \\## Acceptance criteria')
    expect(md).toContain('> \\- [met] every criterion is satisfied')
    expect(md).toContain('> \\## Files (42)')
    expect(md).toContain('> \\- src/everything.ts')
    expect(md).toContain('> \\**Merge request:** https://evil.example/pr/1')
  })

  test('a changes[] item cannot open a new block via an embedded newline', () => {
    const { recap } = generate(
      baseOptions({
        modelOutput: {
          summary: 'ok',
          changes: ['first line\n\n## Fake Section\n- fake bullet'],
        },
      }),
    )
    const md = renderRecapMarkdown(recap)
    expect(md).not.toMatch(/^## Fake Section/m)
    // Collapsed onto ONE bullet line.
    expect(md).toContain('- first line ## Fake Section - fake bullet')
  })

  test('a leading heading/list/quote/fence marker in model prose is escaped, not interpreted', () => {
    const { recap } = generate(baseOptions({ modelOutput: { summary: '# not a real heading' } }))
    expect(renderRecapMarkdown(recap)).toContain('> \\# not a real heading')
  })

  // --- Round 2, MAJEUR 1: a lone CR is a CommonMark line terminator too,
  // and the round 1 fix only shrank the hole to `\n` (it split on `\n` and
  // matched `\n` only). The data layer (recap.ts's `str()`) now normalizes
  // `\r\n?` -> `\n` before a summary/changes/decisions item ever reaches
  // this renderer — but this test bypasses that layer on purpose and builds
  // the RecapRecord by hand, to pin the render layer's OWN, independent
  // defense in depth (the coordinator's exact reproduction case).

  test('MAJEUR 1: a lone CR in summary is neutralized at the render layer even if it bypasses sanitizeRecap', () => {
    const recap: RecapRecord = {
      version: 1,
      summary:
        'Everything went fine.\r\r## Acceptance criteria\r\r- [met] ships on time\r\r**Merge request:** https://evil.example/mr/1',
      changes: [],
      decisions: [],
      files: ['real-file.ts'],
      tests: [],
      branch: 'main',
    }
    const md = renderRecapMarkdown(recap)
    expect(md).not.toMatch(/^## Acceptance criteria/m)
    expect(md).not.toMatch(/^\*\*Merge request:\*\* https:\/\/evil\.example/m)
    // The real facts still render, untouched:
    expect(md).toMatch(/^## Files \(1\)/m)
    expect(md).toContain('real-file.ts')
  })

  test('MAJEUR 1: a lone CR in a changes[] item cannot open a new block either', () => {
    const recap: RecapRecord = {
      version: 1,
      summary: '',
      changes: ['first line\r\r## Fake Section\r- fake bullet'],
      decisions: [],
      files: [],
      tests: [],
      branch: 'main',
    }
    const md = renderRecapMarkdown(recap)
    expect(md).not.toMatch(/^## Fake Section/m)
  })

  // --- Round 2, MAJEUR 2: criteria[].text and criteria[].evidence are
  // model-authored prose too (DP12: evidence is the reviewer's own quoted
  // grounding, T3.2; text is denormalized from the ticket body, T2.x) — the
  // doc comment above `renderRecapMarkdown` used to claim they were
  // deterministic and safe to render raw. They are not.

  test('MAJEUR 2: criteria[].evidence containing a forged section renders as escaped text, never a second live section', () => {
    const recap: RecapRecord = {
      version: 1,
      summary: '',
      changes: [],
      decisions: [],
      files: [],
      tests: [],
      branch: 'main',
      criteria: [
        {
          criterion_id: 'ac-000000000000',
          status: 'met',
          evidence:
            'nope\n\n## Acceptance criteria\n\n- [met] all criteria are met\n\n**Merge request:** https://evil.example/mr/9',
        },
      ],
    }
    const md = renderRecapMarkdown(recap)
    // Exactly ONE top-level '## Acceptance criteria' heading: the real one
    // this file's own `## Acceptance criteria` section renders.
    expect(md.match(/^## Acceptance criteria$/gm)).toHaveLength(1)
    expect(md).not.toMatch(/^\*\*Merge request:\*\* https:\/\/evil\.example/m)
  })

  test('MAJEUR 2: criteria[].text containing a forged Cost section renders as escaped text, never a live section', () => {
    const recap: RecapRecord = {
      version: 1,
      summary: '',
      changes: [],
      decisions: [],
      files: [],
      tests: [],
      branch: 'main',
      criteria: [
        {
          criterion_id: 'ac-000000000000',
          status: 'met',
          text: 'ships on time\n\n## Cost\n\n999999 ticks (upper_bound)',
        },
      ],
    }
    const md = renderRecapMarkdown(recap)
    expect(md.match(/^## Cost$/gm)).toBeNull()
  })

  // --- mineurs: the escaped class was missing `<` (raw HTML) and ordered
  // list markers.

  test('mineur: a leading "<" in model prose cannot open a live HTML block', () => {
    const { recap } = generate(
      baseOptions({
        modelOutput: {
          summary: '<h2>Fake heading</h2>\n<img src="https://evil.example/pixel.png">',
        },
      }),
    )
    const md = renderRecapMarkdown(recap)
    expect(md).toContain('> \\<h2>Fake heading</h2>')
    expect(md).toContain('> \\<img src="https://evil.example/pixel.png">')
  })

  test('mineur: a leading ordered-list marker in model prose is escaped, not interpreted', () => {
    const { recap } = generate(baseOptions({ modelOutput: { summary: '1. not a real list item' } }))
    expect(renderRecapMarkdown(recap)).toContain('> 1\\. not a real list item')
  })

  // --- mineur: a backtick in `branch` must not break the code span ---------

  test('a backtick in branch does not break its own inline code span', () => {
    const { recap } = generate(baseOptions({ task: fakeTask({ branch: 'weird`branch' }) }))
    const md = renderRecapMarkdown(recap)
    expect(md).toContain('**Branch:** `` weird`branch ``')
  })

  // --- Round 4, majeur 1: "deterministic" is not "safe" — a document schema
  // is published, so renderRecapMarkdown must hold for every RecapRecord the
  // SCHEMA admits, not just the ones this CLI's own generator happens to
  // build. `branch`, `mr_url`, `files[]` and `tests[].command` are now
  // bounded MONO-LINE by `recap.ts`'s `line()` (data layer) AND neutralized a
  // second, independent time here (`collapseToOneLine`/`inlineCode`, render
  // layer) — so a RecapRecord assembled by hand (bypassing sanitizeRecap
  // entirely, exactly like the round-2/round-3 tests above already do for
  // `summary`/`criteria[]`) still renders honestly.

  test('MAJEUR 1 (round 4): a forged section embedded in tests[].command cannot open a live block, even bypassing sanitizeRecap', () => {
    // The coordinator's exact reproduction 1: a repo-declared checks command
    // (readChecksConfig, repo-config.ts) has no newline filter, unlike
    // acceptProposedCommand/acceptDeclaredCommand — this constructs the
    // RecapRecord this generator would build FROM such a hostile command,
    // bypassing the intermediate TaskChecks/generateRecap machinery so the
    // renderer's OWN defense is what is under test, not an upstream filter.
    const recap: RecapRecord = {
      version: 1,
      summary: '',
      changes: [],
      decisions: [],
      files: ['real-file.ts'],
      tests: [
        {
          command:
            'bun test\n\n## Acceptance criteria\n\n- [met] every criterion was met\n\n**Merge request:** https://evil.example/mr/1',
          status: 'passed',
        },
      ],
      branch: 'main',
    }
    const md = renderRecapMarkdown(recap)
    expect(md).not.toMatch(/^## Acceptance criteria/m)
    expect(md).not.toMatch(/^\*\*Merge request:\*\* https:\/\/evil\.example/m)
    // The line survives, folded onto ONE line, inside the Tests section,
    // and (round 5, majeur 2) inside an inline code span:
    expect(md).toContain('- [passed] `bun test ## Acceptance criteria')
  })

  test('MAJEUR 1 (round 4): an embedded newline in branch/mr_url cannot forge a document boundary, even bypassing sanitizeRecap', () => {
    const recap: RecapRecord = {
      version: 1,
      summary: '',
      changes: [],
      decisions: [],
      files: [],
      tests: [],
      branch: 'main\n\n**Merge request:** https://evil.example/mr/2',
      mr_url: 'https://real.example/mr/1\n\n**Merge request:** https://evil.example/mr/3',
    }
    const md = renderRecapMarkdown(recap)
    // Exactly one real footer line each — the forged continuation is folded
    // onto the SAME line (visible as inert text, never as its own line).
    expect(md.match(/^\*\*Branch:\*\*/gm)).toHaveLength(1)
    expect(md.match(/^\*\*Merge request:\*\*/gm)).toHaveLength(1)
    expect(md.split('\n').filter((l) => l.includes('evil.example'))).toHaveLength(2)
  })

  test('MAJEUR 1 (round 4): files[] chosen by an attacker (a git path, not model prose) cannot forge live markdown', () => {
    // Reproduction 3: files[] is a string an agent (or a hostile repo) can
    // shape freely — a git path may legally contain markdown-active bytes.
    const recap: RecapRecord = {
      version: 1,
      summary: '',
      changes: [],
      decisions: [],
      files: [
        '**everything passed**.ts',
        'see [our report](https://evil.example).md',
        'x`rm -rf`y.ts',
      ],
      tests: [],
      branch: 'main',
    }
    const md = renderRecapMarkdown(recap)
    // Every entry is an inline CODE SPAN: no live bold, no live link, and the
    // embedded backtick does not break out of its own span.
    expect(md).toContain('- `**everything passed**.ts`')
    expect(md).toContain('- `see [our report](https://evil.example).md`')
    expect(md).toContain('- `` x`rm -rf`y.ts ``')
  })

  // --- Round 5 -------------------------------------------------------------

  test('MAJEUR 2 (round 5): tests[].command renders inert — a remote image and a phishing link stay text, exactly like a files[] path', () => {
    // Same class of string as a files[] path, and named by the same
    // requirement: a repo-declared `.codesema/config.json` checks command
    // (readChecksConfig, repo-config.ts — no filter of any kind) and the
    // readable cause carried on the `synthetic` entry built from
    // `checks.error`. Round 4 gave files[] an inline code span and left this
    // one plain, so the MR description T3.5 posts carried a LIVE remote
    // tracker and a LIVE phishing link.
    const recap: RecapRecord = {
      version: 1,
      summary: '',
      changes: [],
      decisions: [],
      files: ['![](https://evil.example/pixel.png)'],
      tests: [
        { command: 'bun test ![](https://evil.example/pixel.png)', status: 'passed' },
        { command: 'bun test [click here](https://evil.example/phish)', status: 'failed' },
        {
          command: 'check run failed: ![](https://evil.example/pixel.png)',
          status: 'error',
          synthetic: true,
        },
      ],
      branch: 'main',
      mr_url:
        'https://real.example/1 ![](https://evil.example/pixel.png) [click here](https://evil.example/phish)',
    }
    const md = renderRecapMarkdown(recap)
    // Not one live inline image or link anywhere in the document: every `![](`
    // and `](` that reaches the page sits inside a code span.
    expect(md).toContain('- [passed] `bun test ![](https://evil.example/pixel.png)`')
    expect(md).toContain('- [failed] `bun test [click here](https://evil.example/phish)`')
    expect(md).toContain('- [error] `check run failed: ![](https://evil.example/pixel.png)`')
    expect(md).toContain(
      '**Merge request:** `https://real.example/1 ![](https://evil.example/pixel.png) [click here](https://evil.example/phish)`',
    )
    // And the same property stated once, structurally: no occurrence of the
    // hostile markup survives OUTSIDE a code span.
    for (const line of md.split('\n')) {
      if (line.includes('evil.example')) {
        expect(line).toContain('`')
      }
    }
  })

  test('MAJEUR 2 (round 5): a real check entry and the synthetic one take the SAME path — neither renders live markdown', () => {
    // The synthetic entry's `command` is a readable phrase built from
    // checks.error, not a command: it is prose from a failed run, and it
    // reaches the page through renderTests exactly like a real command does.
    const recap: RecapRecord = {
      version: 1,
      summary: '',
      changes: [],
      decisions: [],
      files: [],
      tests: [
        {
          command: '(no checks configured for this repo)',
          status: 'unconfigured',
          synthetic: true,
        },
        { command: '**everything passed**', status: 'failed' },
      ],
      branch: 'main',
    }
    const md = renderRecapMarkdown(recap)
    expect(md).toContain('- [unconfigured] `(no checks configured for this repo)`')
    expect(md).toContain('- [failed] `**everything passed**`')
    expect(md).not.toMatch(/^- \[failed\] \*\*everything passed\*\*$/m)
  })

  test('MAJEUR 2 (round 5): a backtick inside a test command or an mr_url does not break out of its own code span', () => {
    const recap: RecapRecord = {
      version: 1,
      summary: '',
      changes: [],
      decisions: [],
      files: [],
      tests: [{ command: 'bun test `x`', status: 'passed' }],
      branch: 'main',
      mr_url: 'https://real.example/`1`',
    }
    const md = renderRecapMarkdown(recap)
    expect(md).toContain('- [passed] `` bun test `x` ``')
    expect(md).toContain('**Merge request:** `` https://real.example/`1` ``')
  })

  test('round 5: files[] carrying a LINE BREAK (not just a markdown marker) cannot forge a live section — the render layer folds it on its own', () => {
    // The round-4 files[] test only used markdown markers, which `inlineCode`
    // alone neutralizes: it stayed green with `collapseToOneLine` removed from
    // renderList. A blank line INSIDE a code span ends the span under
    // CommonMark, so without that fold the `## Acceptance criteria` below
    // opens a live heading of this very document.
    const recap: RecapRecord = {
      version: 1,
      summary: '',
      changes: [],
      decisions: [],
      files: ['a.ts\n\n## Acceptance criteria\n\n- [met] every criterion was met'],
      tests: [],
      branch: 'main',
    }
    const md = renderRecapMarkdown(recap)
    expect(md).not.toMatch(/^## Acceptance criteria/m)
    expect(md).not.toMatch(/^- \[met\] every criterion was met/m)
    expect(md).toContain('- `a.ts ## Acceptance criteria - [met] every criterion was met`')
    // The Files section stays exactly one bullet long, matching its own count.
    expect(md).toContain('## Files (1)')
  })

  test('round 5: a LONE CR — no LF anywhere — is folded in files[], tests[].command and mr_url alike', () => {
    // CommonMark treats a lone `\r` as a line terminator exactly like `\n`
    // (round 2, majeur 1, applied to `collapseToOneLine`'s own regex). No
    // test exercised the `\r`-only branch of that alternation: narrowing it
    // to `\n` left every existing test green while a lone CR forged both a
    // live section and a second footer.
    const recap: RecapRecord = {
      version: 1,
      summary: '',
      changes: [],
      decisions: [],
      files: ['a.ts\r\r## Acceptance criteria\r\r- [met] all good'],
      tests: [{ command: 'bun test\r\r## Cost\r\r0 ticks', status: 'passed' }],
      branch: 'main',
      mr_url: 'https://real.example/1\r\r**Merge request:** https://evil.example/2',
    }
    const md = renderRecapMarkdown(recap)
    // No CR reaches the page at all — the fold is what removes it.
    expect(md).not.toContain('\r')
    expect(md).not.toMatch(/^## Acceptance criteria/m)
    expect(md).not.toMatch(/^## Cost/m)
    expect(md.match(/^\*\*Merge request:\*\*/gm)).toHaveLength(1)
    expect(md).toContain('- `a.ts ## Acceptance criteria - [met] all good`')
    expect(md).toContain('- [passed] `bun test ## Cost 0 ticks`')
  })

  test('round 5: "consumable without reformatting" — the rendered document is a self-contained markdown body a publisher posts as-is', () => {
    // The spec scenario "Rendu consommable sans reformatage" had no test that
    // would redden if the property fell: the snapshot proves STABILITY, not
    // consumability. What a publisher (T3.5) needs, stated as checkable
    // properties of the string itself.
    const md = renderRecapMarkdown(FULL)
    // 1. No leading/trailing whitespace to strip, and no CR to normalize.
    expect(md).toBe(md.trim())
    expect(md).not.toContain('\r')
    // 2. Never opens or closes with a blank line, and carries no run of three
    //    or more newlines (which some forges collapse, changing the layout).
    expect(md).not.toMatch(/\n{3}/)
    // 3. Every section header is a top-level ATX heading at column 0, so the
    //    body nests under whatever the publisher puts above it.
    const headings = md.split('\n').filter((l) => l.startsWith('#'))
    expect(headings.length).toBeGreaterThan(0)
    for (const h of headings) {
      expect(h).toMatch(/^## \S/)
    }
    // 4. No placeholder a caller would have to fill in, and no template hole.
    expect(md).not.toMatch(/\{\{|\}\}|TODO|<placeholder>/)
    // 5. It is a complete document on its own: the identifying footer is the
    //    LAST line, so appending nothing is a valid publication.
    expect(md.split('\n').at(-1)).toMatch(/^\*\*(Branch|Merge request):\*\* /)
  })

  // --- Round 4: the 13 survivors from the campagne indépendante -----------

  test('every leading markdown block-opening character is escaped, not just "#" — table-driven over the whole class', () => {
    for (const ch of '#>*+-=_~`|<') {
      const { recap } = generate(
        baseOptions({ modelOutput: { summary: `${ch} not a real block` } }),
      )
      const md = renderRecapMarkdown(recap)
      expect(md).toContain(`> \\${ch} not a real block`)
    }
  })

  test('a leading marker indented up to three spaces still opens a block in CommonMark, and is still escaped', () => {
    // Built by hand rather than through generate()/modelOutput: str()'s OWN
    // leading trim (recap.ts) would strip the very indent this test exists to
    // exercise before it ever reached the renderer — this pins the RENDER
    // layer's escaping in isolation, same style as the MAJEUR 1/2 tests above
    // that bypass sanitizeRecap on purpose.
    const recap: RecapRecord = {
      version: 1,
      summary: '   # indented heading',
      changes: [],
      decisions: [],
      files: [],
      tests: [],
      branch: 'main',
    }
    const md = renderRecapMarkdown(recap)
    // Under the mutation `( {0,3})` -> `()`, the leading spaces would stop
    // the marker from matching at all and this backslash would never appear.
    expect(md).toContain('   \\# indented heading')
  })

  test('an ordered-list marker using ")" is escaped exactly like "."', () => {
    const { recap } = generate(baseOptions({ modelOutput: { summary: '1) not a real list item' } }))
    expect(renderRecapMarkdown(recap)).toContain('> 1\\) not a real list item')
  })

  test('a blank line inside a multi-paragraph summary renders as a bare ">", never "> " with a trailing space', () => {
    const { recap } = generate(
      baseOptions({ modelOutput: { summary: 'First paragraph.\n\nSecond paragraph.' } }),
    )
    const md = renderRecapMarkdown(recap)
    const lines = md.split('\n')
    expect(lines).toContain('>')
    expect(lines).not.toContain('> ')
    expect(md).toContain('> First paragraph.\n>\n> Second paragraph.')
  })

  // --- DP12: the denormalized `text` must actually REACH the page ----------

  test('DP12: a criterion whose text resolved renders THAT text as its label, never the bare criterion_id', () => {
    const recap: RecapRecord = {
      version: 1,
      summary: '',
      changes: [],
      decisions: [],
      files: [],
      tests: [],
      branch: 'main',
      criteria: [
        {
          criterion_id: 'ac-000000000000',
          status: 'met',
          text: 'WHEN a ticket is launched THE SYSTEM SHALL lint its body',
        },
      ],
    }
    const md = renderRecapMarkdown(recap)
    expect(md).toContain('- [met] WHEN a ticket is launched THE SYSTEM SHALL lint its body')
    expect(md).not.toContain('- [met] ac-000000000000')
  })
})
