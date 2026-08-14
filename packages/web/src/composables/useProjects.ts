// Pure logic of the multi-project workspace: which projects are selected,
// which tasks belong to them, and how each project's sidebar tree (open MRs +
// active base branches, conversations attached underneath) is built. The
// components and useTasks only compose these functions (testable with
// bun:test, no DOM, no fetch); the thin localStorage wrappers at the bottom
// are the only impure parts and stay best-effort.

import type { ForgeMr, Project } from '../types'
import { compareByActivity, sectionOf } from './useTaskBoard'
import type { TaskState } from './useTasks'

/** localStorage key of the selected project ids (JSON array). */
export const PROJECTS_STORAGE_KEY = 'codesema-ws-projects'

/** Pre-multi-select key (single id); migrated into PROJECTS_STORAGE_KEY. */
export const LEGACY_PROJECT_STORAGE_KEY = 'codesema-ws-project'

/** localStorage key of the composer's last used target project id. */
export const COMPOSER_PROJECT_STORAGE_KEY = 'codesema-ws-compose-project'

/**
 * Decodes the persisted selection: the multi key wins when it holds a valid
 * JSON string array; otherwise the legacy single-project key migrates as a
 * one-element selection. Null when nothing usable was persisted.
 */
export function parsePersistedSelection(
  raw: string | null,
  legacy: string | null,
): string[] | null {
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.every((id) => typeof id === 'string')) {
        return parsed
      }
    } catch {
      // Corrupt value: fall through to the legacy key.
    }
  }
  return legacy !== null && legacy.length > 0 ? [legacy] : null
}

/**
 * Selection derivation: the persisted ids intersected with the registry win;
 * an empty or null result falls back to the API's `current` (the repo the
 * workspace was launched from), then to every registered project. Ids unknown
 * to the registry are dropped — a removed project must never stay selected.
 */
export function deriveSelection(
  persisted: string[] | null,
  apiCurrent: string | null,
  projects: Project[],
): string[] {
  const known = projects.map((project) => project.id)
  const knownSet = new Set(known)
  if (persisted !== null) {
    const kept = persisted.filter((id) => knownSet.has(id))
    if (kept.length > 0) {
      return kept
    }
  }
  if (apiCurrent !== null && knownSet.has(apiCurrent)) {
    return [apiCurrent]
  }
  return known
}

/**
 * Composer target derivation: the last used project persists as long as it is
 * still selected; otherwise the first selected project.
 */
export function deriveComposerProject(persisted: string | null, selected: string[]): string | null {
  if (persisted !== null && selected.includes(persisted)) {
    return persisted
  }
  return selected[0] ?? null
}

/**
 * Keeps only the items of the selected projects. Everything scoped on the
 * merged board goes through this single filter; an empty selection shows
 * nothing rather than an accidental cross-repo mix.
 */
export function filterBySelection<T extends { projectId: string }>(
  items: T[],
  selected: ReadonlySet<string>,
): T[] {
  return items.filter((item) => selected.has(item.projectId))
}

/**
 * One expandable node of a project's sidebar tree: an open MR or an active
 * base branch, each carrying the conversations attached to it.
 */
export type ConversationNode =
  | { kind: 'mr'; mr: ForgeMr; states: TaskState[] }
  | { kind: 'branch'; name: string; states: TaskState[] }

/** One selected project's sidebar tree, ready to render. */
export type ProjectTree = { project: Project; nodes: ConversationNode[] }

/** Most recent activity of a node: its conversations first, the MR's own
 * update time when it carries none, epoch for an empty branch node. */
function nodeActivity(node: ConversationNode): number {
  const latest = node.states.reduce((max, state) => {
    const at = Date.parse(state.record.updated_at)
    return Number.isNaN(at) ? max : Math.max(max, at)
  }, Number.NEGATIVE_INFINITY)
  if (latest !== Number.NEGATIVE_INFINITY) {
    return latest
  }
  return node.kind === 'mr' ? Date.parse(node.mr.updatedAt) || 0 : 0
}

/** Stable tie-break so equal-activity nodes keep a deterministic order. */
function nodeLabel(node: ConversationNode): string {
  return node.kind === 'mr' ? `!${node.mr.number}` : node.name
}

/**
 * Builds one project's tree: a node per open MR, plus a node per base branch
 * that still carries unattached conversations. Attachment rule (frozen
 * contract): a conversation belongs to the open MR whose sourceBranch is the
 * task's branch when one exists (a shipped task), otherwise to its base
 * branch node. The technical codesema/task-* branches never become nodes —
 * the conversation carries them. Nodes sort by their most recent conversation
 * activity, conversations by activity within each node. With no MRs (forge
 * unavailable) the tree degrades to branch nodes only.
 */
export function buildProjectTree(states: TaskState[], mrs: ForgeMr[]): ConversationNode[] {
  const mrNodes = new Map<string, Extract<ConversationNode, { kind: 'mr' }>>()
  const nodes: ConversationNode[] = []
  for (const mr of mrs) {
    const node: Extract<ConversationNode, { kind: 'mr' }> = { kind: 'mr', mr, states: [] }
    // Two open MRs from one source branch cannot happen on a forge; keep the
    // first defensively so a conversation never appears twice.
    if (!mrNodes.has(mr.sourceBranch)) {
      mrNodes.set(mr.sourceBranch, node)
    }
    nodes.push(node)
  }

  const branchNodes = new Map<string, Extract<ConversationNode, { kind: 'branch' }>>()
  for (const state of states) {
    const shipped = state.record.branch ? mrNodes.get(state.record.branch) : undefined
    if (shipped) {
      shipped.states.push(state)
      continue
    }
    const base = state.record.base
    let node = branchNodes.get(base)
    if (!node) {
      node = { kind: 'branch', name: base, states: [] }
      branchNodes.set(base, node)
      nodes.push(node)
    }
    node.states.push(state)
  }

  for (const node of nodes) {
    node.states.sort((a, b) => compareByActivity(a.record, b.record))
  }
  return nodes.toSorted((a, b) => {
    const delta = nodeActivity(b) - nodeActivity(a)
    if (delta !== 0) {
      return delta
    }
    return nodeLabel(a) < nodeLabel(b) ? -1 : nodeLabel(a) > nodeLabel(b) ? 1 : 0
  })
}

/** A node worth unfolding by default: one of its conversations is not done. */
export function nodeHasActiveConversation(node: ConversationNode): boolean {
  return node.states.some((state) => sectionOf(state.record.status) !== 'done')
}

// ── localStorage wrappers (best-effort: privacy modes can throw) ───────────

function readStorageItem(key: string): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStorageItem(key: string, value: string): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, value)
    }
  } catch {
    // Best-effort: the API's `current` re-seeds the choice next launch.
  }
}

/** Reads the persisted selection, migrating the legacy single-project key. */
export function readPersistedSelection(): string[] | null {
  return parsePersistedSelection(
    readStorageItem(PROJECTS_STORAGE_KEY),
    readStorageItem(LEGACY_PROJECT_STORAGE_KEY),
  )
}

/** Persists the selection and retires the legacy key (migration completes). */
export function persistSelection(ids: string[]): void {
  writeStorageItem(PROJECTS_STORAGE_KEY, JSON.stringify(ids))
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(LEGACY_PROJECT_STORAGE_KEY)
    }
  } catch {
    // Best-effort.
  }
}

/** Reads the composer's last used target project id. */
export function readPersistedComposerProject(): string | null {
  return readStorageItem(COMPOSER_PROJECT_STORAGE_KEY)
}

/** Persists the composer's target project id. */
export function persistComposerProject(id: string): void {
  writeStorageItem(COMPOSER_PROJECT_STORAGE_KEY, id)
}
