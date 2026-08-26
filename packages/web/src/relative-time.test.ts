import { describe, expect, test } from 'bun:test'
import { t } from './i18n'
import { formatRelativeAge } from './relative-time'

const NOW = Date.parse('2026-08-20T12:00:00.000Z')

function isoAt(offsetMs: number): string {
  return new Date(NOW - offsetMs).toISOString()
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

  test('exactly one day crosses into the days bucket', () => {
    expect(formatRelativeAge(isoAt(86_400_000), NOW)).toBe(t('time.daysAgo', { n: 1 }))
  })

  test('just under a week still reads in days', () => {
    expect(formatRelativeAge(isoAt(604_799_999), NOW)).toBe(t('time.daysAgo', { n: 6 }))
  })

  test('exactly one week crosses into the weeks bucket', () => {
    expect(formatRelativeAge(isoAt(604_800_000), NOW)).toBe(t('time.weeksAgo', { n: 1 }))
  })

  test('just under a month still reads in weeks', () => {
    expect(formatRelativeAge(isoAt(2_591_999_999), NOW)).toBe(t('time.weeksAgo', { n: 4 }))
  })

  test('exactly one month crosses into the months bucket', () => {
    expect(formatRelativeAge(isoAt(2_592_000_000), NOW)).toBe(t('time.monthsAgo', { n: 1 }))
  })

  test('just under a year still reads in months', () => {
    expect(formatRelativeAge(isoAt(31_535_999_999), NOW)).toBe(t('time.monthsAgo', { n: 12 }))
  })

  test('exactly one year crosses into the years bucket', () => {
    expect(formatRelativeAge(isoAt(31_536_000_000), NOW)).toBe(t('time.yearsAgo', { n: 1 }, 1))
  })

  test('several years still reads as a plain year count', () => {
    expect(formatRelativeAge(isoAt(31_536_000_000 * 3), NOW)).toBe(t('time.yearsAgo', { n: 3 }, 3))
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
