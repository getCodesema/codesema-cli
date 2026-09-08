// Date formatting for a fixed ISO timestamp. Under a day the age reads as a
// relative bucket (just now / minutes / hours); under a week it becomes a
// weekday and a clock time; beyond that a numeric date. `now` is an explicit
// parameter (defaulting to the wall clock) so callers can render
// deterministically in tests.

import { t } from './i18n'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY

function dateFormat(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(t('time.locale'), { hour12: false, ...options })
}

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
  const date = new Date(then)
  if (diffMs < WEEK) {
    return dateFormat({ weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(date)
  }
  return dateFormat({
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

/** Full date and time, for the `title` of a line that shows an abridged one. */
export function formatExactStamp(iso: string): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) {
    return ''
  }
  return dateFormat({ dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(then))
}
