import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

/**
 * WorkspaceView owns the stream, the registry and the focus view: it cannot
 * be rendered off a prop bag the way TaskComposer can (its setup builds
 * `useTasks`, and an empty registry renders no draft at all). What is pinned
 * here is the WIRING of the draft panel, on the source itself.
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
    // Read off the draft's own narrowed work-on branch: `draftBranch` is
    // nullable now that a scratch draft names none, and a warning about
    // `null` would be a warning about nothing.
    expect(SOURCE).toContain('isTrunkBranch(draftEntry.draft.branch)')
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
    for (const binding of [
      ':draft="draftEntry.draft"',
      ':plan=',
      ':plan-error=',
      ':plan-pending=',
    ]) {
      expect(SOURCE).toContain(binding)
    }
  })

  test('the corrections and the plan requests are handled, both without creating', () => {
    expect(SOURCE).toContain('@plan-input=')
    expect(SOURCE).toContain('@retarget=')
    // The correction replaces the focus view's own draft in place — the same
    // mechanism the fork/work-on toggle uses — not a second draft model.
    expect(SOURCE).toContain('retargetDraft(draft, branch)')
    expect(SOURCE).toContain("focus.value = { kind: 'draft', projectId, draft: next }")
  })

  test('only the Launch path ever calls create; the plan path only previews', () => {
    // `create(` reaches the API in exactly the one place that launches a
    // conversation: every draft, fork or work-on, promotes through
    // `onDraftCreate`. A second call site appearing here is the regression
    // this asserts against: the standalone queue composer that used to be
    // the other one is gone, replaced by opening a draft column instead of
    // duplicating it (see `onNewConversation`).
    const createCalls = SOURCE.match(/await create\(/g) ?? []
    expect(createCalls).toHaveLength(1)
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
    expect(retargetFn).toContain('planRequests.carry(draftKey(projectId, next), prompt)')
    expect(retargetFn).toContain('planRequests.forget(from)')
    // …and the column reads it back on mount, which is what makes the carry
    // worth anything.
    expect(SOURCE).toContain(':initial-prompt="planRequests.promptOf(draftEntry.key)"')
  })
})

// The forge board (ForgeBoard.vue) sits in the focus zone behind the open
// conversation or draft, and behind the review view, gated on a project
// actually being selected.
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
    expect(boardVisibleFn).toContain('focusEntry.value === null')
    expect(boardVisibleFn).toContain('filter.value !== null')
    expect(boardVisibleFn).toContain('projects.value.length > 0')
  })

  test('the empty-focus branch is still the final, unconditional fallback', () => {
    const forgeBoardAt = SOURCE.indexOf('class="ws-forge-board"')
    const emptyFocusAt = SOURCE.indexOf('class="ws-empty-focus"')
    expect(forgeBoardAt).toBeGreaterThan(-1)
    expect(emptyFocusAt).toBeGreaterThan(-1)
    expect(forgeBoardAt).toBeLessThan(emptyFocusAt)
    // One message, unconditional: the scratch project is always in the list,
    // so the old "add a project to get started" branch could never be reached
    // again, and it promised a prerequisite that no longer exists.
    expect(SOURCE).toContain('workspace.focusEmpty')
    expect(SOURCE).not.toContain('workspace.noProject')
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

// The board's layout needs the conversations column's own column gone, not
// just visually crowded out: the column hides for exactly the branch the
// board renders in, and comes back for every other one (review, the deck,
// the empty-focus fallback).
describe('the conversations column hides while the board is the focus zone, shows everywhere else', () => {
  test('the conversations column is gated on the same condition, negated', () => {
    const columnTag = SOURCE.slice(
      SOURCE.indexOf('<ConversationsColumn'),
      SOURCE.indexOf(':states="queueStates"'),
    )
    expect(columnTag).toContain('v-if="!boardVisible"')
  })
})

// The left rail is PERMANENT and always looks the same. That is the whole
// point of it: when the menu was mounted inside the board it moved and
// resized the instant a project was picked, so a plain navigation click made
// the screen jump. Picking a project must add sections BELOW the menu, never
// move the menu.
describe('the left rail is permanent, and the menu inside it never moves', () => {
  test('the rail is mounted unconditionally, outside every focus-zone branch', () => {
    const railAt = SOURCE.indexOf('class="ws-rail"')
    expect(railAt).toBeGreaterThan(-1)
    // The whole opening tag, which now spans several lines.
    const railTag = SOURCE.slice(SOURCE.lastIndexOf('<aside', railAt), SOURCE.indexOf('>', railAt))
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

// The rail's width animates when it JUMPS (the collapse button, a keyboard
// step) and never while it is being dragged: a width that animates cannot
// keep up with a pointer rewriting it every frame, so the rail visibly trails
// the cursor. The reference interface animates neither, which is a side
// effect of it only ever dragging, not an intention worth copying.
describe('the rail animates its width, except while dragged', () => {
  test('the rail carries a width transition, on tokens rather than literals', () => {
    const rail = SOURCE.slice(SOURCE.indexOf('.ws-rail {'), SOURCE.indexOf('.ws-rail--dragging'))
    expect(rail).toContain('transition:')
    expect(rail).toContain('var(--cs-duration-base)')
    expect(rail).toContain('var(--cs-ease-in)')
    // flex-basis as well as width: the rail is a flex item, so animating
    // only `width` would leave the basis to snap.
    expect(rail).toContain('flex-basis')
  })

  test('dragging switches the transition off entirely', () => {
    const dragging = SOURCE.slice(SOURCE.indexOf('.ws-rail--dragging'))
    expect(dragging).toContain('transition: none;')
  })

  test('the dragging flag is driven by the handle itself, not guessed', () => {
    expect(SOURCE).toContain('@update:dragging="(v) => (railDragging = v)"')
    expect(SOURCE).toContain("'ws-rail--dragging': railDragging")
  })
})

// [+ new conversation] used to derive a repository and a base branch from
// the active filter, so with any repo registered it opened a fork of that
// repo's current branch — `develop` on a repo sitting on develop. A
// conversation that has not been given code costs no branch and no
// worktree: the target is the scratch project, unconditionally, and a
// repository is attached later from the conversation itself.
describe('a new conversation never targets a repository', () => {
  const fn = SOURCE.slice(
    SOURCE.indexOf('function onNewConversation('),
    SOURCE.indexOf('async function onDraftCreate('),
  )

  test('the target is the scratch project, with no precedence to arbitrate', () => {
    expect(fn).toContain('scratchProjectId.value')
    expect(fn).not.toContain('deriveComposeTarget')
    expect(fn).not.toContain('filter.value')
  })

  test('no base branch is derived, guessed, or defaulted', () => {
    expect(fn).toContain('scratchDraft()')
    expect(fn).not.toContain('isCurrent')
    expect(fn).not.toContain('isTrunkBranch')
    expect(fn).not.toContain("'main'")
  })

  test('the scratch project is read off the registry, never assumed to be first', () => {
    const derivation = SOURCE.slice(
      SOURCE.indexOf('const scratchProjectId = computed('),
      SOURCE.indexOf('const scratchProjectId = computed(') + 200,
    )
    expect(derivation).toContain("project.kind === 'scratch'")
    expect(derivation).not.toContain('projects.value[0]')
  })
})

// The scratch draft targets no branch: the column must not claim otherwise.
// TaskComposer.test.ts covers what it shows INSTEAD (the sober notice); what
// is pinned here is that the branch-only chrome around it is gone.
describe('a scratch draft shows no branch/base chrome', () => {
  const draftColumn = SOURCE.slice(
    SOURCE.indexOf('<header class="ws-draft-head">'),
    SOURCE.indexOf('<TaskComposer'),
  )

  // Gated on the DRAFT's own mode, not on the project's kind: the two used
  // to be kept in step by hand, and the mode is the fact that decides what
  // the panel can honestly show.
  test('the title falls back to a plain, branchless title for a scratch draft', () => {
    expect(draftColumn).toContain("draftEntry.draft.mode === 'scratch'")
    expect(draftColumn).toContain("t('workspace.draftScratchTitle')")
    // Checked first, ahead of the fork/work-on ternary it replaces.
    expect(draftColumn.indexOf("draftEntry.draft.mode === 'scratch'")).toBeLessThan(
      draftColumn.indexOf("draftEntry.draft.mode === 'fork'"),
    )
  })

  test('the fork/work-on mode toggle and the branch/target chips are both hidden for it', () => {
    expect(draftColumn.split(`v-if="draftEntry.draft.mode !== 'scratch'"`).length - 1).toBe(2)
    expect(draftColumn).toContain('class="ws-draft-modes"')
    expect(draftColumn).toContain('ws-draft-chips')
  })

  test('the composer is told which project kind it is drafting for', () => {
    expect(SOURCE).toContain(
      ':project-kind="projectKindById.get(draftEntry.projectId) ?? \'repo\'"',
    )
  })
})
