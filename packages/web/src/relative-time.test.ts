import { describe, expect, test } from 'bun:test'
import { t } from './i18n'
import { formatRelativeAge } from './relative-time'

const NOW = Date.parse('2026-08-20T12:00:00.000Z')

function isoAt(offsetMs: number): string {
  return new Date(NOW - offsetMs).toISOString()
}

/** The two absolute shapes the function switches to, built the same way it
 * builds them: the assertion pins the FORMAT, never the reader's timezone. */
function weekdayStamp(iso: string): string {
  return new Intl.DateTimeFormat(t('time.locale'), {
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso))
}

function dateStamp(iso: string): string {
  return new Intl.DateTimeFormat(t('time.locale'), {
    hour12: false,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso))
}

describe('formatRelativeAge', () => {
  test('an instant timestamp reads as just now', () => {
    expect(formatRelativeAge(isoAt(0), NOW)).toBe(t('time.justNow'))
  })

  test('just under a minute still reads as just now', () => {
    expect(formatRelativeAge(isoAt(59_999), NOW)).toBe(t('time.justNow'))
  })

  test('exactly one minute crosses into the minutes bucket', () => {
    expect(formatRelativeAge(isoAt(60_000), NOW)).toBe(t('time.minutesAgo', { n: 1 }))
  })

  test('just under an hour still reads in minutes', () => {
    expect(formatRelativeAge(isoAt(3_599_999), NOW)).toBe(t('time.minutesAgo', { n: 59 }))
  })

  test('exactly one hour crosses into the hours bucket', () => {
    expect(formatRelativeAge(isoAt(3_600_000), NOW)).toBe(t('time.hoursAgo', { n: 1 }))
  })

  test('just under a day still reads in hours', () => {
    expect(formatRelativeAge(isoAt(86_399_999), NOW)).toBe(t('time.hoursAgo', { n: 23 }))
  })

  test('a day old leaves the relative buckets for a weekday and a clock time', () => {
    const iso = isoAt(86_400_000)
    expect(formatRelativeAge(iso, NOW)).toBe(weekdayStamp(iso))
  })

  test('just under a week still reads as a weekday', () => {
    const iso = isoAt(604_799_999)
    expect(formatRelativeAge(iso, NOW)).toBe(weekdayStamp(iso))
  })

  test('a week old switches to a numeric date', () => {
    const iso = isoAt(604_800_000)
    expect(formatRelativeAge(iso, NOW)).toBe(dateStamp(iso))
  })

  test('a year old still reads as that same numeric date', () => {
    const iso = isoAt(31_536_000_000)
    expect(formatRelativeAge(iso, NOW)).toBe(dateStamp(iso))
  })

  test('the two absolute formats never fall back to a relative sentence', () => {
    const week = formatRelativeAge(isoAt(604_800_000), NOW)
    expect(week).not.toContain(t('time.justNow'))
    expect(week).toMatch(/\d{2}:\d{2}/)
  })

  test('a future timestamp never produces a negative age: it clamps to just now', () => {
    expect(formatRelativeAge(isoAt(-5 * 60_000), NOW)).toBe(t('time.justNow'))
  })

  test('an unparsable timestamp fails safe to an empty string rather than "NaN"', () => {
    expect(formatRelativeAge('not-a-date', NOW)).toBe('')
  })

  test('with no explicit `now`, it falls back to the wall clock', () => {
    expect(formatRelativeAge(new Date().toISOString())).toBe(t('time.justNow'))
  })
})
