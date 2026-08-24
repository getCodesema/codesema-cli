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

// The forge board (ForgeBoard.vue) sits in the focus zone behind the deck
// and behind the review view, gated on a project actually being selected.
// What is pinned here is that wiring, on the source itself, for the same
// reason as above.
describe('the sober empty focus state still shows with no project selected', () => {
  test('the forge board is still gated on a selected project with at least one registered', () => {
    // The board's own v-else-if stays the literal condition (a TS narrowing
    // requirement, see the comment on it), but `boardVisible` is defined to
    // mirror it exactly and IS what gates the work queue below.
    expect(SOURCE).toContain('v-else-if="filter !== null && projects.length > 0"')
    expect(SOURCE).toContain('class="ws-forge-board"')
    const boardVisibleFn = SOURCE.slice(
      SOURCE.indexOf('const boardVisible = computed('),
      SOURCE.indexOf('// ── Projects column'),
    )
    expect(boardVisibleFn).toContain('reviewRecord.value === null')
    expect(boardVisibleFn).toContain('deckEntries.value.length === 0')
    expect(boardVisibleFn).toContain('filter.value !== null')
    expect(boardVisibleFn).toContain('projects.value.length > 0')
  })

  test('the empty-focus branch is still the final, unconditional fallback', () => {
    const forgeBoardAt = SOURCE.indexOf('class="ws-forge-board"')
    const emptyFocusAt = SOURCE.indexOf('class="ws-empty-focus"')
    expect(forgeBoardAt).toBeGreaterThan(-1)
    expect(emptyFocusAt).toBeGreaterThan(-1)
    expect(forgeBoardAt).toBeLessThan(emptyFocusAt)
    expect(SOURCE).toContain('workspace.noProject')
    expect(SOURCE).toContain('workspace.focusEmpty')
  })

  test('the board remounts (selection and section state reset) on every project switch', () => {
    const forgeBoardTag = SOURCE.slice(
      SOURCE.indexOf('<ForgeBoard'),
      SOURCE.indexOf('/>', SOURCE.indexOf('<ForgeBoard')),
    )
    expect(forgeBoardTag).toContain(':key="filter"')
  })

  // The collapsed controls panel shows the project's name (the vertical
  // band): it has to come from somewhere, and the board itself has no
  // notion of "which project" beyond the id-keyed data it's handed.
  test("the board receives the selected project's display name", () => {
    const forgeBoardTag = SOURCE.slice(
      SOURCE.indexOf('<ForgeBoard'),
      SOURCE.indexOf('/>', SOURCE.indexOf('<ForgeBoard')),
    )
    expect(forgeBoardTag).toContain(':project-name="projectNameById.get(filter) ?? filter"')
  })
})

// The board's four-column layout (menu / controls / list / detail) needs the
// work queue's own column gone, not just visually crowded out: the work
// queue hides for exactly the branch the board renders in, and comes back
// for every other one (review, the deck, the empty-focus fallback).
describe('the work queue hides while the board is the focus zone, shows everywhere else', () => {
  test('the work queue is gated on the same condition, negated', () => {
    const workQueueTag = SOURCE.slice(
      SOURCE.indexOf('<WorkQueue'),
      SOURCE.indexOf(':states="queueStates"'),
    )
    expect(workQueueTag).toContain('v-if="!boardVisible"')
  })
})

// The desk is three columns with the board up, not four: the project menu
// moves into the head of the board's rail so that navigation and controls
// share one column. What is pinned here is that the menu is mounted in BOTH
// places under mutually exclusive conditions (never twice at once, never
// nowhere), and that both mounts read the same grouped bindings rather than
// spelling seventeen props and handlers out twice and drifting apart.
describe('the project menu moves into the rail while the board is up', () => {
  const mounts = SOURCE.split('<ProjectsNav').slice(1)

  test('the menu is mounted in exactly two places', () => {
    expect(mounts).toHaveLength(2)
  })

  test('the desk column is gated OFF while the board is up', () => {
    const deskMount = mounts[0] ?? ''
    expect(deskMount).toContain('v-if="!boardVisible"')
  })

  test('the rail mount sits inside the board, in its rail-top slot', () => {
    const slotAt = SOURCE.indexOf('<template #rail-top>')
    const boardAt = SOURCE.indexOf('<ForgeBoard')
    const boardCloseAt = SOURCE.indexOf('</ForgeBoard>')
    expect(slotAt).toBeGreaterThan(boardAt)
    expect(slotAt).toBeLessThan(boardCloseAt)
    // The second mount is the one in the slot.
    expect(SOURCE.indexOf('<ProjectsNav', slotAt)).toBeGreaterThan(slotAt)
    expect(SOURCE.indexOf('<ProjectsNav', slotAt)).toBeLessThan(boardCloseAt)
  })

  test('the rail mount carries no condition of its own: the board only renders when the board is up', () => {
    const railMount = mounts[1] ?? ''
    expect(railMount).not.toContain('v-if')
  })

  test('both mounts bind through the grouped props and handlers, never a spelled-out list', () => {
    for (const mount of mounts) {
      expect(mount).toContain('v-bind="projectsNavProps"')
      expect(mount).toContain('v-on="projectsNavHandlers"')
    }
  })

  test('every prop and handler the menu takes is in the grouped objects', () => {
    const propsBlock = SOURCE.slice(
      SOURCE.indexOf('const projectsNavProps'),
      SOURCE.indexOf('const projectsNavHandlers'),
    )
    for (const key of [
      'projects:',
      'selected:',
      'activity:',
      'tree:',
      'extraBranches:',
      'focusedKeys:',
      'addBusy:',
      'addError:',
      'removeError:',
      'candidates:',
    ]) {
      expect(propsBlock).toContain(key)
    }

    const handlersBlock = SOURCE.slice(SOURCE.indexOf('const projectsNavHandlers'))
    for (const key of [
      'select:',
      'add:',
      'remove:',
      'discover:',
      "'refresh-mrs':",
      "'open-task':",
      "'branch-click':",
    ]) {
      expect(handlersBlock).toContain(key)
    }
  })
})
