// Pure derivations of the sandboxed-checks state (checks.json mirror): the
// tab label semaphore, pass/fail aggregates, the queue mini-badge and the
// 'checks' journal line. Components only compose these functions (bun:test).

import { t, type MessageKey } from '../i18n'
import type { TaskCheck, TaskChecks, TaskCheckStatus, TaskEventData } from '../types'
import type { EventTone } from './useTaskBoard'

/** Visual tone of the Checks tab label (and the queue badge). */
export type ChecksTone = 'none' | 'run' | 'pass' | 'fail' | 'warn'

const TONE_BY_STATUS: Record<TaskChecks['status'], ChecksTone> = {
  running: 'run',
  passed: 'pass',
  failed: 'fail',
  // The runner itself broke (no container engine…): neither pass nor fail.
  error: 'warn',
  unconfigured: 'none',
}

export function checksTone(checks: Pick<TaskChecks, 'status'> | null): ChecksTone {
  return checks === null ? 'none' : TONE_BY_STATUS[checks.status]
}

const TAB_SUFFIX: Record<ChecksTone, string> = {
  none: '',
  run: ' …',
  pass: ' ✓',
  fail: ' ✗',
  warn: ' ⚠',
}

/** The tab IS the semaphore: "Checks ✓" green / "Checks ✗" red / "Checks …"
 * while running; bare "Checks" when nothing ran or nothing is configured. */
export function checksTabLabel(checks: Pick<TaskChecks, 'status'> | null): string {
  return `${t('workspace.tabChecks')}${TAB_SUFFIX[checksTone(checks)]}`
}

/** Queue mini-badge glyph; null = no badge (never ran / unconfigured). */
export function checksBadge(checks: Pick<TaskChecks, 'status'> | null): string | null {
  const suffix = TAB_SUFFIX[checksTone(checks)].trim()
  return suffix === '' ? null : suffix
}

/** passed/failed aggregates; a timeout counts as failed, skipped as neither. */
export function checksCounts(checks: readonly Pick<TaskCheck, 'status'>[]): {
  passed: number
  failed: number
} {
  let passed = 0
  let failed = 0
  for (const check of checks) {
    if (check.status === 'passed') {
      passed++
    } else if (check.status === 'failed' || check.status === 'timeout') {
      failed++
    }
  }
  return { passed, failed }
}

const int = (value: unknown): number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0

/** One journal line for a 'checks' event ({ status, passed, failed }):
 * "Checks — 3 passed" on go, "Checks — 1 failed" on stop. */
export function checksEventLine(data: TaskEventData): { tone: EventTone; text: string } {
  switch (data.status) {
    case 'passed': {
      const n = int(data.passed)
      return { tone: 'go', text: t('workspace.checksEvPassed', { n }, n) }
    }
    case 'failed': {
      const n = int(data.failed)
      return { tone: 'stop', text: t('workspace.checksEvFailed', { n }, n) }
    }
    case 'error':
      return { tone: 'stop', text: t('workspace.checksEvError') }
    case 'unconfigured':
      return { tone: 'idle', text: t('workspace.checksEvUnconfigured') }
    default:
      // A status this bundle does not know: label only, never a crash.
      return { tone: 'idle', text: t('workspace.evChecks') }
  }
}

/** Global status phrase of the tab body's badge. */
export const CHECKS_STATUS_KEY: Record<TaskChecks['status'], MessageKey> = {
  running: 'workspace.checksStatusRunning',
  passed: 'workspace.checksStatusPassed',
  failed: 'workspace.checksStatusFailed',
  error: 'workspace.checksStatusError',
  unconfigured: 'workspace.checksStatusUnconfigured',
}

/** Per-check row: status glyph + localized word. */
export const CHECK_GLYPH: Record<TaskCheckStatus, string> = {
  passed: '✓',
  failed: '✗',
  timeout: '⏱',
  skipped: '–',
}

export const CHECK_STATUS_KEY: Record<TaskCheckStatus, MessageKey> = {
  passed: 'workspace.checkPassed',
  failed: 'workspace.checkFailed',
  timeout: 'workspace.checkTimeout',
  skipped: 'workspace.checkSkipped',
}

/** Short display form of the verified head commit. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7)
}
