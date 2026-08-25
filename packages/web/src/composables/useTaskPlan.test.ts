import { describe, expect, test } from 'bun:test'
import { catalogs, t } from '../i18n'
import type { TaskPlan } from '../types'
import {
  createPlanRequests,
  EMPTY_PLAN,
  parseTaskPlan,
  planBaseLine,
  planBranchLine,
  planIsolationLine,
  planIssueLine,
  planQueueLine,
  planRequestBody,
  planWorktreeLine,
  retargetDraft,
  retargetLabel,
  type PlanPreviewFn,
} from './useTaskPlan'
import { forkDraft, workonDraft } from './useWorkspaceNav'

const PLAN: TaskPlan = {
  mode: 'fork',
  repo: '/home/me/repo',
  title: 'Fix flaky cleanup',
  branch: 'codesema/task-fix-flaky-cleanup',
  branch_certain: true,
  worktree_root: '/home/me/repo/.codesema/worktrees',
  base: 'develop',
  target: 'develop',
  isolation: 'container',
  isolation_reason: 'podman is available',
  agent: 'claude -p',
  queue_position: null,
  issue: null,
  auto_ship: false,
}

describe('planRequestBody', () => {
  const input = { title: 'Fix flaky cleanup', prompt: 'do it', autoShip: false }

  test('a fork draft sends its base, never a branch', () => {
    expect(planRequestBody('p1', forkDraft('develop'), input)).toEqual({
      project_id: 'p1',
      title: 'Fix flaky cleanup',
      prompt: 'do it',
      autoShip: false,
      base: 'develop',
    })
  })

  test('a work-on draft sends its branch and, when it has one, its target', () => {
    expect(planRequestBody('p1', workonDraft('fix/x', 'release'), input)).toEqual({
      project_id: 'p1',
      title: 'Fix flaky cleanup',
      prompt: 'do it',
      autoShip: false,
      branch: 'fix/x',
      target: 'release',
    })
    // No MR behind the click: `target` is omitted, never sent as null — the
    // server's own auto-detection is the honest answer there.
    expect(planRequestBody('p1', workonDraft('fix/x', null), input)).not.toHaveProperty('target')
  })

  test('the agent rides along only when the composer picked one', () => {
    expect(
      planRequestBody('p1', forkDraft('main'), { ...input, agent: 'opencode run' }),
    ).toMatchObject({ agent: 'opencode run' })
    expect(planRequestBody('p1', forkDraft('main'), { ...input, agent: '' })).not.toHaveProperty(
      'agent',
    )
  })

  test('the body carries nothing that could create a task', () => {
    const body = planRequestBody('p1', workonDraft('fix/x', 'release'), {
      ...input,
      autoShip: true,
    })
    expect(Object.keys(body).toSorted()).toEqual(
      ['autoShip', 'branch', 'project_id', 'prompt', 'target', 'title'].toSorted(),
    )
  })
})

describe('retargetDraft — the correction reuses the deck’s own draft model', () => {
  test('a fork draft is retargeted onto another base', () => {
    expect(retargetDraft(forkDraft('main'), 'develop')).toEqual(forkDraft('develop'))
  })

  test('a work-on draft keeps the merge target it was opened with', () => {
    expect(retargetDraft(workonDraft('fix/x', 'release'), 'fix/y')).toEqual(
      workonDraft('fix/y', 'release'),
    )
  })

  test('a blank or unchanged correction is a no-op, by identity', () => {
    const draft = forkDraft('main')
    expect(retargetDraft(draft, '  ')).toBe(draft)
    expect(retargetDraft(draft, 'main')).toBe(draft)
    expect(retargetDraft(draft, '  main  ')).toBe(draft)
  })

  test('the field is labelled for what it actually changes in each mode', () => {
    expect(retargetLabel(forkDraft('main'))).toBe(t('workspace.planBaseLabel'))
    expect(retargetLabel(workonDraft('fix/x', null))).toBe(t('workspace.planBranchLabel'))
    expect(retargetLabel(forkDraft('main'))).not.toBe(retargetLabel(workonDraft('fix/x', null)))
  })
})

describe('parseTaskPlan — whitelist and truncate, never throw', () => {
  test('a complete plan comes back intact', () => {
    expect(parseTaskPlan(JSON.parse(JSON.stringify(PLAN)))).toEqual(PLAN)
  })

  test('anything that is not a plan degrades to null rather than half a panel', () => {
    for (const junk of [null, undefined, 42, 'plan', [], {}, { branch: '' }, { branch: 7 }]) {
      expect(parseTaskPlan(junk)).toBeNull()
    }
  })

  test('an unknown isolation NEVER reads as the cage', () => {
    expect(parseTaskPlan({ ...PLAN, isolation: 'sandboxed' })?.isolation).toBe('policy')
    expect(parseTaskPlan({ ...PLAN, isolation: undefined })?.isolation).toBe('policy')
    expect(parseTaskPlan({ ...PLAN, isolation: 'container' })?.isolation).toBe('container')
  })

  test('a branch the server did not certify is never read as certain', () => {
    expect(parseTaskPlan({ ...PLAN, branch_certain: undefined })?.branch_certain).toBe(false)
    expect(parseTaskPlan({ ...PLAN, branch_certain: 'yes' })?.branch_certain).toBe(false)
  })

  test('a nonsense queue position becomes "not waiting", never a rank', () => {
    expect(parseTaskPlan({ ...PLAN, queue_position: 'soon' })?.queue_position).toBeNull()
    expect(parseTaskPlan({ ...PLAN, queue_position: Number.NaN })?.queue_position).toBeNull()
    expect(parseTaskPlan({ ...PLAN, queue_position: 3 })?.queue_position).toBe(3)
  })

  test('an unusable issue reference is dropped whole', () => {
    expect(parseTaskPlan({ ...PLAN, issue: { forge: 'bitbucket', iid: 1 } })?.issue).toBeNull()
    expect(parseTaskPlan({ ...PLAN, issue: { forge: 'github', iid: '1' } })?.issue).toBeNull()
    expect(
      parseTaskPlan({
        ...PLAN,
        issue: { forge: 'github', project: 'acme/repo', iid: 42, url: 'https://x/42' },
      })?.issue,
    ).toEqual({ forge: 'github', project: 'acme/repo', iid: 42, url: 'https://x/42' })
  })

  test('over-long strings are truncated instead of blowing up the panel', () => {
    const parsed = parseTaskPlan({ ...PLAN, repo: 'x'.repeat(2000), branch: 'b'.repeat(2000) })
    expect(parsed?.repo).toHaveLength(500)
    expect(parsed?.branch).toHaveLength(200)
  })

  test('a base_note is kept, and absence stays absence', () => {
    expect(parseTaskPlan({ ...PLAN, base_note: 'no trunk' })?.base_note).toBe('no trunk')
    expect(parseTaskPlan(PLAN)).not.toHaveProperty('base_note')
  })
})

describe('the lines the panel renders', () => {
  test('a certain branch is shown as is; an uncertain one is NOT promised', () => {
    expect(planBranchLine(PLAN)).toBe(PLAN.branch)
    const uncertain = planBranchLine({ ...PLAN, branch_certain: false })
    expect(uncertain).not.toBe(PLAN.branch)
    expect(uncertain).toContain(PLAN.branch)
  })

  test('the worktree line names the root and says the id is still to come', () => {
    expect(planWorktreeLine(PLAN)).toContain(PLAN.worktree_root)
    expect(planWorktreeLine(PLAN)).not.toBe(PLAN.worktree_root)
  })

  test('a base the server could not detect says WHY, never an empty cell', () => {
    const line = planBaseLine({ ...PLAN, base: '', base_note: 'no trunk branch found' })
    expect(line).toContain('no trunk branch found')
    expect(planBaseLine({ ...PLAN, base: '' })).toBe(t('workspace.planNone'))
    expect(planBaseLine(PLAN)).toBe('develop')
  })

  test('no rank means "starts now", a rank means "waits at n"', () => {
    expect(planQueueLine(PLAN)).toBe(t('workspace.planQueueNow'))
    expect(planQueueLine({ ...PLAN, queue_position: 3 })).toContain('3')
    expect(planQueueLine({ ...PLAN, queue_position: 3 })).not.toBe(t('workspace.planQueueNow'))
  })

  test('the isolation is translated AND carries the server’s reason', () => {
    const caged = planIsolationLine(PLAN)
    expect(caged).toContain(t('workspace.planIsolationContainer'))
    expect(caged).toContain('podman is available')
    const host = planIsolationLine({ ...PLAN, isolation: 'policy', isolation_reason: 'no runtime' })
    expect(host).toContain(t('workspace.planIsolationPolicy'))
    expect(host).toContain('no runtime')
    // The two are never the same sentence: a degraded plan reads differently.
    expect(host).not.toBe(caged)
  })

  test('a plan with no ticket says so rather than showing a blank', () => {
    expect(planIssueLine(PLAN)).toBe(t('workspace.planNone'))
    expect(
      planIssueLine({
        ...PLAN,
        issue: { forge: 'github', project: 'acme/repo', iid: 42, url: 'https://x/42' },
      }),
    ).toBe('acme/repo#42')
  })
})

// The half of this ticket a human actually reads. Key parity is enforced
// elsewhere; what is enforced HERE is that the French is French — a catalog
// entry copy-pasted from the English satisfies parity perfectly and still
// ships an English panel to a French workspace.
describe('T2.6 plan labels are actually translated', () => {
  const keys = [
    'workspace.planTitle',
    'workspace.planLoading',
    'workspace.planError',
    'workspace.planNone',
    'workspace.planRepo',
    'workspace.planBranch',
    'workspace.planWorktree',
    'workspace.planBase',
    'workspace.planTarget',
    'workspace.planIsolation',
    'workspace.planAgent',
    'workspace.planQueue',
    'workspace.planIssue',
    'workspace.planBranchUncertain',
    'workspace.planBranchDerived',
    'workspace.planWorktreeValue',
    'workspace.planBaseUnknown',
    'workspace.planQueueNow',
    'workspace.planQueueAt',
    'workspace.planIsolationContainer',
    'workspace.planIsolationPolicy',
    'workspace.planBaseLabel',
    'workspace.planBranchLabel',
    'workspace.planRetarget',
    'workspace.planIndicative',
  ] as const

  /**
   * The five this ticket's vocabulary legitimately shares with English:
   * 'Worktree', 'Isolation', 'Agent', 'Ticket' and 'container' are the words
   * the rest of this French UI already uses (see 'workspace.tabDiff',
   * 'tabChecks', 'workspace.agentLabel'). Listed rather than skipped by a
   * heuristic, so adding a sixth is a deliberate act and not an accident.
   */
  const SHARED_WITH_ENGLISH = new Set([
    'workspace.planWorktree',
    'workspace.planIsolation',
    'workspace.planAgent',
    'workspace.planIssue',
    'workspace.planIsolationContainer',
  ])

  test('each key exists in both catalogs and differs from its English source', () => {
    const en = (catalogs.en ?? {}) as Record<string, string>
    const fr = (catalogs.fr ?? {}) as Record<string, string>
    for (const key of keys) {
      expect(en[key]?.trim()).toBeTruthy()
      expect(fr[key]?.trim()).toBeTruthy()
      if (!SHARED_WITH_ENGLISH.has(key)) {
        expect({ key, differs: fr[key] !== en[key] }).toEqual({ key, differs: true })
      }
    }
  })
})

// T2.6 review round 1, M75. The per-draft request machinery used to live
// inside WorkspaceView.vue, which cannot be mounted in a test (its setup
// builds `useTasks`) — so its one non-obvious rule, "a slow answer never
// overwrites a newer one", was pinned by a `toContain` on the source and by
// nothing else. Deleting the guard left the whole suite green.
/** Lets each preview call be answered by hand, in any order. */
function riggedPreview(): {
  preview: PlanPreviewFn
  bodies: Record<string, unknown>[]
  answer: (n: number, plan: TaskPlan) => void
  refuse: (n: number, error: string) => void
} {
  const bodies: Record<string, unknown>[] = []
  const pending: ((result: Awaited<ReturnType<PlanPreviewFn>>) => void)[] = []
  return {
    bodies,
    preview: (body) => {
      bodies.push(body)
      return new Promise((resolve) => pending.push(resolve))
    },
    answer: (n, plan) => pending[n]?.({ ok: true, plan }),
    refuse: (n, error) => pending[n]?.({ ok: false, status: 400, error }),
  }
}

/** Lets the 0 ms debounce timer, and the promise callbacks, actually run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('createPlanRequests — one draft, many questions, one answer', () => {
  test('an untouched draft has no plan, no error and nothing in flight', () => {
    const requests = createPlanRequests(riggedPreview().preview, 0)
    expect(requests.planOf('p/#draft/fork/develop')).toEqual(EMPTY_PLAN)
    expect(requests.promptOf('p/#draft/fork/develop')).toBe('')
  })

  test('a stale answer NEVER overwrites the plan a newer question got', async () => {
    const rig = riggedPreview()
    const requests = createPlanRequests(rig.preview, 0)
    const key = 'p/#draft/fork/develop'
    const older: TaskPlan = { ...PLAN, base: 'develop', branch: 'codesema/task-older' }
    const newer: TaskPlan = { ...PLAN, base: 'release', branch: 'codesema/task-newer' }

    requests.request(key, { base: 'develop' }, 'first prompt')
    await settle()
    requests.request(key, { base: 'release' }, 'second prompt')
    await settle()
    expect(rig.bodies).toEqual([{ base: 'develop' }, { base: 'release' }])

    // The newer question answers first…
    rig.answer(1, newer)
    await settle()
    expect(requests.planOf(key).plan).toEqual(newer)

    // …and the older one lands afterwards, as a slow server perfectly well
    // can. It describes a branch this draft is no longer targeting, so it is
    // dropped rather than rendered.
    rig.answer(0, older)
    await settle()
    expect(requests.planOf(key).plan).toEqual(newer)
    expect(requests.planOf(key).pending).toBe(false)
  })

  test('a refusal is shown with the server’s own words, never as an empty panel', async () => {
    const rig = riggedPreview()
    const requests = createPlanRequests(rig.preview, 0)
    const key = 'p/#draft/workon/ghost'

    requests.request(key, { branch: 'ghost' }, 'work on it')
    await settle()
    rig.refuse(0, "branch 'ghost' does not exist")
    await settle()

    expect(requests.planOf(key)).toEqual({
      plan: null,
      error: "branch 'ghost' does not exist",
      pending: false,
    })
  })

  test('a stale REFUSAL does not wipe a plan that arrived after it either', async () => {
    const rig = riggedPreview()
    const requests = createPlanRequests(rig.preview, 0)
    const key = 'p/#draft/workon/fix/x'

    requests.request(key, { branch: 'ghost' }, 'one')
    await settle()
    requests.request(key, { branch: 'fix/x' }, 'two')
    await settle()
    rig.answer(1, PLAN)
    await settle()
    rig.refuse(0, "branch 'ghost' does not exist")
    await settle()

    expect(requests.planOf(key).plan).toEqual(PLAN)
    expect(requests.planOf(key).error).toBeNull()
  })

  test('a draft that is forgotten stops listening: its answer belongs to nobody', async () => {
    const rig = riggedPreview()
    const requests = createPlanRequests(rig.preview, 0)
    const key = 'p/#draft/fork/develop'

    requests.request(key, { base: 'develop' }, 'typed')
    await settle()
    // What a correction, a close or a promotion does to the old key.
    requests.forget(key)
    rig.answer(0, PLAN)
    await settle()

    expect(requests.planOf(key)).toEqual(EMPTY_PLAN)
    expect(requests.promptOf(key)).toBe('')
  })

  test('the debounce collapses a burst of keystrokes into ONE question', async () => {
    const rig = riggedPreview()
    const requests = createPlanRequests(rig.preview, 5)
    const key = 'p/#draft/fork/develop'
    for (const prompt of ['f', 'fi', 'fix', 'fix ', 'fix it']) {
      requests.request(key, { title: prompt }, prompt)
    }
    // Pending is shown from the first keystroke: the panel never claims the
    // stale plan is the current one.
    expect(requests.planOf(key).pending).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(rig.bodies).toEqual([{ title: 'fix it' }])
  })

  test('an empty prompt asks nothing at all, and clears whatever was shown', async () => {
    const rig = riggedPreview()
    const requests = createPlanRequests(rig.preview, 0)
    const key = 'p/#draft/fork/develop'

    requests.request(key, { title: 'x' }, 'x')
    await settle()
    rig.answer(0, PLAN)
    await settle()
    expect(requests.planOf(key).plan).toEqual(PLAN)

    // The human clears the composer: an empty prompt is a 400 on the creation
    // route too, and an error about nothing is worse than no panel.
    requests.request(key, { title: '' }, '')
    await settle()
    expect(requests.planOf(key)).toEqual(EMPTY_PLAN)
    expect(rig.bodies).toHaveLength(1)
  })

  test('the prompt is carried across the remount a correction causes', () => {
    const requests = createPlanRequests(riggedPreview().preview, 0)
    requests.carry('p/#draft/fork/release', 'ship it')
    expect(requests.promptOf('p/#draft/fork/release')).toBe('ship it')
    expect(requests.promptOf('p/#draft/fork/develop')).toBe('')
  })

  test('two drafts never answer for each other', async () => {
    const rig = riggedPreview()
    const requests = createPlanRequests(rig.preview, 0)
    const a = 'p/#draft/fork/develop'
    const b = 'p/#draft/workon/fix/x'
    const planB: TaskPlan = { ...PLAN, mode: 'work_on', branch: 'fix/x' }

    requests.request(a, { base: 'develop' }, 'aaa')
    requests.request(b, { branch: 'fix/x' }, 'bbb')
    await settle()
    rig.answer(1, planB)
    await settle()

    expect(requests.planOf(b).plan).toEqual(planB)
    expect(requests.planOf(a).plan).toBeNull()
    expect(requests.planOf(a).pending).toBe(true)
  })
})
