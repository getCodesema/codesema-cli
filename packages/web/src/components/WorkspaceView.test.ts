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

// Three zones, in this order and never nested: the category rail, the list
// column, the stage. The rail and the column are siblings OF the stage, not
// children of it, which is what keeps a navigation click from ever resizing
// or moving the navigation itself.
describe('the desk is three sibling zones', () => {
  const bodyAt = SOURCE.indexOf('<div v-else class="ws-body">')
  const stageAt = SOURCE.indexOf('<main class="ws-focus">')

  test('the rail and the list column both sit before the stage, unconditionally', () => {
    const railAt = SOURCE.indexOf('<WorkspaceNavRail')
    const listAt = SOURCE.indexOf('<aside class="ws-list"')
    expect(bodyAt).toBeLessThan(railAt)
    expect(railAt).toBeLessThan(listAt)
    expect(listAt).toBeLessThan(stageAt)
    const railTag = SOURCE.slice(railAt, SOURCE.indexOf('/>', railAt))
    expect(railTag).not.toContain('v-if')
  })

  test('the list column shows exactly one list, chosen by the active category', () => {
    const column = SOURCE.slice(SOURCE.indexOf('<aside class="ws-list"'), stageAt)
    expect(column).toContain(`v-if="railPrefs.category === 'conversations'"`)
    expect(column).toContain('<ConversationsList')
    expect(column).toContain('<RepositoriesList')
    // v-else, not a second v-if: the two can never be on screen together.
    expect(column).toContain('v-else')
  })

  test('only the list column is draggable, and it declares the rail bounds', () => {
    expect(SOURCE).toContain("'--ws-list-w': `${railPrefs.listWidth}px`")
    expect(SOURCE).toContain(':min="RAIL_LIST_WIDTH_MIN"')
    expect(SOURCE).toContain(':max="RAIL_LIST_WIDTH_MAX"')
    expect(SOURCE).toContain(':default-width="RAIL_LIST_WIDTH_DEFAULT"')
    expect(SOURCE).toContain("t('rail.resizeAria')")
  })
})

// The stage renders one thing at a time, and the order of its branches IS
// the priority: a review covers whatever it was opened from, an open
// conversation or draft comes next, a repository view after that, and the
// sober invite is the unconditional fallback.
describe('the stage shows exactly one thing, in a fixed priority', () => {
  test('the four branches appear in priority order', () => {
    const reviewAt = SOURCE.indexOf('v-if="reviewRecord"')
    const focusAt = SOURCE.indexOf('v-else-if="focusEntry"')
    const repositoryAt = SOURCE.indexOf('v-else-if="repositoryEntry"')
    const emptyAt = SOURCE.indexOf('class="ws-empty-focus"')
    expect(reviewAt).toBeGreaterThan(-1)
    expect(reviewAt).toBeLessThan(focusAt)
    expect(focusAt).toBeLessThan(repositoryAt)
    expect(repositoryAt).toBeLessThan(emptyAt)
  })

  test('the empty branch is the final, unconditional fallback', () => {
    // One message, unconditional: the scratch project is always in the list,
    // so the old "add a project to get started" branch could never be reached
    // again, and it promised a prerequisite that no longer exists.
    expect(SOURCE).toContain('workspace.focusEmpty')
    expect(SOURCE).not.toContain('workspace.noProject')
  })

  test('the repository view remounts on every repository switch', () => {
    const tag = SOURCE.slice(
      SOURCE.indexOf('<RepositoryView'),
      SOURCE.indexOf('>', SOURCE.indexOf('<RepositoryView')),
    )
    expect(tag).toContain(':key="repositoryEntry.projectId"')
  })
})

// Selecting a repository is one gesture with three consequences, and all
// three have to happen: the list highlights it, the registry lazily fetches
// its MRs/branches/worktrees, and the stage opens its view. Dropping any one
// of them leaves the screen describing a repository it has not read.
describe('selecting a repository loads it and stages it', () => {
  const fn = SOURCE.slice(
    SOURCE.indexOf('function selectRepository('),
    SOURCE.indexOf('// ── Header:'),
  )

  test('it marks the selection, warms the registry, and opens the view', () => {
    expect(fn).toContain('filter.value = id')
    expect(fn).toContain('selectProject(id)')
    expect(fn).toContain('issues.load(id)')
    expect(fn).toContain('openRepository(id, railPrefs.activeRepoTab)')
  })

  test('the tab it opens on is the one the reader last used', () => {
    const tabFn = SOURCE.slice(
      SOURCE.indexOf('function selectRepoTab('),
      SOURCE.indexOf('// ── The Branches tab'),
    )
    expect(tabFn).toContain('railPrefs.activeRepoTab = tab')
    expect(tabFn).toContain('switchRepoTab(focus.value, tab)')
  })
})

// The state filter is server-side: picking "merged" does not sieve the open
// list, it fetches a different one. The whole capability (route, per-state
// cache, loader) already existed and NOTHING consumed it, which is the bug
// this pins against: reading the eager open-only cache here would silently
// show open MRs under a "merged" label.
describe('the MR state filter actually reaches the forge', () => {
  test('the list and its load state are read per (project, state), not from the open-only cache', () => {
    const tag = SOURCE.slice(
      SOURCE.indexOf('<RepositoryView'),
      SOURCE.indexOf('<template #branches>'),
    )
    expect(tag).toContain(':mrs="mrsOf(repositoryEntry.projectId, mrsStateFilter)"')
    expect(tag).toContain(':mrs-state="mrsLoadOf(repositoryEntry.projectId, mrsStateFilter)"')
    // The eager, open-only map must not be what feeds the view any more.
    expect(tag).not.toContain('mrsByProject')
  })

  test('a change of project OR of state triggers the fetch, immediately on mount', () => {
    const watcher = SOURCE.slice(
      SOURCE.indexOf('watch(\n  [filter, mrsStateFilter]'),
      SOURCE.indexOf('</script>'),
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

// The branches table filters and sorts OUTSIDE the component that renders
// it: the table receives the corpus and the visible rows separately, so it
// can tell "this repository has no branch" from "this filter leaves none".
describe('the branches table is handed both the corpus and the visible rows', () => {
  test('the two lists are distinct, and only one of them is filtered and sorted', () => {
    const tag = SOURCE.slice(
      SOURCE.indexOf('<BranchTable'),
      SOURCE.indexOf('/>', SOURCE.indexOf('<BranchTable')),
    )
    expect(tag).toContain(':rows="repositoryRows"')
    expect(tag).toContain(':visible-rows="repositoryVisibleRows"')
    const visible = SOURCE.slice(
      SOURCE.indexOf('const repositoryVisibleRows'),
      SOURCE.indexOf('const repositoryTiles'),
    )
    expect(visible).toContain('sortBranchRows(filterBranchRows(')
  })

  test('the rows come from the staged repository, never from the highlighted one', () => {
    const rows = SOURCE.slice(
      SOURCE.indexOf('const repositoryRows'),
      SOURCE.indexOf('const repositoryVisibleRows'),
    )
    // `filter` is what the list column highlights; `repositoryEntry` is what
    // the stage is actually showing. They agree today, and the table must
    // follow the second so they cannot silently disagree tomorrow.
    expect(rows).toContain('repositoryEntry.value')
    expect(rows).not.toContain('filter.value')
    for (const source of ['branchesByProject', 'worktreesByProject', 'mrsByProject']) {
      expect(rows).toContain(source)
    }
  })
})

// ⌘K belongs to the shell, not to a field: which list is on screen is the
// shell's own state, and the shortcut has to reach whichever one it is.
describe('the search shortcut reaches the list column', () => {
  test('the shell owns the listener and focuses both list refs', () => {
    expect(SOURCE).toContain("e.key.toLowerCase() === 'k'")
    expect(SOURCE).toContain('conversationsList.value?.focusSearch()')
    expect(SOURCE).toContain('repositoriesList.value?.focusSearch()')
    expect(SOURCE).toContain("window.addEventListener('keydown', onGlobalKeydown)")
    expect(SOURCE).toContain("window.removeEventListener('keydown', onGlobalKeydown)")
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
