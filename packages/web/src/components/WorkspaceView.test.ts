import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

/**
 * WorkspaceView owns the stream, the registry and the deck: it cannot be
 * rendered off a prop bag the way TaskComposer can (its setup builds
 * `useTasks`, and an empty registry renders no draft column at all). What is
 * pinned here is the WIRING of the draft column, on the source itself.
 *
 * The reason this file exists is T2.6's own risk: the plan panel was added to
 * `TaskComposer.vue`, while the trunk warning and the `⎇`/`→` chips live
 * HERE, in the column around it. "Extend the composer" and "keep the warning"
 * are two different files, and nothing else in this repo would notice the
 * second one disappearing.
 */
const SOURCE = readFileSync(join(import.meta.dir, 'WorkspaceView.vue'), 'utf8')

describe('the draft column keeps what it already showed (T2.6 IV.3)', () => {
  test('the trunk warning is still rendered, on the work-on branch it warns about', () => {
    expect(SOURCE).toContain('workspace.draftTrunkWarning')
    expect(SOURCE).toContain('ws-draft-warning')
    // Still conditioned on the DRAFT's own branch being a trunk, not on
    // anything the plan says: the warning is about where the commits land.
    expect(SOURCE).toContain('isTrunkBranch(draftBranch(entry.draft))')
  })

  test('the two chips are still there, with their glyphs and their hints', () => {
    expect(SOURCE.split('ws-draft-chip').length - 1).toBeGreaterThanOrEqual(2)
    expect(SOURCE).toContain('⎇')
    expect(SOURCE).toContain('→')
    expect(SOURCE).toContain('workspace.draftBaseHint')
    expect(SOURCE).toContain('workspace.draftWorkonHint')
    expect(SOURCE).toContain('workspace.draftTargetHint')
  })

  test('the warning and the chips sit OUTSIDE the composer, before it', () => {
    const warningAt = SOURCE.indexOf('ws-draft-warning')
    const chipsAt = SOURCE.indexOf('ws-draft-chips')
    const composerAt = SOURCE.indexOf('<TaskComposer')
    expect(warningAt).toBeGreaterThan(-1)
    expect(chipsAt).toBeGreaterThan(-1)
    expect(composerAt).toBeGreaterThan(-1)
    expect(warningAt).toBeLessThan(composerAt)
    expect(chipsAt).toBeLessThan(composerAt)
  })
})

describe('the plan is wired to the draft, and never to a creation (T2.6 IV.1/IV.2/IV.4)', () => {
  test('the composer receives the draft itself and its plan', () => {
    for (const binding of [':draft="entry.draft"', ':plan=', ':plan-error=', ':plan-pending=']) {
      expect(SOURCE).toContain(binding)
    }
  })

  test('the corrections and the plan requests are handled, both without creating', () => {
    expect(SOURCE).toContain('@plan-input=')
    expect(SOURCE).toContain('@retarget=')
    // The correction goes through the deck's OWN draft swap — the same
    // mechanism the fork/work-on toggle uses — not a second draft model.
    expect(SOURCE).toContain('retargetDraft(draft, branch)')
    expect(SOURCE).toContain('deckSwapDraft(deck.value, projectId, draft, next)')
  })

  test('only the Launch path ever calls create; the plan path only previews', () => {
    // `create(` reaches the API in exactly the two places that launch a
    // conversation. A third call site appearing here is the regression this
    // asserts against.
    const createCalls = SOURCE.match(/await create\(/g) ?? []
    expect(createCalls).toHaveLength(2)
    const planFn = SOURCE.slice(
      SOURCE.indexOf('function onPlanInput('),
      SOURCE.indexOf('function onDraftRetarget('),
    )
    // The plan path goes through the preview machinery and nothing else. Its
    // BEHAVIOUR — debounce, and the run token that keeps a slow answer from
    // overwriting a newer one — is pinned in useTaskPlan.test.ts, which can
    // actually run it; what is pinned here is that this view still routes
    // through it and never reaches the creation route.
    expect(planFn).toContain('planRequests.request(')
    expect(planFn).toContain('planRequestBody(projectId, draft, input)')
    expect(planFn).not.toContain('create(')
    // And the wiring the machinery needs from the view: the preview function
    // itself, never `createTask`/`create`.
    expect(SOURCE).toContain('createPlanRequests((body) => preview(body))')
    const retargetFn = SOURCE.slice(
      SOURCE.indexOf('function onDraftRetarget('),
      SOURCE.indexOf('/** Every branch/MR click'),
    )
    expect(retargetFn).not.toContain('create(')
  })

  // The one link in the correction that no test can EXERCISE: this view is not
  // mountable, so its wiring is asserted on the source. Both halves it joins
  // are exercised for real, on either side of it — `carry`/`promptOf` in
  // useTaskPlan.test.ts, and a mount with a carried `initialPrompt` in
  // TaskComposer.test.ts — which is what makes this a statement about the
  // WIRING rather than a stand-in for the behaviour.
  test('a correction hands the prompt to the column that replaces the corrected one', () => {
    const retargetFn = SOURCE.slice(
      SOURCE.indexOf('function onDraftRetarget('),
      SOURCE.indexOf('/** Every branch/MR click'),
    )
    // To the NEW key (`next`), never the old one: the old column is gone.
    expect(retargetFn).toContain('planRequests.carry(draftColumnKey(projectId, next), prompt)')
    expect(retargetFn).toContain('planRequests.forget(from)')
    // …and the column reads it back on mount, which is what makes the carry
    // worth anything.
    expect(SOURCE).toContain(':initial-prompt="planRequests.promptOf(entry.key)"')
  })
})

describe('TaskConversation learns whether its project is the scratch one', () => {
  // Same shape as projectNameById, on purpose: TaskConversation cannot tell
  // a scratch conversation from an ordinary one by itself (it only sees the
  // record), so the column has to hand it the project's kind explicitly, the
  // same way it already hands down the display name.
  test('project-kind comes from its own per-id map, defaulting to repo', () => {
    expect(SOURCE).toContain('const projectKindById = computed(')
    expect(SOURCE).toContain(`:project-kind="projectKindById.get(entry.projectId) ?? 'repo'"`)
  })
})

describe('the attach picker is wired to every registered repo, not one conversation’s own', () => {
  test('repoProjects filters the whole registry, and every conversation gets the same list', () => {
    expect(SOURCE).toContain('const repoProjects = computed(')
    expect(SOURCE).toContain(`project.kind === 'repo'`)
    expect(SOURCE).toContain(':repo-projects="repoProjects"')
  })

  test('attach is scoped to its own conversation, the same way reply and ship are', () => {
    expect(SOURCE).toContain(
      ':attach="(repoProjectId) => attach(entry.projectId, entry.taskId, repoProjectId)"',
    )
  })
})
