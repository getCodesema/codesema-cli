// Pure geometry and display logic for the changes panel (the MR side panel
// attached to a conversation). Split out so it is unit-testable with no DOM,
// same doctrine as forge/ForgeLogic.ts.
//
// The resize math below deliberately does NOT reuse forge/ForgeLogic.ts's
// widthAfterDrag/widthAfterKey: those drive a splitter to the RIGHT of a
// LEFT-docked panel (dragging right grows it). This panel is RIGHT-docked
// with its handle on its OWN left edge, so the sign is mirrored (dragging
// the handle left grows it). Same shape, different docking side, so per the
// project's own DRY doctrine ("deux fonctions qui font la même chose pour
// des raisons différentes peuvent rester séparées") they stay apart, the
// clamping primitive (clampWidth) and the notch-size constants are still
// shared, only the direction differs.

import type { ForgeCheckRollup, ForgeMr } from '../../types'
import { clampWidth, FORGE_SPLITTER_STEP, FORGE_SPLITTER_STEP_COARSE } from '../forge/ForgeLogic'
import { aggregateCheckStatus, type CheckAggregateStatus } from '../mr/Checks'

// ── Panel width (fiche 14 §2) ───────────────────────────────────────────────

export const CHANGES_PANEL_WIDTH_DEFAULT = 460
export const CHANGES_PANEL_WIDTH_MIN = 320
/** The panel never crowds the conversation below this many pixels: the
 * maximum is "the window minus a reserve", not a fixed number, so a wide
 * screen lets the panel grow generously while a narrow one still protects
 * the fil. */
export const CHANGES_PANEL_RESERVE = 560

/** The panel's maximum width for a given viewport width. Never below the
 * panel's own minimum: on a viewport narrower than MIN + RESERVE, the
 * reserve loses and the panel keeps its floor rather than collapsing under
 * it. */
export function maxChangesPanelWidth(viewportWidth: number): number {
  return Math.max(CHANGES_PANEL_WIDTH_MIN, viewportWidth - CHANGES_PANEL_RESERVE)
}

export type ChangesPanelBounds = { min: number; max: number; defaultWidth: number }

/**
 * Width after a pointer drag on the panel's own LEFT-edge handle: dragging
 * the handle left (negative deltaX) grows the panel, dragging it right
 * shrinks it. Mirror image of ForgeLogic.ts's widthAfterDrag.
 */
export function widthAfterDrag(
  startWidth: number,
  deltaX: number,
  min: number,
  max: number,
): number {
  return clampWidth(startWidth - deltaX, min, max)
}

/**
 * Width after one keyboard interaction on the handle (ARIA "window
 * splitter" pattern, same key vocabulary as ForgeLogic.ts's widthAfterKey):
 * ArrowLeft grows (the handle, and so the panel's left edge, moves further
 * left), ArrowRight shrinks, Enter recalls the default width. `null` means
 * "not this handle's key", same contract as ForgeLogic.ts.
 */
export function widthAfterKey(
  key: string,
  current: number,
  bounds: ChangesPanelBounds,
  coarse = false,
): number | null {
  const { min, max, defaultWidth } = bounds
  const step = coarse ? FORGE_SPLITTER_STEP_COARSE : FORGE_SPLITTER_STEP
  if (key === 'ArrowLeft') {
    return clampWidth(current + step, min, max)
  }
  if (key === 'ArrowRight') {
    return clampWidth(current - step, min, max)
  }
  if (key === 'Enter') {
    return clampWidth(defaultWidth, min, max)
  }
  return null
}

// ── Diff mount delay (fiche 14 §6) ──────────────────────────────────────────

/** A file's diff render is mounted this many ms after its row is expanded,
 * never sooner: unfolding several files in a row schedules several delayed
 * mounts instead of blocking the thread on one synchronous batch. */
export const DIFF_MOUNT_DELAY_MS = 140

// ── PR state badge (fiche 14 §4) ────────────────────────────────────────────
//
// Deliberately its own small classifier, NOT imported from mr/MrCard.vue:
// that file is out of scope for this component (read-only per the lot's
// brief) and does not export its `mrState` computed. The four-way
// open/draft/merged/closed split is the same rule MrCard.vue applies
// in-file, genuinely duplicated here for that reason, flagged so a later
// pass can hoist both onto one shared classifier. The COLORS differ from
// MrCard.vue on purpose: this fiche's own measurement calls for green/open,
// lavender/merged (never green: a merged MR whose checks failed would
// otherwise read as green for two contradictory reasons), matching this
// app's other lavender-for-merged badge (forge/ForgeDetailPanel.vue).

export type MrStateVariant = 'open' | 'draft' | 'merged' | 'closed'

export function mrStateVariant(mr: Pick<ForgeMr, 'state' | 'isDraft'>): MrStateVariant | null {
  if (mr.state === null) {
    return null
  }
  if (mr.state === 'open' && mr.isDraft === true) {
    return 'draft'
  }
  if (mr.state === 'open') {
    return 'open'
  }
  if (mr.state === 'merged') {
    return 'merged'
  }
  return 'closed'
}

// ── Forge name (fiche 14 §4, "texte brut") ──────────────────────────────────
//
// ForgeMr carries no provider field of its own (mirrors the CLI probe,
// packages/cli/src/forge-mrs.ts): the only forge-identifying data on it is
// `url`. This app supports exactly two forges (gh/glab, per the CLI's own
// install hints), so only their two hostnames are named; anything else
// (a self-hosted instance) falls back to its own hostname, a plain fact
// rather than a guess.

export function forgeNameFromUrl(url: string): string {
  let hostname: string
  try {
    hostname = new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
  if (hostname === 'github.com') {
    return 'GitHub'
  }
  if (hostname === 'gitlab.com') {
    return 'GitLab'
  }
  return hostname
}

// ── Checks tab indicator (fiche 14 §3) ──────────────────────────────────────
//
// "42 sur 42" and "12 sur 42" do not say the same thing, so the tab needs a
// real fraction, not a bare count, but ONLY when the rollup is not
// truncated: a truncated rollup's four counts are a floor, never a total
// (see ForgeCheckRollup's own doc comment), so a fraction built from them
// would read as more honest than it is. Mirrors MrCard.vue's own
// truncated/not-truncated split for the same reason.

export type ChecksTabIndicator =
  | { kind: 'fraction'; passed: number; total: number; status: CheckAggregateStatus }
  | { kind: 'aggregate'; status: CheckAggregateStatus }

export function checksTabIndicator(checks: ForgeCheckRollup | null): ChecksTabIndicator | null {
  if (checks === null) {
    return null
  }
  const status = aggregateCheckStatus(checks)
  if (checks.truncated) {
    return { kind: 'aggregate', status }
  }
  const total = checks.passed + checks.failed + checks.pending + checks.skipped
  if (total === 0) {
    return null
  }
  return { kind: 'fraction', passed: checks.passed, total, status }
}
