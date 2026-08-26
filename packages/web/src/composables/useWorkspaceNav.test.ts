import { describe, expect, test } from 'bun:test'
import type { ForgeMr, ReviewRecord, ReviewSource, TaskStatus } from '../types'
import {
  closeFocus,
  closeReview,
  closeReviewRun,
  draftBranch,
  draftKey,
  EMPTY_FOCUS,
  focusFromBranchResolution,
  forkDraft,
  openBranchTarget,
  openConversation,
  openNewConversationDraft,
  openRepository,
  openReview,
  openReviewRun,
  openReviewTarget,
  promoteDraft,
  promoteReviewRun,
  sameReviewSource,
  scratchDraft,
  switchRepoTab,
  workonDraft,
} from './useWorkspaceNav'

function review(title = 'r1'): ReviewRecord {
  return {
    version: 1,
    meta: {
      title,
      branch: 'feature/x',
      target: 'develop',
      merge_base: 'abc123',
      repo_root: '/repo',
      created_at: '2026-08-14T10:00:00.000Z',
    },
    commits: [],
    diff: '',
    review: { verdict: 'approve', summary: 'ok', findings: [], narrative: null },
  }
}

function mr(overrides: Partial<ForgeMr> = {}): ForgeMr {
  return {
    number: 1,
    title: 'mr',
    author: 'octocat',
    sourceBranch: 'feature/x',
    targetBranch: 'develop',
    updatedAt: '2026-08-14T10:00:00.000Z',
    url: 'https://example.test/mr/1',
    state: null,
    isDraft: null,
    labels: null,
    additions: null,
    deletions: null,
    changedFiles: null,
    checks: null,
    reviewers: null,
    assignees: null,
    milestone: null,
    mergeable: null,
    commits: null,
    body: null,
    ...overrides,
  }
}

function stateOf(id: string, branch: string, status: TaskStatus) {
  return { record: { id, branch, status } }
}

function mrSource(number = 1): ReviewSource {
  return { kind: 'mr', number }
}

function branchSource(name = 'feature/x'): ReviewSource {
  return { kind: 'branch', name }
}

describe('draft constructors', () => {
  test('scratchDraft carries no base or branch', () => {
    expect(scratchDraft()).toEqual({ mode: 'scratch' })
  })

  test('forkDraft carries its base', () => {
    expect(forkDraft('develop')).toEqual({ mode: 'fork', base: 'develop' })
  })

  test('workonDraft carries its branch and target', () => {
    expect(workonDraft('feature/x', 'develop')).toEqual({
      mode: 'workon',
      branch: 'feature/x',
      target: 'develop',
    })
    expect(workonDraft('feature/x', null)).toEqual({
      mode: 'workon',
      branch: 'feature/x',
      target: null,
    })
  })
})

describe('draftBranch', () => {
  test('a scratch draft has no branch', () => {
    expect(draftBranch(scratchDraft())).toBeNull()
  })

  test('a fork draft resolves to its base', () => {
    expect(draftBranch(forkDraft('main'))).toBe('main')
  })

  test('a workon draft resolves to its branch, ignoring the target', () => {
    expect(draftBranch(workonDraft('feature/x', 'develop'))).toBe('feature/x')
  })
})

describe('draftKey', () => {
  test('a scratch draft has a stable key per project', () => {
    expect(draftKey('p1', scratchDraft())).toBe(draftKey('p1', scratchDraft()))
  })

  test('scratch and a fork draft never collide, even sharing no branch value', () => {
    expect(draftKey('p1', scratchDraft())).not.toBe(draftKey('p1', forkDraft('')))
  })

  test('fork and workon of the same branch name differ: mode is part of the key', () => {
    expect(draftKey('p1', forkDraft('main'))).not.toBe(draftKey('p1', workonDraft('main', null)))
  })

  test('the target never leaks into a workon draft key', () => {
    expect(draftKey('p1', workonDraft('feature/x', 'develop'))).toBe(
      draftKey('p1', workonDraft('feature/x', null)),
    )
  })

  test('the same draft in another project is a distinct key', () => {
    expect(draftKey('p1', forkDraft('main'))).not.toBe(draftKey('p2', forkDraft('main')))
  })
})

describe('openNewConversationDraft', () => {
  test('always a scratch draft in the given project, never a base or branch', () => {
    expect(openNewConversationDraft('scratch-1')).toEqual({
      kind: 'draft',
      projectId: 'scratch-1',
      draft: { mode: 'scratch' },
    })
  })
})

describe('openConversation', () => {
  test('builds a conversation view', () => {
    expect(openConversation('p1', 't1')).toEqual({
      kind: 'conversation',
      projectId: 'p1',
      taskId: 't1',
    })
  })
})

describe('openRepository', () => {
  test('defaults to the branches tab', () => {
    expect(openRepository('p1')).toEqual({ kind: 'repository', projectId: 'p1', tab: 'branches' })
  })

  test('honors an explicit tab', () => {
    expect(openRepository('p1', 'issues')).toEqual({
      kind: 'repository',
      projectId: 'p1',
      tab: 'issues',
    })
  })
})

describe('switchRepoTab', () => {
  test('switches the tab of a repository view', () => {
    const view = openRepository('p1', 'branches')
    expect(switchRepoTab(view, 'mrs')).toEqual({ kind: 'repository', projectId: 'p1', tab: 'mrs' })
  })

  test('a non-repository view is returned untouched (same reference)', () => {
    expect(switchRepoTab(EMPTY_FOCUS, 'issues')).toBe(EMPTY_FOCUS)
    const conversation = openConversation('p1', 't1')
    expect(switchRepoTab(conversation, 'issues')).toBe(conversation)
  })

  test('already on that tab: same reference back', () => {
    const view = openRepository('p1', 'issues')
    expect(switchRepoTab(view, 'issues')).toBe(view)
  })
})

describe('focusFromBranchResolution', () => {
  test('open: builds a conversation view', () => {
    expect(focusFromBranchResolution('p1', { kind: 'open', taskId: 't9' })).toEqual({
      kind: 'conversation',
      projectId: 'p1',
      taskId: 't9',
    })
  })

  test('draft-fork: builds a fork draft (unreachable in practice, mapped for exhaustiveness)', () => {
    expect(focusFromBranchResolution('p1', { kind: 'draft-fork', base: 'develop' })).toEqual({
      kind: 'draft',
      projectId: 'p1',
      draft: { mode: 'fork', base: 'develop' },
    })
  })

  test('draft-workon: builds a workon draft, target riding along', () => {
    expect(
      focusFromBranchResolution('p1', {
        kind: 'draft-workon',
        branch: 'feature/x',
        target: 'develop',
      }),
    ).toEqual({
      kind: 'draft',
      projectId: 'p1',
      draft: { mode: 'workon', branch: 'feature/x', target: 'develop' },
    })
  })
})

describe('openBranchTarget', () => {
  test('an active conversation on that branch opens instead of drafting', () => {
    const states = [stateOf('t1', 'feature/x', 'running')]
    expect(openBranchTarget('p1', 'feature/x', null, states)).toEqual({
      kind: 'conversation',
      projectId: 'p1',
      taskId: 't1',
    })
  })

  test('a terminal conversation on the branch does not block a new draft', () => {
    const states = [stateOf('t1', 'feature/x', 'shipped')]
    expect(openBranchTarget('p1', 'feature/x', null, states)).toEqual({
      kind: 'draft',
      projectId: 'p1',
      draft: { mode: 'workon', branch: 'feature/x', target: null },
    })
  })

  test('no active conversation: drafts a workon target', () => {
    expect(openBranchTarget('p1', 'feature/x', null, [])).toEqual({
      kind: 'draft',
      projectId: 'p1',
      draft: { mode: 'workon', branch: 'feature/x', target: null },
    })
  })

  test('clicking from an MR node carries its target branch along', () => {
    const theMr = mr({ sourceBranch: 'feature/x', targetBranch: 'develop' })
    expect(openBranchTarget('p1', 'feature/x', theMr, [])).toEqual({
      kind: 'draft',
      projectId: 'p1',
      draft: { mode: 'workon', branch: 'feature/x', target: 'develop' },
    })
  })

  test('a trunk click still drafts a workon target: mode is never routed by branch name', () => {
    expect(openBranchTarget('p1', 'develop', null, [])).toEqual({
      kind: 'draft',
      projectId: 'p1',
      draft: { mode: 'workon', branch: 'develop', target: null },
    })
  })
})

describe('promoteDraft', () => {
  test('a draft view becomes the conversation view, in place', () => {
    const view = openNewConversationDraft('p1')
    expect(promoteDraft(view, 't9')).toEqual({
      kind: 'conversation',
      projectId: 'p1',
      taskId: 't9',
    })
  })

  test('a non-draft view is returned untouched (same reference)', () => {
    expect(promoteDraft(EMPTY_FOCUS, 't9')).toBe(EMPTY_FOCUS)
    const conversation = openConversation('p1', 't1')
    expect(promoteDraft(conversation, 't9')).toBe(conversation)
    const repository = openRepository('p1')
    expect(promoteDraft(repository, 't9')).toBe(repository)
  })
})

describe('openReview / closeReview', () => {
  test('opens over the empty view', () => {
    const record = review()
    expect(openReview(record, EMPTY_FOCUS)).toEqual({
      kind: 'review',
      record,
      behind: EMPTY_FOCUS,
    })
  })

  test('opens over a conversation, remembering it as behind', () => {
    const conversation = openConversation('p1', 't1')
    const record = review()
    expect(openReview(record, conversation)).toEqual({
      kind: 'review',
      record,
      behind: conversation,
    })
  })

  test('closeReview returns exactly what was behind it', () => {
    const conversation = openConversation('p1', 't1')
    const opened = openReview(review(), conversation)
    expect(closeReview(opened)).toEqual(conversation)
  })

  test('closeReview on a non-review view is a no-op (same reference)', () => {
    const conversation = openConversation('p1', 't1')
    expect(closeReview(conversation)).toBe(conversation)
  })

  test('reviews never stack: opening a second review keeps the ORIGINAL behind', () => {
    const conversation = openConversation('p1', 't1')
    const first = openReview(review('first'), conversation)
    const second = openReview(review('second'), first)
    expect(second).toEqual({ kind: 'review', record: review('second'), behind: conversation })

    // Closing the second review lands back on the conversation directly,
    // never on the first review: reviews do not nest.
    expect(closeReview(second)).toEqual(conversation)
  })

  test('opens over a reviewRun, flattening onto the run behind rather than stacking', () => {
    const target = openReviewTarget('p1', mrSource(7))
    const run = openReviewRun('p1', mrSource(7), 'simple', target)
    const record = review()
    expect(openReview(record, run)).toEqual({ kind: 'review', record, behind: target })
  })
})

describe('openReviewTarget', () => {
  test('builds a reviewTarget view for an MR source, with no behind', () => {
    expect(openReviewTarget('p1', mrSource(7))).toEqual({
      kind: 'reviewTarget',
      projectId: 'p1',
      source: mrSource(7),
    })
  })

  test('builds a reviewTarget view for a branch source', () => {
    expect(openReviewTarget('p1', branchSource('feature/x'))).toEqual({
      kind: 'reviewTarget',
      projectId: 'p1',
      source: branchSource('feature/x'),
    })
  })
})

describe('openReviewRun / closeReviewRun', () => {
  test('opens over a reviewTarget, remembering it as behind', () => {
    const target = openReviewTarget('p1', mrSource(7))
    expect(openReviewRun('p1', mrSource(7), 'simple', target)).toEqual({
      kind: 'reviewRun',
      projectId: 'p1',
      source: mrSource(7),
      mode: 'simple',
      behind: target,
    })
  })

  test('opens over the empty view', () => {
    expect(openReviewRun('p1', branchSource('feature/x'), 'dual', EMPTY_FOCUS)).toEqual({
      kind: 'reviewRun',
      projectId: 'p1',
      source: branchSource('feature/x'),
      mode: 'dual',
      behind: EMPTY_FOCUS,
    })
  })

  test('a run launched over another run flattens: keeps the ORIGINAL behind', () => {
    const target = openReviewTarget('p1', mrSource(7))
    const first = openReviewRun('p1', mrSource(7), 'simple', target)
    const second = openReviewRun('p1', mrSource(7), 'dual', first)
    expect(second).toEqual({
      kind: 'reviewRun',
      projectId: 'p1',
      source: mrSource(7),
      mode: 'dual',
      behind: target,
    })
  })

  test('a run launched over an archived review view flattens onto its behind', () => {
    const conversation = openConversation('p1', 't1')
    const archived = openReview(review(), conversation)
    const run = openReviewRun('p1', mrSource(7), 'simple', archived)
    expect(run).toEqual({
      kind: 'reviewRun',
      projectId: 'p1',
      source: mrSource(7),
      mode: 'simple',
      behind: conversation,
    })
  })

  test('closeReviewRun returns exactly what was behind it', () => {
    const target = openReviewTarget('p1', mrSource(7))
    const run = openReviewRun('p1', mrSource(7), 'simple', target)
    expect(closeReviewRun(run)).toEqual(target)
  })

  test('closeReviewRun on a non-reviewRun view is a no-op (same reference)', () => {
    const target = openReviewTarget('p1', mrSource(7))
    expect(closeReviewRun(target)).toBe(target)
    expect(closeReviewRun(EMPTY_FOCUS)).toBe(EMPTY_FOCUS)
  })
})

describe('sameReviewSource', () => {
  test('two mr sources with the same number are equal by value', () => {
    expect(sameReviewSource(mrSource(7), { kind: 'mr', number: 7 })).toBe(true)
  })

  test('two mr sources with different numbers are not equal', () => {
    expect(sameReviewSource(mrSource(7), mrSource(8))).toBe(false)
  })

  test('two branch sources with the same name are equal by value', () => {
    expect(sameReviewSource(branchSource('feature/x'), { kind: 'branch', name: 'feature/x' })).toBe(
      true,
    )
  })

  test('two branch sources with different names are not equal', () => {
    expect(sameReviewSource(branchSource('feature/x'), branchSource('feature/y'))).toBe(false)
  })

  test('an mr and a branch source are never equal, even with overlapping "identity" values', () => {
    expect(sameReviewSource({ kind: 'mr', number: 7 }, { kind: 'branch', name: '7' })).toBe(false)
  })
})

describe('promoteReviewRun', () => {
  test('the exact run being watched becomes the archived review, keeping its behind', () => {
    const target = openReviewTarget('p1', mrSource(7))
    const run = openReviewRun('p1', mrSource(7), 'simple', target)
    const record = review('done')
    expect(promoteReviewRun(run, 'p1', mrSource(7), record)).toEqual({
      kind: 'review',
      record,
      behind: target,
    })
  })

  test('a view of a different kind entirely: same reference back', () => {
    const conversation = openConversation('p1', 't1')
    expect(promoteReviewRun(conversation, 'p1', mrSource(7), review())).toBe(conversation)
  })

  test('a reviewRun of a different source, same project: same reference back', () => {
    const run = openReviewRun('p1', mrSource(7), 'simple', openReviewTarget('p1', mrSource(7)))
    expect(promoteReviewRun(run, 'p1', mrSource(8), review())).toBe(run)
  })

  test('a reviewRun of a different source kind sharing the same raw value: same reference back', () => {
    const run = openReviewRun(
      'p1',
      branchSource('7'),
      'simple',
      openReviewTarget('p1', branchSource('7')),
    )
    expect(promoteReviewRun(run, 'p1', mrSource(7), review())).toBe(run)
  })

  test('a reviewRun of the same source in a different project: same reference back', () => {
    const run = openReviewRun('p1', mrSource(7), 'simple', openReviewTarget('p1', mrSource(7)))
    expect(promoteReviewRun(run, 'p2', mrSource(7), review())).toBe(run)
  })

  test('a reviewTarget (already promoted, or never a run): same reference back', () => {
    const target = openReviewTarget('p1', mrSource(7))
    expect(promoteReviewRun(target, 'p1', mrSource(7), review())).toBe(target)
  })
})

describe('closeFocus', () => {
  test('returns the empty view', () => {
    expect(closeFocus()).toBe(EMPTY_FOCUS)
  })
})
