// Pure "time ago" formatting for a fixed ISO timestamp: bucketed into just
// now / minutes / hours / days / weeks / months / years, each unit wrapped
// through i18n. `now` is an explicit parameter (defaulting to the wall
// clock) so callers can render deterministically in tests.

import { t } from './i18n'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY
const MONTH = 30 * DAY
const YEAR = 365 * DAY

/**
 * A timestamp at or after `now` (clock skew, or a value that has not
 * happened yet) never produces a negative count: it collapses to the same
 * "just now" bucket as a genuinely fresh timestamp, rather than showing
 * something like "-3 min ago".
 */
export function formatRelativeAge(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) {
    return ''
  }
  const diffMs = Math.max(0, now - then)

  if (diffMs < MINUTE) {
    return t('time.justNow')
  }
  if (diffMs < HOUR) {
    return t('time.minutesAgo', { n: Math.floor(diffMs / MINUTE) })
  }
  if (diffMs < DAY) {
    return t('time.hoursAgo', { n: Math.floor(diffMs / HOUR) })
  }
  if (diffMs < WEEK) {
    return t('time.daysAgo', { n: Math.floor(diffMs / DAY) })
  }
  if (diffMs < MONTH) {
    return t('time.weeksAgo', { n: Math.floor(diffMs / WEEK) })
  }
  if (diffMs < YEAR) {
    return t('time.monthsAgo', { n: Math.floor(diffMs / MONTH) })
  }
  const n = Math.floor(diffMs / YEAR)
  return t('time.yearsAgo', { n }, n)
}
