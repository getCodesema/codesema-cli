// Pure state logic of the conversations column: no Vue, no lucide, testable
// standalone. Four resolvers taken from the internal measurement notes and
// adapted to OUR data model, rather than inventing fields we do not carry:
//
// - formatConversationTimestamp: the five-regime calendar-day timestamp
//   (sheet §9), reusing clockTime (useTaskBoard.ts) for the HH:mm half so the
//   24h convention stays the ONE place it is decided.
// - groupConversationsByProject: project-then-state grouping (sheet §10.2:
//   our natural grouping is the PROJECT, never a user-made folder we do not
//   have), state precedence reused from queueSectionOf/compareByActivity
//   (useTaskBoard.ts) rather than re-deriving it.
// - resolveActivityLine: the row's status line, a single ordered resolver
//   (sheet §8) built from TaskStatus plus the last question, never a
//   sub-agent/goal-loop count, fields we do not carry. The motion rule is
//   reproduced exactly: what waits on the human is static, what works
//   pulses or spins.
// - resolveChecksPill: the reference pill's state precedence (sheet §7),
//   grounded on checks_status/checks.status and reason.code, the sandboxed
//   checks run being our closest real analogue of "the linked PR's CI
//   status".

import {
  clockTime,
  compareByActivity,
  lastQuestion,
  queueSectionOf,
  statusPhraseKey,
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

// -- §10.2: grouping, project (our "folder") then state precedence ----------

export type ProjectGroup = {
  projectId: string
  projectName: string
  states: TaskState[]
}

const SECTION_RANK: Record<QueueSection, number> = { attention: 0, active: 1, ready: 2, done: 3 }

/**
 * Groups conversations by project, each project's rows ordered by the SAME
 * state precedence the work queue already uses (attention, then active,
 * then ready, then done; most recently active first within a tie) rather
 * than a second re-derivation of it. Groups themselves sort by project
 * display name.
 */
export function groupConversationsByProject(
  states: readonly TaskState[],
  projectNames: ReadonlyMap<string, string>,
): ProjectGroup[] {
  const byProject = new Map<string, TaskState[]>()
  for (const state of states) {
    const list = byProject.get(state.projectId)
    if (list) {
      list.push(state)
    } else {
      byProject.set(state.projectId, [state])
    }
  }
  const groups: ProjectGroup[] = []
  for (const [projectId, group] of byProject) {
    groups.push({
      projectId,
      projectName: projectNames.get(projectId) ?? projectId,
      states: group.toSorted((a, b) => {
        const rank =
          SECTION_RANK[queueSectionOf(a.record.status)] -
          SECTION_RANK[queueSectionOf(b.record.status)]
        return rank !== 0 ? rank : compareByActivity(a.record, b.record)
      }),
    })
  }
  return groups.toSorted((a, b) => a.projectName.localeCompare(b.projectName))
}

// -- §8: activity line, one ordered resolver, first true case wins ----------

export type ActivityMotion = 'static' | 'pulse' | 'spin'

export type ActivityGlyph =
  | 'pause'
  | 'shield-alert'
  | 'question'
  | 'circle-alert'
  | 'check'
  | 'refresh'
  | 'dot'
  | 'clock'
  | 'x'

export type ActivityLine = {
  /** Sheet §8's core rule: static waits on the human, pulse/spin means the
   * machine is the one working. Never inverted. */
  motion: ActivityMotion
  glyph: ActivityGlyph
  text: string
}

/**
 * The row's status line. Ranked, like sheet §8, but trimmed to what
 * TaskStatus plus the journal actually carry: no sub-agent counts, no goal
 * loop, no named workflow, fields the source has that we do not.
 *
 * 1. interrupted: stopped mid-turn, static (closest analogue of "waits for
 *    an approval": nothing restarts it but a human gesture).
 * 2. review_ko: a blocked review to read, static.
 * 3. waiting_for_you with an open question: static, the question itself as
 *    the text.
 * 4. waiting_for_you with no question (a merge-gate or fix-loop hold):
 *    static.
 * 5. review_ok: static, ready to ship.
 * 6. reviewing: SPIN, an automatic process reading the diff, the one state
 *    that already reads as a loader elsewhere (see ForgeListPanel's own
 *    footer refresh spin).
 * 7. running: PULSE, the agent is alive and producing output, the same
 *    live-dot convention as WorkQueue's wq-dot--pulse.
 * 8. queued: static, idle.
 * 9. shipped or failed (fallback): static, terminal.
 */
export function resolveActivityLine(
  state: Pick<TaskState, 'record' | 'events' | 'liveLoadCap'>,
): ActivityLine {
  const { record, events, liveLoadCap } = state
  if (record.status === 'interrupted') {
    return { motion: 'static', glyph: 'pause', text: t(statusPhraseKey(record, false)) }
  }
  if (record.status === 'review_ko') {
    return { motion: 'static', glyph: 'shield-alert', text: t(statusPhraseKey(record, false)) }
  }
  if (record.status === 'waiting_for_you') {
    const question = lastQuestion(events)
    if (question !== null) {
      return {
        motion: 'static',
        glyph: 'question',
        text: t('conversations.questionExcerpt', { q: question }),
      }
    }
    return { motion: 'static', glyph: 'circle-alert', text: t(statusPhraseKey(record, false)) }
  }
  if (record.status === 'review_ok') {
    return { motion: 'static', glyph: 'check', text: t(statusPhraseKey(record, false)) }
  }
  if (record.status === 'reviewing') {
    return { motion: 'spin', glyph: 'refresh', text: t(statusPhraseKey(record, false)) }
  }
  if (record.status === 'running') {
    return { motion: 'pulse', glyph: 'dot', text: t(statusPhraseKey(record, false)) }
  }
  if (record.status === 'queued') {
    return {
      motion: 'static',
      glyph: 'clock',
      text: t(statusPhraseKey(record, liveLoadCap?.waitingForSlot ?? false)),
    }
  }
  // Fallback: 'shipped' or 'failed', both terminal.
  return {
    motion: 'static',
    glyph: record.status === 'shipped' ? 'check' : 'x',
    text: t(statusPhraseKey(record, false)),
  }
}

// -- §7: reference pill precedence, checks status is our real CI analogue ---

export type ReferencePillTone = 'red' | 'amber' | 'green'
export type ReferencePillGlyph = 'x' | 'alert-triangle' | 'dot' | 'check'
export type ReferencePill = { tone: ReferencePillTone; glyph: ReferencePillGlyph; text: string }

/**
 * The checks pill's precedence, ported from sheet §7's table:
 *
 * rank 0, shipped: the task's own "merged" state, its integration story is
 *   over and evaluating checks here would be noise. Short-circuits
 *   everything else.
 * rank 1, checks failed (or could not run at all): outranks everything but
 *   nothing outranks it.
 * rank 2, a merge conflict: beats "running" and "passed", never beats
 *   "failed".
 * rank 3, checks running: STATIC, never a spin, sheet §7's own point being
 *   that the "in progress" disc does not turn; motion is reserved for the
 *   conversation's own activity line.
 * rank 4, checks passed.
 * else, nothing configured or no run yet: no pill.
 *
 * `checks?.status` (the live mirror, which CAN be 'running') takes priority
 * over `record.checks_status` (persisted, contractually never 'running') so
 * a run in flight is seen; falls back to the persisted status otherwise.
 */
export function resolveChecksPill(
  state: Pick<TaskState, 'record' | 'checks'>,
): ReferencePill | null {
  const { record, checks } = state
  if (record.status === 'shipped') {
    return null
  }
  const status = checks?.status ?? record.checks_status ?? null
  if (status === 'failed' || status === 'error') {
    return { tone: 'red', glyph: 'x', text: t('conversations.checksFailed') }
  }
  if (record.reason?.code === 'merge_conflict') {
    return { tone: 'red', glyph: 'alert-triangle', text: t('conversations.checksConflict') }
  }
  if (status === 'running') {
    return { tone: 'amber', glyph: 'dot', text: t('conversations.checksRunning') }
  }
  if (status === 'passed') {
    return { tone: 'green', glyph: 'check', text: t('conversations.checksPassed') }
  }
  return null
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
