// Pure navigation model of the workspace: what the main focus zone shows, as
// ONE value. Replaces the `filter` + `deck` + `reviewRecord` + `activeSection`
// refs that used to describe the zone independently, reconciled only by a
// cascading `boardVisible` computed that DEDUCED the content instead of
// deciding it. FocusView is single-slot: no pinned side-by-side columns, one
// view at a time. Components only compose these functions (testable with
// bun:test, no DOM, no fetch).

import type { ForgeMr, ReviewRecord, TaskRecord } from '../types'
import { resolveBranchClick, type BranchClickResolution } from './useProjects'

export type NavCategory = 'conversations' | 'repositories'
export type RepoTab = 'branches' | 'issues' | 'mrs'

/**
 * A draft composer's target. `scratch` carries neither a base nor a branch:
 * a repo-less conversation has nothing to fork or work on, and giving it one
 * anyway (the retired shape defaulted it to an empty-base fork) is exactly
 * what silently forked `develop` for every new conversation regardless of
 * where the reader clicked "+".
 */
export type DraftTarget =
  | { mode: 'scratch' }
  | { mode: 'fork'; base: string }
  | { mode: 'workon'; branch: string; target: string | null }

export type FocusView =
  | { kind: 'empty' }
  | { kind: 'conversation'; projectId: string; taskId: string }
  | { kind: 'draft'; projectId: string; draft: DraftTarget }
  | { kind: 'repository'; projectId: string; tab: RepoTab }
  | { kind: 'review'; record: ReviewRecord; behind: FocusView }

export const EMPTY_FOCUS: FocusView = { kind: 'empty' }

export const scratchDraft = (): DraftTarget => ({ mode: 'scratch' })

export const forkDraft = (base: string): DraftTarget => ({ mode: 'fork', base })

export const workonDraft = (branch: string, target: string | null): DraftTarget => ({
  mode: 'workon',
  branch,
  target,
})

/** The branch a draft targets: fork by its base, workon by its branch, null
 * for a scratch draft (there is no repository to name one). */
export function draftBranch(draft: DraftTarget): string | null {
  switch (draft.mode) {
    case 'scratch':
      return null
    case 'fork':
      return draft.base
    case 'workon':
      return draft.branch
  }
}

/** Stable dedup identity of a draft: same project, same mode, same branch
 * (a workon draft's target never splits the identity, mirroring draftColumnKey). */
export function draftKey(projectId: string, draft: DraftTarget): string {
  return `${projectId}/#draft/${draft.mode}/${draftBranch(draft) ?? ''}`
}

/** The sole constructor behind the "+" button: always a scratch draft in the
 * scratch project. Never reads the view it replaces. */
export function openNewConversationDraft(scratchProjectId: string): FocusView {
  return { kind: 'draft', projectId: scratchProjectId, draft: scratchDraft() }
}

export function openConversation(projectId: string, taskId: string): FocusView {
  return { kind: 'conversation', projectId, taskId }
}

export function openRepository(projectId: string, tab: RepoTab = 'branches'): FocusView {
  return { kind: 'repository', projectId, tab }
}

export function switchRepoTab(view: FocusView, tab: RepoTab): FocusView {
  if (view.kind !== 'repository' || view.tab === tab) {
    return view
  }
  return { ...view, tab }
}

/** Maps one resolveBranchClick verdict to a FocusView; factored out of
 * openBranchTarget so the exhaustive mapping (including the draft-fork
 * variant the resolver never actually returns today) is directly testable. */
export function focusFromBranchResolution(
  projectId: string,
  resolution: BranchClickResolution,
): FocusView {
  switch (resolution.kind) {
    case 'open':
      return openConversation(projectId, resolution.taskId)
    case 'draft-fork':
      return { kind: 'draft', projectId, draft: forkDraft(resolution.base) }
    case 'draft-workon':
      return { kind: 'draft', projectId, draft: workonDraft(resolution.branch, resolution.target) }
  }
}

/** Routes a branch/MR tree click (open the active conversation on that
 * branch, else draft one) into a FocusView, via resolveBranchClick. */
export function openBranchTarget(
  projectId: string,
  branch: string,
  mr: ForgeMr | null,
  states: readonly { record: Pick<TaskRecord, 'id' | 'branch' | 'status'> }[],
): FocusView {
  return focusFromBranchResolution(projectId, resolveBranchClick(branch, mr, states))
}

/** A draft's conversation was created: it becomes that conversation in
 * place. Any other view is returned untouched. */
export function promoteDraft(view: FocusView, taskId: string): FocusView {
  if (view.kind !== 'draft') {
    return view
  }
  return { kind: 'conversation', projectId: view.projectId, taskId }
}

/**
 * Opens a review over `current`. Always flattens: reviewing while a review is
 * already open replaces its record but keeps the ORIGINAL `behind`, so a
 * review can never stack on top of another review — closing always lands
 * back on the last non-review view instead of peeling one review at a time.
 */
export function openReview(record: ReviewRecord, current: FocusView): FocusView {
  const behind = current.kind === 'review' ? current.behind : current
  return { kind: 'review', record, behind }
}

export function closeReview(current: FocusView): FocusView {
  return current.kind === 'review' ? current.behind : current
}

export function closeFocus(): FocusView {
  return EMPTY_FOCUS
}
