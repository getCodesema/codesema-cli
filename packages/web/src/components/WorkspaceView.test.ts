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

  // The rail's collapsed band names itself: with a project that is the
  // project, with none it is the menu's own label, never an empty band.
  test('the rail label falls back to the menu label when no project is selected', () => {
    const railLabel = SOURCE.slice(
      SOURCE.indexOf('const railLabel'),
      SOURCE.indexOf('const railIssuesState'),
    )
    expect(railLabel).toContain("t('workspace.projectLabel')")
    expect(railLabel).toContain('projectNameById')
  })
})

// The board's layout needs the work queue's own column gone, not just
// visually crowded out: the work queue hides for exactly the branch the
// board renders in, and comes back for every other one (review, the deck,
// the empty-focus fallback).
describe('the work queue hides while the board is the focus zone, shows everywhere else', () => {
  test('the work queue is gated on the same condition, negated', () => {
    const workQueueTag = SOURCE.slice(
      SOURCE.indexOf('<WorkQueue'),
      SOURCE.indexOf(':states="queueStates"'),
    )
    expect(workQueueTag).toContain('v-if="!boardVisible"')
  })
})

// The left rail is PERMANENT and always looks the same. That is the whole
// point of it: when the menu was mounted inside the board it moved and
// resized the instant a project was picked, so a plain navigation click made
// the screen jump. Picking a project must add sections BELOW the menu, never
// move the menu.
describe('the left rail is permanent, and the menu inside it never moves', () => {
  test('the rail is mounted unconditionally, outside every focus-zone branch', () => {
    const railAt = SOURCE.indexOf('<aside class="ws-rail"')
    expect(railAt).toBeGreaterThan(-1)
    const railTag = SOURCE.slice(railAt, SOURCE.indexOf('>', railAt))
    expect(railTag).not.toContain('v-if')
    // Before the focus zone, so it is a sibling of it and not inside it.
    expect(railAt).toBeLessThan(SOURCE.indexOf('<main class="ws-focus">'))
  })

  test('the menu is mounted in exactly one place: the rail head', () => {
    const mountAt = SOURCE.indexOf('<ProjectsNav')
    expect(mountAt).toBeGreaterThan(-1)
    expect(SOURCE.indexOf('<ProjectsNav', mountAt + 1)).toBe(-1)
    const slotAt = SOURCE.indexOf('<template #top>')
    expect(slotAt).toBeGreaterThan(-1)
    expect(mountAt).toBeGreaterThan(slotAt)
    // The tag itself, not everything that follows it.
    const mountTag = SOURCE.slice(mountAt, SOURCE.indexOf('/>', mountAt))
    expect(mountTag).not.toContain('v-if')
  })

  test('only the SECTIONS follow the board, through has-board', () => {
    const panelTag = SOURCE.slice(
      SOURCE.indexOf('<ForgeControlsPanel'),
      SOURCE.indexOf('>', SOURCE.indexOf('<ForgeControlsPanel')),
    )
    expect(SOURCE).toContain(':has-board="boardVisible"')
    expect(panelTag).not.toContain('v-if')
  })

  test('the rail owns its own width and collapsed state, and the board no longer does', () => {
    expect(SOURCE).toContain("'--ws-rail-w': `${railPanelWidth}px`")
    expect(SOURCE).toContain('v-if="!railCollapsed"')
    expect(SOURCE).toContain("t('forge.resizeControlsAria')")
    const forgeBoardTag = SOURCE.slice(
      SOURCE.indexOf('<ForgeBoard'),
      SOURCE.indexOf('/>', SOURCE.indexOf('<ForgeBoard')),
    )
    expect(forgeBoardTag).not.toContain('collapsed')
    expect(forgeBoardTag).not.toContain('controls')
  })

  test('the shared preferences come from the composable, not from the board', () => {
    expect(SOURCE).toContain('useForgePrefs()')
    // The board is handed the list-side preferences it renders with.
    const forgeBoardTag = SOURCE.slice(
      SOURCE.indexOf('<ForgeBoard'),
      SOURCE.indexOf('/>', SOURCE.indexOf('<ForgeBoard')),
    )
    for (const binding of [':section="activeSection"', ':list-width="listWidth"']) {
      expect(forgeBoardTag).toContain(binding)
    }
  })
})

// The state filter is server-side: picking "merged" does not sieve the open
// list, it fetches a different one. The whole capability (route, per-state
// cache, loader) already existed and NOTHING consumed it, which is the bug
// this pins against: reading the eager open-only cache here would silently
// show open MRs under a "merged" label.
describe('the MR state filter actually reaches the forge', () => {
  test('the list and its load state are read per (project, state), not from the open-only cache', () => {
    expect(SOURCE).toContain('mrsOf(filter.value, mrsStateFilter.value)')
    expect(SOURCE).toContain('mrsLoadOf(filter.value, mrsStateFilter.value)')
    const forgeBoardTag = SOURCE.slice(
      SOURCE.indexOf('<ForgeBoard'),
      SOURCE.indexOf('/>', SOURCE.indexOf('<ForgeBoard')),
    )
    expect(forgeBoardTag).toContain(':mrs="mrsOf(filter, mrsStateFilter)"')
    expect(forgeBoardTag).toContain(':mrs-state="mrsLoadOf(filter, mrsStateFilter)"')
    // The eager, open-only map must not be what feeds the board any more.
    expect(forgeBoardTag).not.toContain('mrsByProject')
  })

  test('a change of project OR of state triggers the fetch, immediately on mount', () => {
    const watcher = SOURCE.slice(
      SOURCE.indexOf('watch(\n  [filter, mrsStateFilter]'),
      SOURCE.indexOf('// ── The project menu'),
    )
    expect(watcher).toContain('loadMrsState(projectId, state)')
    expect(watcher).toContain('projectId !== null')
    expect(watcher).toContain('{ immediate: true }')
  })

  test('the draft toggle stays client-side: it is handed down, never sent to the loader', () => {
    expect(SOURCE).toContain(':mrs-draft-only="mrsDraftOnly"')
    expect(SOURCE).not.toContain('loadMrsState(projectId, mrsDraftOnly')
  })
})
