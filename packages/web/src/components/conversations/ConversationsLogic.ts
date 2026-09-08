// Pure state logic of the conversations column: no Vue, no lucide, testable
// standalone. Two resolvers taken from the internal measurement notes and
// adapted to OUR data model, rather than inventing fields we do not carry:
//
// - formatConversationTimestamp: the five-regime calendar-day timestamp
//   (sheet §9), reusing clockTime (useTaskBoard.ts) for the HH:mm half so the
//   24h convention stays the ONE place it is decided.
// - orderConversations: the rail's ONE flat order (a conversation is not a
//   child of a project), state precedence reused from
//   queueSectionOf/compareByActivity (useTaskBoard.ts) rather than
//   re-deriving it.

import {
  clockTime,
  compareByActivity,
  queueSectionOf,
  type QueueSection,
} from '../../composables/useTaskBoard'
import type { TaskState } from '../../composables/useTasks'
import { t, type MessageKey } from '../../i18n'

// -- §9: five-regime timestamp, calendar days in LOCAL time -----------------

const WEEKDAY_KEYS: readonly MessageKey[] = [
  'time.weekdaySun',
  'time.weekdayMon',
  'time.weekdayTue',
  'time.weekdayWed',
  'time.weekdayThu',
  'time.weekdayFri',
  'time.weekdaySat',
]

const MONTH_KEYS: readonly MessageKey[] = [
  'time.monthJan',
  'time.monthFeb',
  'time.monthMar',
  'time.monthApr',
  'time.monthMay',
  'time.monthJun',
  'time.monthJul',
  'time.monthAug',
  'time.monthSep',
  'time.monthOct',
  'time.monthNov',
  'time.monthDec',
]

const DAY_MS = 86_400_000

/** Local midnight of the instant, as an epoch ms: the anchor calendar-day
 * arithmetic is computed against, so a diff never depends on the wall-clock
 * hour of either timestamp (that is the whole point of sheet §9, see the
 * file header). */
function localMidnight(epochMs: number): number {
  const d = new Date(epochMs)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/**
 * The five regimes of sheet §9: today (time alone), yesterday (plus time),
 * 2 to 6 days (abbreviated weekday plus time), same year (abbreviated month
 * plus day), year elapsed (plus year). `now` is an explicit parameter
 * (default the wall clock) so callers can render deterministically in
 * tests, same convention as relative-time.ts's own formatRelativeAge.
 *
 * A timestamp at or after `now` (clock skew, or one that has not happened
 * yet) collapses to the "today" regime rather than a negative day count.
 */
export function formatConversationTimestamp(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) {
    return ''
  }
  const time = clockTime(iso)
  const dayDiff = Math.round((localMidnight(now) - localMidnight(at)) / DAY_MS)
  if (dayDiff <= 0) {
    return time
  }
  if (dayDiff === 1) {
    return t('time.yesterdayAt', { t: time })
  }
  if (dayDiff <= 6) {
    const day = t(WEEKDAY_KEYS[new Date(at).getDay()] ?? 'time.weekdaySun')
    return t('time.weekdayAt', { day, t: time })
  }
  const atDate = new Date(at)
  const month = t(MONTH_KEYS[atDate.getMonth()] ?? 'time.monthJan')
  const day = String(atDate.getDate())
  if (atDate.getFullYear() === new Date(now).getFullYear()) {
    return t('time.monthDay', { month, day })
  }
  return t('time.monthDayYear', { month, day, year: String(atDate.getFullYear()) })
}

// -- Flat order: state precedence, then most recent activity ----------------

const SECTION_RANK: Record<QueueSection, number> = { attention: 0, active: 1, ready: 2, done: 3 }

/**
 * The rail's single order: what waits on the human first, then what the
 * machine is working on, then what is ready to ship, then the finished pile;
 * most recently active first within a tie. The SAME state precedence the work
 * queue already uses, applied to every conversation at once — a conversation
 * with no project sorts like any other.
 */
export function orderConversations(states: readonly TaskState[]): TaskState[] {
  return states.toSorted((a, b) => {
    const rank =
      SECTION_RANK[queueSectionOf(a.record.status)] - SECTION_RANK[queueSectionOf(b.record.status)]
    return rank !== 0 ? rank : compareByActivity(a.record, b.record)
  })
}

// -- §2: search field right padding, computed from the icon count present ---

const SEARCH_PADDING_BASE = 36
const SEARCH_PADDING_PER_ICON = 20

/** Right padding for the search input, in px: base clearance plus one step
 * per trailing icon actually shown, so the text never runs under an icon.
 * Sheet §2's own 36/56/76 progression for 0/1/2 icons. */
export function searchRightPadding(iconCount: number): number {
  return SEARCH_PADDING_BASE + Math.max(0, iconCount) * SEARCH_PADDING_PER_ICON
}
