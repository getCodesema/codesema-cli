// Pure navigation model of the workspace: what the main focus zone shows, as
// ONE value. Replaces the `filter` + `deck` + `reviewRecord` + `activeSection`
// refs that used to describe the zone independently, reconciled only by a
// cascading `boardVisible` computed that DEDUCED the content instead of
// deciding it. FocusView is single-slot: no pinned side-by-side columns, one
// view at a time. Components only compose these functions (testable with
// bun:test, no DOM, no fetch).

import type { ForgeMr, MrReviewMode, ReviewRecord, ReviewSource, TaskRecord } from '../types'
import { resolveBranchClick, type BranchClickResolution } from './useProjects'

export type NavCategory = 'conversations' | 'repositories' | 'codeReview'
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

/**
 * `reviewTarget` and `reviewRun` name only the MR/branch under review, never
 * its live flow: `status`/`partial`/`partial_b`/`judge` mutate on every SSE
 * frame, and folding that into FocusView would turn every frame into a new
 * object identity, defeating the point of a value the rest of the app can
 * diff and memoize on. That transient state lives in WorkspaceView refs
 * instead. `reviewTarget` carries no `behind`: like `repository`, it is a
 * resting view, not an overlay, so leaving it is picking another category or
 * target, never "going back" to whatever a review sat on top of.
 */
export type FocusView =
  | { kind: 'empty' }
  | { kind: 'conversation'; projectId: string; taskId: string }
  | { kind: 'draft'; projectId: string; draft: DraftTarget }
  | { kind: 'repository'; projectId: string; tab: RepoTab }
  | { kind: 'review'; record: ReviewRecord; behind: FocusView }
  | { kind: 'reviewTarget'; projectId: string; source: ReviewSource }
  | {
      kind: 'reviewRun'
      projectId: string
      source: ReviewSource
      mode: MrReviewMode
      behind: FocusView
    }

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

export function openReviewTarget(projectId: string, source: ReviewSource): FocusView {
  return { kind: 'reviewTarget', projectId, source }
}

/** Unwraps an overlay (`review`, `reviewRun`) down to the resting view it
 * sits on. Shared by every overlay constructor so opening one overlay over
 * another never stacks them, whatever the mix of the two overlay kinds. */
function restingBehind(current: FocusView): FocusView {
  return current.kind === 'review' || current.kind === 'reviewRun' ? current.behind : current
}

/**
 * Opens a review over `current`. Always flattens: reviewing while a review
 * or a live run is already open replaces it but keeps the ORIGINAL resting
 * `behind`, so overlays can never stack, closing always lands back on the
 * last resting view instead of peeling one overlay at a time.
 */
export function openReview(record: ReviewRecord, current: FocusView): FocusView {
  return { kind: 'review', record, behind: restingBehind(current) }
}

export function closeReview(current: FocusView): FocusView {
  return current.kind === 'review' ? current.behind : current
}

/** Starts (or replaces) a live run over `current`, flattening through the
 * same rule as openReview: a run launched from an archived review view, or
 * from another still-running view, never stacks. */
export function openReviewRun(
  projectId: string,
  source: ReviewSource,
  mode: MrReviewMode,
  current: FocusView,
): FocusView {
  return { kind: 'reviewRun', projectId, source, mode, behind: restingBehind(current) }
}

export function closeReviewRun(current: FocusView): FocusView {
  return current.kind === 'reviewRun' ? current.behind : current
}

/** Value equality for ReviewSource: two sources naming the same MR number or
 * the same branch name are equal even as distinct objects, since every
 * status poll and SSE frame constructs a fresh one. */
export function sameReviewSource(a: ReviewSource, b: ReviewSource): boolean {
  if (a.kind === 'mr' && b.kind === 'mr') {
    return a.number === b.number
  }
  return a.kind === 'branch' && b.kind === 'branch' && a.name === b.name
}

/**
 * A live run finished archiving as `record`. It only takes over the scene
 * when `view` is still that exact run (same project, same source): any other
 * view, a different target, a different project, or the reader having
 * already navigated elsewhere, returns `view` UNCHANGED, same reference, so
 * watchers keyed on FocusView identity stay silent.
 */
export function promoteReviewRun(
  view: FocusView,
  projectId: string,
  source: ReviewSource,
  record: ReviewRecord,
): FocusView {
  if (
    view.kind !== 'reviewRun' ||
    view.projectId !== projectId ||
    !sameReviewSource(view.source, source)
  ) {
    return view
  }
  return { kind: 'review', record, behind: view.behind }
}

export function closeFocus(): FocusView {
  return EMPTY_FOCUS
}
