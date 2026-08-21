import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { TASK_AGENT_MAX, TASK_BASE_MAX, type TaskRecord } from './contract.js'
import { t } from './i18n.js'
import { UNPROBED_ISOLATION, type IsolationProbe } from './task-isolation.js'
import {
  resolveTaskPlan,
  type TaskPlanDeps,
  type TaskPlanInput,
  type TaskPlanResolution,
} from './task-plan.js'
import { detectTaskBase, resolveForkBase } from './task-worktree.js'
import { resolveKnownAgentCommand } from './wizard.js'

const cleanups: string[] = []

afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeRepo(defaultBranch = 'main'): string {
  const repo = mkdtempSync(join(tmpdir(), 'codesema-task-plan-'))
  cleanups.push(repo)
  const run = (args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
      cwd: repo,
      stdio: 'ignore',
    })
  run(['init', '-b', defaultBranch])
  writeFileSync(join(repo, 'base.txt'), 'a\n')
  run(['add', '-A'])
  run(['commit', '-m', 'init: base'])
  return repo
}

const git = (repo: string, args: string[]): string =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: repo })
    .toString()
    .trim()

function deps(cwd: string, over: Partial<TaskPlanDeps> = {}): TaskPlanDeps {
  return {
    cwd,
    runtime: { command: 'claude -p', isolationMode: 'policy' },
    probe: UNPROBED_ISOLATION,
    tasks: () => [],
    admission: () => ({ admissible: true, position: null }),
    ...over,
  }
}

/** The rest of a plan input, so a test names only the field it is about. */
const planFor = (over: Partial<TaskPlanInput> = {}): TaskPlanInput => ({
  title: 't',
  autoShip: false,
  ...over,
})

function activeRecord(id: string, branch: string): TaskRecord {
  return {
    version: 1,
    id,
    title: 'live one',
    status: 'running',
    base: 'main',
    branch,
    worktree: '',
    agent_session_id: null,
    turns: [],
    review_ref: null,
    work_ms: 0,
    wait_ms: 0,
    auto_ship: false,
    work_on: true,
    isolation: 'policy',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }
}

/**
 * Every path under `dir`, with its size and mtime — the fingerprint the ticket
 * names as the proof of "no side effect". Compared as a whole rather than by
 * spot-checking the files we happened to think of.
 */
function fingerprint(dir: string): string[] {
  const out: string[] = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).toSorted((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        out.push(`d ${relative(dir, full)}`)
        walk(full)
        continue
      }
      const st = statSync(full)
      out.push(`f ${relative(dir, full)} ${st.size} ${st.mtimeMs}`)
    }
  }
  walk(dir)
  return out
}

describe('resolveTaskPlan — fork mode', () => {
  test('names the branch, the base, the worktree location, the agent and the rank', () => {
    const repo = makeRepo()
    const resolution = resolveTaskPlan(deps(repo), { title: 'Fix flaky cleanup', autoShip: true })
    expect(resolution.ok).toBe(true)
    if (!resolution.ok) {
      return
    }
    expect(resolution.plan).toEqual({
      mode: 'fork',
      repo,
      title: 'Fix flaky cleanup',
      branch: 'codesema/task-fix-flaky-cleanup',
      branch_certain: true,
      worktree_root: join(repo, '.codesema', 'worktrees'),
      base: 'main',
      target: 'main',
      isolation: 'policy',
      isolation_reason: UNPROBED_ISOLATION.reason,
      agent: 'claude -p',
      queue_position: null,
      issue: null,
      auto_ship: true,
    })
    // The record `create` will write is derived from the SAME resolution: a
    // fork's branch is minted at launch, and a blank base stays blank so the
    // runner still auto-detects.
    expect(resolution.record).toEqual({
      branch: '',
      base: '',
      workOn: false,
      isolation: 'policy',
      isolationReason: UNPROBED_ISOLATION.reason,
      agent: 'claude -p',
    })
  })

  test('an explicit base is honoured, and lands on the record for the runner', () => {
    const repo = makeRepo()
    git(repo, ['branch', 'feature'])
    const resolution = resolveTaskPlan(deps(repo), {
      title: 'On feature',
      autoShip: false,
      base: 'origin/feature',
    })
    expect(resolution.ok).toBe(true)
    if (!resolution.ok) {
      return
    }
    // 'origin/feature' and 'feature' are ONE branch: the plan says the short name.
    expect(resolution.plan.base).toBe('feature')
    expect(resolution.plan.target).toBe('feature')
    expect(resolution.record.base).toBe('feature')
  })

  test('a collision moves the announced branch, exactly as the creation would', () => {
    const repo = makeRepo()
    git(repo, ['branch', 'codesema/task-fix-flaky-cleanup'])
    const resolution = resolveTaskPlan(deps(repo), { title: 'Fix flaky cleanup', autoShip: false })
    expect(resolution.ok && resolution.plan.branch).toBe('codesema/task-fix-flaky-cleanup-2')
    expect(resolution.ok && resolution.plan.branch_certain).toBe(true)
  })

  test('past 99 collisions the plan STOPS promising a name instead of guessing one', () => {
    const repo = makeRepo()
    const head = git(repo, ['rev-parse', 'HEAD'])
    const refs = [
      `create refs/heads/codesema/task-crowded ${head}`,
      ...Array.from(
        { length: 98 },
        (_, n) => `create refs/heads/codesema/task-crowded-${n + 2} ${head}`,
      ),
    ].join('\n')
    execFileSync('git', ['update-ref', '--stdin'], { cwd: repo, input: `${refs}\n` })

    const resolution = resolveTaskPlan(deps(repo), { title: 'crowded', autoShip: false })
    expect(resolution.ok && resolution.plan.branch_certain).toBe(false)
  })

  test('no trunk anywhere: the plan SAYS it could not find a base, and refuses nothing', () => {
    const bare = mkdtempSync(join(tmpdir(), 'codesema-task-plan-empty-'))
    cleanups.push(bare)
    execFileSync('git', ['init', '-b', 'wip'], { cwd: bare, stdio: 'ignore' })

    const resolution = resolveTaskPlan(deps(bare), { title: 'nowhere', autoShip: false })
    expect(resolution.ok).toBe(true)
    if (!resolution.ok) {
      return
    }
    // `create` does not refuse this either (the LAUNCH is where a fork's base
    // is resolved), so the plan states the gap rather than inventing a base.
    expect(resolution.plan.base).toBe('')
    expect(resolution.plan.target).toBe('')
    expect(resolution.plan.base_note).toBe(t('task.noBase'))
  })

  test('the one-active-conversation 409 does NOT reach fork mode', () => {
    const repo = makeRepo()
    git(repo, ['branch', 'feature'])
    const resolution = resolveTaskPlan(
      deps(repo, { tasks: () => [activeRecord('aaaaaaaaaaaa', 'feature')] }),
      { title: 'a fork', autoShip: false, base: 'feature' },
    )
    expect(resolution.ok).toBe(true)
  })
})

describe('resolveTaskPlan — work-on mode', () => {
  test('the branch is the caller’s own, the target becomes the MR target', () => {
    const repo = makeRepo()
    git(repo, ['branch', 'fix/x'])
    git(repo, ['branch', 'release'])
    const resolution = resolveTaskPlan(deps(repo), {
      title: 'work on it',
      autoShip: false,
      branch: 'fix/x',
      target: 'release',
    })
    expect(resolution.ok).toBe(true)
    if (!resolution.ok) {
      return
    }
    expect(resolution.plan.mode).toBe('work_on')
    expect(resolution.plan.branch).toBe('fix/x')
    // Nothing is branched: a work-on conversation continues its own branch,
    // which is the very emptiness the worktree layer reports for `base`.
    expect(resolution.plan.base).toBe('')
    expect(resolution.plan.target).toBe('release')
    expect(resolution.record).toMatchObject({ branch: 'fix/x', base: 'release', workOn: true })
  })

  test('an unresolvable target falls back to the detected trunk, never a 400', () => {
    const repo = makeRepo()
    git(repo, ['branch', 'fix/x'])
    const resolution = resolveTaskPlan(deps(repo), {
      title: 'work on it',
      autoShip: false,
      branch: 'fix/x',
      target: 'gone-branch',
    })
    expect(resolution.ok && resolution.plan.target).toBe('main')
  })

  test('a branch that does not exist is a 400', () => {
    const repo = makeRepo()
    expect(resolveTaskPlan(deps(repo), { title: 't', autoShip: false, branch: 'ghost' })).toEqual({
      ok: false,
      code: 400,
      error: "branch 'ghost' does not exist",
    })
  })

  test('an active conversation on the branch is a 409 that NAMES it', () => {
    const repo = makeRepo()
    git(repo, ['branch', 'fix/x'])
    expect(
      resolveTaskPlan(deps(repo, { tasks: () => [activeRecord('aaaaaaaaaaaa', 'fix/x')] }), {
        title: 't',
        autoShip: false,
        branch: 'fix/x',
      }),
    ).toEqual({
      ok: false,
      code: 409,
      error: "a conversation is already active on branch 'fix/x'",
      existing_task_id: 'aaaaaaaaaaaa',
    })
  })

  test('a branch checked out elsewhere is a 409 naming the worktree holding it', () => {
    const repo = makeRepo()
    git(repo, ['branch', 'fix/x'])
    const other = join(repo, 'other-checkout')
    git(repo, ['worktree', 'add', other, 'fix/x'])
    const resolution = resolveTaskPlan(deps(repo), {
      title: 't',
      autoShip: false,
      branch: 'fix/x',
    })
    expect(resolution).toMatchObject({ ok: false, code: 409 })
    expect(resolution.ok ? '' : resolution.error).toContain(other)
  })

  test('the MAIN worktree counts: the checked-out default branch is a 409 too', () => {
    const repo = makeRepo()
    const resolution = resolveTaskPlan(deps(repo), {
      title: 't',
      autoShip: false,
      branch: 'main',
    })
    expect(resolution).toMatchObject({ ok: false, code: 409 })
    expect(resolution.ok ? '' : resolution.error).toContain(repo)
  })
})

describe('resolveTaskPlan — shape refusals', () => {
  test('branch and base together, over-long and option-lookalike names', () => {
    const repo = makeRepo()
    const plan = (input: Parameters<typeof resolveTaskPlan>[1]) =>
      resolveTaskPlan(deps(repo), input)
    expect(plan({ title: 't', autoShip: false, branch: 'a', base: 'b' })).toEqual({
      ok: false,
      code: 400,
      error: "'branch' and 'base' are mutually exclusive",
    })
    expect(plan({ title: 't', autoShip: false, base: '-evil' })).toEqual({
      ok: false,
      code: 400,
      error: "invalid base branch name '-evil'",
    })
    expect(plan({ title: 't', autoShip: false, branch: '-evil' })).toEqual({
      ok: false,
      code: 400,
      error: "invalid branch name '-evil'",
    })
    expect(plan({ title: 't', autoShip: false, base: 'x'.repeat(201) })).toMatchObject({
      code: 400,
      error: 'base too long (max 200)',
    })
    expect(plan({ title: 't', autoShip: false, branch: 'x'.repeat(201) })).toMatchObject({
      code: 400,
      error: 'branch too long (max 200)',
    })
    expect(plan({ title: 't', autoShip: false, base: 'ghost' })).toEqual({
      ok: false,
      code: 400,
      error: "base branch 'ghost' does not exist",
    })
  })

  test('an unknown agent is refused; a known id is expanded to its command', () => {
    const repo = makeRepo()
    expect(
      resolveTaskPlan(deps(repo), { title: 't', autoShip: false, agent: 'my-agent run' }),
    ).toEqual({ ok: false, code: 400, error: "unknown agent 'my-agent run'" })
    // A known id is expanded, and the task's own pick beats the project's.
    const resolution = resolveTaskPlan(
      deps(repo, { runtime: { command: 'claude -p --model haiku', isolationMode: 'policy' } }),
      { title: 't', autoShip: false, agent: 'claude' },
    )
    expect(resolution.ok && resolution.plan.agent).toBe('claude -p')
    // …and it is the command the ISOLATION is decided against: an opencode
    // task in a policy project is refused, whatever the project's own agent is.
    expect(
      resolveTaskPlan(deps(repo), { title: 't', autoShip: false, agent: 'opencode' }),
    ).toMatchObject({ ok: false, code: 400 })
  })

  test('the agent command comes from THIS project’s runtime, never a global one', () => {
    const repo = makeRepo()
    const resolution = resolveTaskPlan(
      deps(repo, { runtime: { command: 'claude -p --model opus', isolationMode: 'policy' } }),
      { title: 't', autoShip: false },
    )
    expect(resolution.ok && resolution.plan.agent).toBe('claude -p --model opus')
  })
})

describe('resolveTaskPlan — isolation is announced, never overstated', () => {
  const machine = (over: Partial<IsolationProbe>): IsolationProbe => ({
    ...UNPROBED_ISOLATION,
    ...over,
  })

  test('an auto workspace with no runtime plans policy AND says why', () => {
    const repo = makeRepo()
    const reason = t('isolation.reasonNoRuntime')
    const resolution = resolveTaskPlan(
      deps(repo, {
        runtime: { command: 'claude -p', isolationMode: 'auto' },
        probe: machine({ configured: 'auto', reason }),
      }),
      { title: 't', autoShip: false },
    )
    expect(resolution.ok).toBe(true)
    if (!resolution.ok) {
      return
    }
    expect(resolution.plan.isolation).toBe('policy')
    expect(resolution.plan.isolation_reason).toBe(reason)
  })

  test('a reachable runtime plans the cage, with the probe’s own words', () => {
    const repo = makeRepo()
    const resolution = resolveTaskPlan(
      deps(repo, {
        runtime: { command: 'claude -p', isolationMode: 'container' },
        probe: machine({
          available: true,
          mode: 'container',
          configured: 'container',
          runtime: 'podman',
          reason: 'podman is available',
        }),
      }),
      { title: 't', autoShip: false },
    )
    expect(resolution.ok && resolution.plan.isolation).toBe('container')
    expect(resolution.ok && resolution.plan.isolation_reason).toBe('podman is available')
  })

  test('configured container without a runtime is a 409 resource_busy, and no plan', () => {
    const repo = makeRepo()
    const reason = t('isolation.reasonNoRuntime')
    expect(
      resolveTaskPlan(
        deps(repo, {
          runtime: { command: 'claude -p', isolationMode: 'container' },
          probe: machine({ configured: 'container', reason }),
        }),
        { title: 't', autoShip: false },
      ),
    ).toEqual({
      ok: false,
      code: 409,
      error: t('isolation.unavailable', { reason }),
      reason_code: 'resource_busy',
    })
  })

  // `resolveTaskIsolation` returns null in TWO cases, not one. The second is
  // the one a preview must not get wrong: it is a 400 (waiting will never fix
  // a configuration), not the retryable 409 above.
  test('an agent the cage has no image for is a 400, never a retryable 409', () => {
    const repo = makeRepo()
    const resolution = resolveTaskPlan(
      deps(repo, {
        runtime: { command: 'grok', isolationMode: 'container' },
        probe: machine({ configured: 'container', available: true, runtime: 'podman' }),
      }),
      { title: 't', autoShip: false },
    )
    expect(resolution).toMatchObject({ ok: false, code: 400 })
    expect(resolution.ok ? undefined : resolution.reason_code).toBeUndefined()
  })

  test('opencode under policy is a 400: a host run of it is unsafe', () => {
    const repo = makeRepo()
    const resolution = resolveTaskPlan(
      deps(repo, { runtime: { command: 'opencode run', isolationMode: 'policy' } }),
      { title: 't', autoShip: false },
    )
    expect(resolution).toMatchObject({ ok: false, code: 400 })
    expect(resolution.ok ? '' : resolution.error).toContain(t('isolation.reasonPolicyUnsafe'))
    expect(resolution.ok ? undefined : resolution.reason_code).toBeUndefined()
  })
})

describe('resolveTaskPlan — the queue verdict is carried, not acted on', () => {
  test('the announced rank is the queue’s projection', () => {
    const repo = makeRepo()
    const resolution = resolveTaskPlan(
      deps(repo, { admission: () => ({ admissible: true, position: 3 }) }),
      { title: 't', autoShip: false },
    )
    expect(resolution.ok && resolution.plan.queue_position).toBe(3)
  })

  test('a refusing queue is HANDED BACK, so create can still settle a record and preview can 503', () => {
    const repo = makeRepo()
    const resolution = resolveTaskPlan(
      deps(repo, { admission: () => ({ admissible: false, reason: 'the line is full' }) }),
      { title: 't', autoShip: false },
    )
    expect(resolution.ok).toBe(true)
    if (!resolution.ok) {
      return
    }
    expect(resolution.admission).toEqual({ admissible: false, reason: 'the line is full' })
    // No rank is invented for a task the line would not take.
    expect(resolution.plan.queue_position).toBeNull()
  })

  // Review round 1, M29: this used to mount ONE refusal (`branch: 'ghost'`),
  // and that one is the third guard of the first mode — a queue read moved
  // anywhere after it was never counted, so the assertion held for the wrong
  // reason. Every refusal `resolveTaskPlan` can produce is exercised here
  // instead, so a read hoisted above ANY of them turns this red.
  test('the queue is consulted only once every other guard has passed — for every refusal', () => {
    const repo = makeRepo()
    git(repo, ['branch', 'fix/x'])
    let asked = 0
    const counting = (over: Partial<TaskPlanDeps> = {}): TaskPlanDeps =>
      deps(repo, {
        admission: () => {
          asked++
          return { admissible: true, position: null }
        },
        ...over,
      })
    const refusals: [string, () => TaskPlanResolution][] = [
      [
        'branch and base together',
        () => resolveTaskPlan(counting(), planFor({ branch: 'fix/x', base: 'main' })),
      ],
      [
        'base too long',
        () => resolveTaskPlan(counting(), planFor({ base: 'b'.repeat(TASK_BASE_MAX + 1) })),
      ],
      ['base looks like an option', () => resolveTaskPlan(counting(), planFor({ base: '-evil' }))],
      ['base does not exist', () => resolveTaskPlan(counting(), planFor({ base: 'ghost' }))],
      [
        'branch too long',
        () => resolveTaskPlan(counting(), planFor({ branch: 'b'.repeat(TASK_BASE_MAX + 1) })),
      ],
      [
        'branch looks like an option',
        () => resolveTaskPlan(counting(), planFor({ branch: '-evil' })),
      ],
      ['branch does not exist', () => resolveTaskPlan(counting(), planFor({ branch: 'ghost' }))],
      [
        'a conversation is already active there',
        () =>
          resolveTaskPlan(
            counting({ tasks: () => [activeRecord('aaaaaaaaaaaa', 'fix/x')] }),
            planFor({ branch: 'fix/x' }),
          ),
      ],
      [
        'agent too long',
        () =>
          resolveTaskPlan(
            counting(),
            planFor({ agent: `claude -p ${'x'.repeat(TASK_AGENT_MAX)}` }),
          ),
      ],
      ['unknown agent', () => resolveTaskPlan(counting(), planFor({ agent: 'my-agent run' }))],
      [
        'isolation refuses with a 400',
        () =>
          resolveTaskPlan(
            counting({ runtime: { command: 'opencode run', isolationMode: 'policy' } }),
            planFor({}),
          ),
      ],
      [
        'isolation refuses with a 409',
        () =>
          resolveTaskPlan(
            counting({ runtime: { command: 'claude -p', isolationMode: 'container' } }),
            planFor({}),
          ),
      ],
    ]

    for (const [label, run] of refusals) {
      asked = 0
      expect({ label, ok: run().ok, asked }).toEqual({ label, ok: false, asked: 0 })
    }
    // …and the control, without which "never asked" would also be satisfied by
    // never asking at all: an input that passes every guard reaches it, once.
    asked = 0
    expect(resolveTaskPlan(counting(), planFor()).ok).toBe(true)
    expect(asked).toBe(1)
  })
})

// Review round 1. Two rules of this module that no test exercised: the agent
// cap (M32) and the single computation path for a fork's base (M81, the very
// unicity design point D-a exists to protect).
describe('resolveTaskPlan — the rules the campaign found unguarded', () => {
  // The `target` is the ONE option-lookalike guard that refuses nothing: an
  // MR target that starts with a dash is silently ignored and the trunk is
  // detected instead. `resolveBranchRef` fully qualifies the name, so the
  // guard only bites when a branch REALLY bears that name — which is exactly
  // the input no fixture had, and why dropping the check left the suite green.
  test('an MR target that looks like a git option is never honoured, even when it exists', () => {
    const repo = makeRepo()
    git(repo, ['branch', 'fix/x'])
    git(repo, ['update-ref', 'refs/heads/-evil', 'HEAD'])
    // It really is a branch, and it really does resolve…
    expect(git(repo, ['for-each-ref', '--format=%(refname)', 'refs/heads/'])).toContain(
      'refs/heads/-evil',
    )
    const resolution = resolveTaskPlan(deps(repo), planFor({ branch: 'fix/x', target: '-evil' }))
    // …and the conversation still targets the trunk, not it.
    expect(resolution.ok && resolution.plan.target).toBe('main')
    expect(resolution.ok && resolution.record.base).toBe('main')
    // The control: a target that is a normal name IS honoured, so the row
    // above is about the dash and not about targets being ignored.
    git(repo, ['branch', 'release'])
    const honoured = resolveTaskPlan(deps(repo), planFor({ branch: 'fix/x', target: 'release' }))
    expect(honoured.ok && honoured.plan.target).toBe('release')
    // …and 'origin/release' is the SAME target, under the one-identity rule
    // the rest of this module lives by. Dropping the normalization here does
    // not refuse: it silently falls back to the trunk, which is why nothing
    // was catching it.
    const qualified = resolveTaskPlan(
      deps(repo),
      planFor({ branch: 'fix/x', target: 'origin/release' }),
    )
    expect(qualified.ok && qualified.plan.target).toBe('release')
    expect(qualified.ok && qualified.record.base).toBe('release')
  })

  // The same rule, on the two guards a work-on creation owns. Their order
  // against the MR-target resolution is only observable in a repo with no
  // trunk at all — where resolving the target REFUSES — and no fixture in
  // this file had one.
  test('the work-on 409s are answered before the MR target is even looked for', () => {
    // A repo whose only branch is none of develop/main/master, and with no
    // origin/HEAD: `detectTaskBase` has nothing to answer with.
    const repo = mkdtempSync(join(tmpdir(), 'codesema-task-plan-trunkless-'))
    cleanups.push(repo)
    const run = (args: string[]) =>
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
        cwd: repo,
        stdio: 'ignore',
      })
    run(['init', '-b', 'wip'])
    writeFileSync(join(repo, 'base.txt'), 'a\n')
    run(['add', '-A'])
    run(['commit', '-m', 'init'])

    // A conversation is already live on it: that 409, not the trunk's 400.
    expect(
      resolveTaskPlan(
        deps(repo, { tasks: () => [activeRecord('aaaaaaaaaaaa', 'wip')] }),
        planFor({ branch: 'wip' }),
      ),
    ).toEqual({
      ok: false,
      code: 409,
      error: "a conversation is already active on branch 'wip'",
      existing_task_id: 'aaaaaaaaaaaa',
    })

    // And with no conversation, the branch is still checked out in the main
    // worktree: that 409 too comes before the target is looked for.
    expect(resolveTaskPlan(deps(repo), planFor({ branch: 'wip' }))).toMatchObject({
      ok: false,
      code: 409,
      error: expect.stringContaining('is already checked out'),
    })

    // The control: with no branch of its own to trip over, the very same repo
    // IS refused by the target resolution — which is what makes the two rows
    // above statements about ORDER rather than about this repo.
    run(['branch', 'other'])
    expect(resolveTaskPlan(deps(repo), planFor({ branch: 'other' }))).toEqual({
      ok: false,
      code: 400,
      error: t('task.noBase'),
    })
  })

  // The docstring has always said the order is not cosmetic — "reordering it
  // would change which refusal a caller sees when two of them apply at once" —
  // and nothing was checking it. Splitting the function into stages (round 1,
  // m5) made that gap into a live hazard: swapping two `if (!x.ok) return x`
  // lines is a one-character edit that no test noticed.
  test('when two refusals apply at once, the caller sees the FIRST guard in create’s order', () => {
    const repo = makeRepo()
    git(repo, ['branch', 'fix/x'])
    const both = (over: Partial<TaskPlanInput>, error: string) => {
      const resolution = resolveTaskPlan(
        deps(repo, { runtime: { command: 'claude -p', isolationMode: 'container' } }),
        planFor(over),
      )
      expect({ input: over, error: resolution.ok ? 'a plan' : resolution.error }).toEqual({
        input: over,
        error,
      })
    }
    // Every row names an input that trips TWO guards at once. The expected
    // sentence is the earlier guard's, always.
    both(
      { branch: 'fix/x', base: 'main', agent: 'my-agent run' },
      "'branch' and 'base' are mutually exclusive",
    )
    both({ base: 'ghost', agent: 'my-agent run' }, "base branch 'ghost' does not exist")
    both({ base: '-evil', agent: 'my-agent run' }, "invalid base branch name '-evil'")
    both({ branch: 'ghost', agent: 'my-agent run' }, "branch 'ghost' does not exist")
    both({ branch: '-evil', agent: 'my-agent run' }, "invalid branch name '-evil'")
    // The agent beats the isolation: this deps() is a 'container' project with
    // no runtime, so a valid agent would be refused by the probe with a 409 —
    // an unknown one never gets that far.
    both({ agent: 'my-agent run' }, "unknown agent 'my-agent run'")
    // …and the control, so the row above is not just "everything is a 400":
    // the very same project, with the agent left out, IS refused by the probe.
    const isolationRefusal = resolveTaskPlan(
      deps(repo, { runtime: { command: 'claude -p', isolationMode: 'container' } }),
      planFor(),
    )
    expect(isolationRefusal).toMatchObject({ ok: false, code: 409, reason_code: 'resource_busy' })
  })

  test('an over-long agent is refused even though its BINARY is a known one', () => {
    const repo = makeRepo()
    // The discriminating input: `resolveKnownAgentCommand` hands a command
    // whose first word is a known binary straight back, verbatim and
    // unmeasured — so the cap is the ONLY thing standing between this and a
    // 518-character `agent` on the plan and on the record.
    const long = `claude -p --model ${'x'.repeat(500)}`
    expect(long.length).toBeGreaterThan(TASK_AGENT_MAX)
    expect(resolveKnownAgentCommand(long)).toBe(long)
    expect(resolveTaskPlan(deps(repo), { title: 't', autoShip: false, agent: long })).toEqual({
      ok: false,
      code: 400,
      error: `agent too long (max ${TASK_AGENT_MAX})`,
    })
    // One character under the cap is a plan, not a refusal: the guard is a
    // boundary, not a ban on long commands.
    const atCap = `claude -p ${'x'.repeat(TASK_AGENT_MAX - 'claude -p '.length)}`
    expect(atCap).toHaveLength(TASK_AGENT_MAX)
    const ok = resolveTaskPlan(deps(repo), { title: 't', autoShip: false, agent: atCap })
    expect(ok.ok && ok.plan.agent).toBe(atCap)
    expect(ok.ok && ok.record.agent).toBe(atCap)
  })

  // D-a: the plan and the materialization must reach the base through ONE
  // function. Nothing was pinning it — a plan that called `detectTaskBase`
  // itself left the whole suite green, because on a healthy repo the two
  // agree. They stop agreeing here: `detectTaskBase` accepts any revision
  // bearing a candidate name, and a TAG called 'develop' is one; only
  // `resolveForkBase` insists on a branch a worktree can start from, and
  // REFUSES otherwise — which is precisely what the launch would do.
  test('a fork’s base comes from resolveForkBase, refusals included', () => {
    const repo = makeRepo('main')
    git(repo, ['tag', 'develop'])
    // The trap: the detector answers 'develop' for this repo…
    expect(detectTaskBase(repo)).toBe('develop')
    // …and the resolver, which is what the worktree actually goes through,
    // refuses it outright.
    expect(() => resolveForkBase(repo)).toThrow(t('task.unknownBase', { base: 'develop' }))

    const resolution = resolveTaskPlan(deps(repo), { title: 't', autoShip: false })
    expect(resolution.ok).toBe(true)
    if (!resolution.ok) {
      return
    }
    // No base is announced, and the note is the launch's OWN words — not
    // 'develop', which is what a second derivation would have promised.
    expect(resolution.plan.base).toBe('')
    expect(resolution.plan.target).toBe('')
    expect(resolution.plan.base_note).toBe(t('task.unknownBase', { base: 'develop' }))
  })

  test('and when the base DOES resolve, the plan announces resolveForkBase’s answer', () => {
    const repo = makeRepo('main')
    git(repo, ['branch', 'develop'])
    const resolution = resolveTaskPlan(deps(repo), { title: 't', autoShip: false })
    expect(resolution.ok && resolution.plan.base).toBe(resolveForkBase(repo).base)
    expect(resolution.ok && resolution.plan.base).toBe('develop')
    expect(resolution.ok && resolution.plan.base_note).toBeUndefined()
  })
})

describe('resolveTaskPlan writes nothing at all', () => {
  test('the repo tree, its refs and its worktrees are identical before and after', () => {
    const repo = makeRepo()
    git(repo, ['branch', 'codesema/task-same-title'])
    git(repo, ['branch', 'fix/x'])
    const before = fingerprint(repo)
    const refsBefore = git(repo, ['for-each-ref', '--format=%(refname) %(objectname)'])
    const worktreesBefore = git(repo, ['worktree', 'list', '--porcelain'])

    for (let n = 0; n < 3; n++) {
      resolveTaskPlan(deps(repo), { title: 'Same title', autoShip: false })
      resolveTaskPlan(deps(repo), { title: 'Same title', autoShip: false, branch: 'fix/x' })
    }

    expect(fingerprint(repo)).toEqual(before)
    expect(git(repo, ['for-each-ref', '--format=%(refname) %(objectname)'])).toBe(refsBefore)
    expect(git(repo, ['worktree', 'list', '--porcelain'])).toBe(worktreesBefore)
    expect(existsSync(join(repo, '.codesema'))).toBe(false)
  })

  test('two identical resolutions produce the identical plan: nothing is consumed', () => {
    const repo = makeRepo()
    const input = { title: 'Fix flaky cleanup', autoShip: false } as const
    const first = resolveTaskPlan(deps(repo), input)
    const second = resolveTaskPlan(deps(repo), input)
    expect(second).toEqual(first)
  })
})
