// Pure derivations of the isolation badge (how a conversation's agent turns
// are contained) and of the one-time "improve your isolation" banner. The
// components only compose these functions (bun:test, no DOM); the localStorage
// wrappers at the bottom are the only impure part and stay best-effort.
//
// Honesty rule, applied everywhere here: a record that carries no isolation
// comes from a CLI that had none, so it is 'policy' — the weaker claim. The UI
// never upgrades a task's containment on its own.

import type { MessageKey } from '../i18n'
import type { TaskIsolation, TaskRecord, WorkspaceInfo } from '../types'

/** Effective isolation of a record; absent (older records) = 'policy'. */
export function taskIsolation(record: Pick<TaskRecord, 'isolation'>): TaskIsolation {
  if (record.isolation === 'container' || record.isolation === 'microvm') {
    return record.isolation
  }
  return 'policy'
}

/** Chip glyph: the shield is the cage, the box is the microVM, the diamond is the policy hardening. */
export const ISOLATION_GLYPH: Record<TaskIsolation, string> = {
  container: '🛡',
  microvm: '▣',
  policy: '◇',
}

/** Chip text — technical words, identical in every locale. */
export const ISOLATION_LABEL_KEY: Record<TaskIsolation, MessageKey> = {
  container: 'workspace.isolationContainer',
  microvm: 'workspace.isolationMicrovm',
  policy: 'workspace.isolationPolicy',
}

/** Tooltip: what this isolation actually guarantees, in one sentence. */
export const ISOLATION_HINT_KEY: Record<TaskIsolation, MessageKey> = {
  container: 'workspace.isolationContainerHint',
  microvm: 'workspace.isolationMicrovmHint',
  policy: 'workspace.isolationPolicyHint',
}

/** Everything a chip needs, resolved from the record alone. */
export type IsolationBadge = {
  isolation: TaskIsolation
  glyph: string
  labelKey: MessageKey
  hintKey: MessageKey
}

export function isolationBadge(record: Pick<TaskRecord, 'isolation'>): IsolationBadge {
  const isolation = taskIsolation(record)
  return {
    isolation,
    glyph: ISOLATION_GLYPH[isolation],
    labelKey: ISOLATION_LABEL_KEY[isolation],
    hintKey: ISOLATION_HINT_KEY[isolation],
  }
}

/**
 * Queue cards get a dot only when it carries information: a caged task always
 * shows it, and a policy task shows it when the cage EXISTS here (so the two
 * kinds are told apart at a glance). On a workspace where no task can ever be
 * caged, a dot on every card would repeat one fact N times — the banner below
 * says it once instead.
 */
export function showIsolationDot(
  record: Pick<TaskRecord, 'isolation'>,
  workspace: WorkspaceInfo | null,
): boolean {
  const isolation = taskIsolation(record)
  return (
    isolation === 'container' ||
    isolation === 'microvm' ||
    (workspace?.isolation_available ?? false)
  )
}

/** localStorage key of the dismissed upgrade banner (one workspace, one choice). */
export const ISOLATION_BANNER_STORAGE_KEY = 'codesema-ws-isolation-banner'

/** Where "improve the isolation" points; one line to change when the docs move. */
export const ISOLATION_DOC_URL = 'https://github.com/getCodesema/codesema-cli#readme'

/**
 * The one-time banner: shown when new tasks fall back to policy while a
 * container runtime COULD have carried them (installing one is the fix). Never
 * shown when the cage is already the default, when the server said nothing
 * (unknown ≠ degraded), when the user explicitly configured 'policy' — on the
 * servers that report the choice — or once dismissed.
 */
export function shouldOfferIsolationUpgrade(
  workspace: WorkspaceInfo | null,
  dismissed: boolean,
): boolean {
  if (workspace === null || dismissed) {
    return false
  }
  if (
    workspace.isolation_available ||
    workspace.isolation_default === 'container' ||
    workspace.isolation_default === 'microvm'
  ) {
    return false
  }
  return workspace.isolation_configured !== 'policy'
}

// ── localStorage wrappers (best-effort: privacy modes can throw) ───────────

/** True when the human already dismissed the banner on this machine. */
export function readIsolationBannerDismissed(): boolean {
  try {
    return (
      typeof localStorage !== 'undefined' &&
      localStorage.getItem(ISOLATION_BANNER_STORAGE_KEY) === '1'
    )
  } catch {
    return false
  }
}

/** Persists the dismissal; a failure only means the banner comes back. */
export function persistIsolationBannerDismissed(): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(ISOLATION_BANNER_STORAGE_KEY, '1')
    }
  } catch {
    // Best-effort, like every other persisted UI preference here.
  }
}
