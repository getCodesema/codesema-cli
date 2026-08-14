// Pure logic of the multi-project workspace: which project is current, which
// tasks belong to it, which conversations are recent. Components and useTasks
// only compose these functions (testable with bun:test, no DOM, no fetch).

import type { Project, TaskRecord } from '../types'
import { compareByActivity } from './useTaskBoard'

/** localStorage key of the last selected project id. */
export const PROJECT_STORAGE_KEY = 'codesema-ws-project'

/**
 * Current project derivation: the persisted choice wins, then the `current`
 * the API computed (the repo `codesema workspace` was launched from), then the
 * first registered project. Ids unknown to the registry are ignored — a
 * removed project must never stay current. Null on an empty registry.
 */
export function deriveCurrentProject(
  persisted: string | null,
  apiCurrent: string | null,
  projects: Project[],
): string | null {
  const known = new Set(projects.map((project) => project.id))
  if (persisted !== null && known.has(persisted)) {
    return persisted
  }
  if (apiCurrent !== null && known.has(apiCurrent)) {
    return apiCurrent
  }
  return projects[0]?.id ?? null
}

/**
 * Keeps only the items of one project. Everything scoped on the home board
 * (sections, recents, counts) goes through this single filter; a null project
 * (empty registry) shows nothing rather than an accidental cross-repo mix.
 */
export function filterByProject<T extends { projectId: string }>(
  items: T[],
  projectId: string | null,
): T[] {
  if (projectId === null) {
    return []
  }
  return items.filter((item) => item.projectId === projectId)
}

/** Sidebar recents: most recently touched conversations first, capped. */
export function sortRecents<T extends { record: Pick<TaskRecord, 'updated_at' | 'id'> }>(
  items: T[],
  limit = 8,
): T[] {
  return items
    .toSorted((a, b) => compareByActivity(a.record, b.record))
    .slice(0, Math.max(0, limit))
}
