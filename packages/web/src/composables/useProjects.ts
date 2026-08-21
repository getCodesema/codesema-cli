// Pure logic of the multi-project workspace: which project card is active in
// the right panel, the per-card activity counters, and how a project's tree
// (open MRs + active base branches, conversations attached underneath) is
// built. The components and useTasks only compose these functions (testable
// with bun:test, no DOM, no fetch); the thin localStorage wrappers at the
// bottom are the only impure parts and stay best-effort.

import type { MessageKey } from '../i18n'
import type {
  ForgeMr,
  ForgeUnavailableReason,
  LocalBranch,
  Project,
  TaskRecord,
  TaskStatus,
  WorkspaceInfo,
} from '../types'
import { compareByActivity, sectionOf } from './useTaskBoard'
import type { TaskState } from './useTasks'

/**
 * 'origin/develop' and 'develop' are the SAME branch (mirror of the CLI's
 * shortBranchName): every grouping, comparison and display uses the short
 * identity, so a legacy record whose base was detected as 'origin/x' lands on
 * the same tree node as 'x'.
 */
export function shortBranch(name: string): string {
  return name.startsWith('origin/') ? name.slice('origin/'.length) : name
}

/**
 * Stable identity hue of a project, derived from its name alone (FNV-1a hash
 * spread by the golden angle): the same name always gets the same hue, two
 * neighbouring names land far apart on the wheel. Range: [0, 360).
 */
export function nameColor(name: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return Math.round(((hash >>> 0) * 137.508) % 360)
}

/** localStorage key of the active project card (single id). */
export const ACTIVE_PROJECT_STORAGE_KEY = 'codesema-ws-active-project'

/**
 * Keys retired with the checkbox multi-selection layout, purged on startup.
 * The old composer target is read once as a migration seed before the purge:
 * the last repo the user launched a task into is the best first active card.
 */
export const DEAD_STORAGE_KEYS = [
  'codesema-ws-projects',
  'codesema-ws-project',
  'codesema-ws-compose-project',
] as const

/** Soft migration: the persisted card wins, else the retired composer target. */
export function migrateActiveProject(
  raw: string | null,
  legacyComposer: string | null,
): string | null {
  return raw ?? legacyComposer
}

/**
 * Active card derivation: the persisted id wins while the registry knows it;
 * otherwise the API's `current` (the repo the workspace was launched from),
 * then the first registered project. Null only on an empty registry — an id
 * gone from the registry must never stay active.
 */
export function deriveActiveProject(
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
 * Isolation facts for the card the human is looking at (T1.4). Each project
 * carries its overlay on GET /api/projects; older CLIs omit it and we fall
 * back to the process-wide blob (launch repo).
 */
export function isolationForProject(
  projectId: string | null,
  projects: readonly Project[],
  fallback: WorkspaceInfo | null,
): WorkspaceInfo | null {
  if (projectId === null) {
    return fallback
  }
  return projects.find((project) => project.id === projectId)?.isolation ?? fallback
}

/**
 * The three motifs of D9, and the sentence each one deserves. A `Record` over
 * the union rather than a lookup with a default: a fourth motif appearing in
 * `ForgeUnavailableReason` stops compiling here instead of silently falling
 * back to the vaguest wording.
 */
const FORGE_REASON_KEYS: Record<ForgeUnavailableReason, MessageKey> = {
  'no-remote': 'workspace.forgeReasonNoRemote',
  'no-cli': 'workspace.forgeReasonNoCli',
  'cli-error': 'workspace.forgeReasonCliError',
}

/**
 * The reason the header must state, or null when there is nothing to state.
 *
 * Null covers exactly TWO cases, and neither is a degradation: the server said
 * the forge is available, or it said NOTHING at all (an older CLI, a workspace
 * that never probed). The second is "unknown", and the honest thing to do with
 * an unknown is to claim neither side — the doctrine `WorkspaceInfo` documents
 * on the field itself. What is never allowed is the reverse: `forge_available:
 * false` with no motif must still SAY something, hence the explicit unknown
 * wording rather than a silent null.
 */
export function forgeUnavailableKey(info: WorkspaceInfo | null): MessageKey | null {
  if (!info || info.forge_available !== false) {
    return null
  }
  // `forge_reason` is TYPED as the union but ARRIVES over the wire, from a CLI
  // that may be newer than this bundle. An unknown motif is looked up, misses,
  // and — before this guard — returned `undefined`, which the `v-if` reads as
  // "nothing to say" and the badge DISAPPEARS: a degradation the server took
  // the trouble to announce, silently swallowed by the half that exists to
  // show it. A motif we cannot name still gets said, with the wording for
  // exactly that. And `Object.hasOwn` rather than a plain lookup, because
  // `forge_reason: '__proto__'` (or 'toString') would otherwise hit
  // Object.prototype and hand the template a truthy non-key to render.
  const reason = info.forge_reason
  return reason !== undefined && Object.hasOwn(FORGE_REASON_KEYS, reason)
    ? FORGE_REASON_KEYS[reason]
    : 'workspace.forgeReasonUnknown'
}

/** Card counters: conversations needing the human vs conversations moving. */
export type ProjectActivity = { waiting: number; active: number }

/**
 * Counts each project's live conversations for its card pastilles, reusing
 * the rail's section grammar (done conversations count for nothing).
 */
export function countProjectActivity(
  states: readonly { projectId: string; record: { status: TaskStatus } }[],
): Map<string, ProjectActivity> {
  const counts = new Map<string, ProjectActivity>()
  for (const state of states) {
    const section = sectionOf(state.record.status)
    if (section === 'done') {
      continue
    }
    let entry = counts.get(state.projectId)
    if (!entry) {
      entry = { waiting: 0, active: 0 }
      counts.set(state.projectId, entry)
    }
    entry[section]++
  }
  return counts
}

/**
 * One expandable node of a project's tree: an open MR or an active base
 * branch, each carrying the conversations attached to it.
 */
export type ConversationNode =
  | { kind: 'mr'; mr: ForgeMr; states: TaskState[] }
  | { kind: 'branch'; name: string; states: TaskState[] }

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
    if (!mrNodes.has(shortBranch(mr.sourceBranch))) {
      mrNodes.set(shortBranch(mr.sourceBranch), node)
    }
    nodes.push(node)
  }

  const branchNodes = new Map<string, Extract<ConversationNode, { kind: 'branch' }>>()
  for (const state of states) {
    const shipped = state.record.branch ? mrNodes.get(shortBranch(state.record.branch)) : undefined
    if (shipped) {
      shipped.states.push(state)
      continue
    }
    const base = shortBranch(state.record.base)
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

/**
 * Local branches offered by the folded "Branches (N)" disclosure under the
 * tree: everything the tree does not already show. Excluded: branches that
 * are already tree nodes, the source branches of the displayed MRs, and the
 * technical codesema/task-* branches (a conversation carries them, they are
 * never a base to start from). Keeps the API order (most recent commit first).
 */
export function otherBranches(
  branches: readonly LocalBranch[],
  tree: readonly ConversationNode[],
  mrs: readonly ForgeMr[],
): string[] {
  const shown = new Set<string>()
  for (const node of tree) {
    shown.add(shortBranch(node.kind === 'mr' ? node.mr.sourceBranch : node.name))
  }
  for (const mr of mrs) {
    shown.add(shortBranch(mr.sourceBranch))
  }
  return branches
    .map((branch) => branch.name)
    .filter((name) => !shown.has(shortBranch(name)) && !name.startsWith('codesema/task-'))
}

// ── Branch click routing (amendment 4: a conversation IS its branch) ───────

/** Trunk branches: clicking one always forks a new codesema/task-* branch. */
const TRUNK_BRANCHES: ReadonlySet<string> = new Set(['main', 'master', 'develop'])

/** Exact-case trunk test: 'Main' is a regular branch, not a trunk. */
export const isTrunkBranch = (branch: string): boolean => TRUNK_BRANCHES.has(shortBranch(branch))

/**
 * Non-terminal statuses: at most ONE such conversation exists per branch
 * (server-side uniqueness guard). Terminal ones (shipped/failed) never block
 * a new conversation on their branch. This is NOT the rail's section grammar:
 * review_ok is done for the rail but still owns its branch.
 */
const ACTIVE_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'queued',
  'running',
  'waiting_for_you',
  'reviewing',
  'review_ok',
  'review_ko',
  'interrupted',
])

/** What a branch/MR click resolves to (frozen contract, see the plan). */
export type BranchClickResolution =
  | { kind: 'open'; taskId: string }
  | { kind: 'draft-fork'; base: string }
  | { kind: 'draft-workon'; branch: string; target: string | null }

/**
 * Routes every branch/MR click of the right panel (tree nodes, the
 * "Branches (N)" disclosure, MR nodes). In order:
 * 1. an ACTIVE conversation already carries this exact branch → open it;
 * 2. a trunk always forks a NEW conversation (draft in fork mode, base=trunk);
 * 3. anything else drafts a work-on conversation ON the branch itself, the
 *    MR's target branch (when the click came from an MR node) rides along.
 * Branch names compare with their exact case throughout.
 */
export function resolveBranchClick(
  branch: string,
  mr: ForgeMr | null,
  states: readonly { record: Pick<TaskRecord, 'id' | 'branch' | 'status'> }[],
): BranchClickResolution {
  const short = shortBranch(branch)
  const active = states.find(
    (state) =>
      shortBranch(state.record.branch) === short && ACTIVE_TASK_STATUSES.has(state.record.status),
  )
  if (active) {
    return { kind: 'open', taskId: active.record.id }
  }
  // Amendment: the mode is the HUMAN's choice, never routed by branch name.
  // A plain click means "work on it" — develop included (the draft column
  // shows a trunk warning and a one-click switch to fork-from instead).
  return { kind: 'draft-workon', branch: short, target: mr ? shortBranch(mr.targetBranch) : null }
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

/** Reads the persisted active card, seeded from the retired composer key. */
export function readPersistedActiveProject(): string | null {
  return migrateActiveProject(
    readStorageItem(ACTIVE_PROJECT_STORAGE_KEY),
    readStorageItem(DEAD_STORAGE_KEYS[2]),
  )
}

/** Persists the active card id. */
export function persistActiveProject(id: string): void {
  writeStorageItem(ACTIVE_PROJECT_STORAGE_KEY, id)
}

/** Removes the retired keys; call once after readPersistedActiveProject. */
export function purgeDeadStorageKeys(): void {
  try {
    if (typeof localStorage !== 'undefined') {
      for (const key of DEAD_STORAGE_KEYS) {
        localStorage.removeItem(key)
      }
    }
  } catch {
    // Best-effort.
  }
}
