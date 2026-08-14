// Pure state logic of the workspace board: home sections, activity sort,
// duration formatting, event summaries. Components only compose these
// functions; none of this logic lives in a .vue file (testable with bun:test).

import { t, type MessageKey } from '../i18n'
import type { TaskEvent, TaskEventData, TaskEventType, TaskRecord, TaskStatus } from '../types'

/** The three home zones, in display order. No kanban: a sorted list is enough. */
export type HomeSection = 'waiting' | 'active' | 'done'

const SECTION_BY_STATUS: Record<TaskStatus, HomeSection> = {
  waiting_for_you: 'waiting',
  // A blocked review is something to READ, not a terminal state: it belongs
  // with the questions, where the human is the bottleneck.
  review_ko: 'waiting',
  running: 'active',
  reviewing: 'active',
  queued: 'active',
  review_ok: 'done',
  shipped: 'done',
  failed: 'done',
  interrupted: 'done',
}

export function sectionOf(status: TaskStatus): HomeSection {
  return SECTION_BY_STATUS[status]
}

/** Most recently touched first; id breaks ties so the order is stable. */
export function compareByActivity(
  a: Pick<TaskRecord, 'updated_at' | 'id'>,
  b: Pick<TaskRecord, 'updated_at' | 'id'>,
): number {
  const delta = Date.parse(b.updated_at) - Date.parse(a.updated_at)
  if (delta !== 0 && !Number.isNaN(delta)) {
    return delta
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function groupBySection(records: TaskRecord[]): Record<HomeSection, TaskRecord[]> {
  const grouped: Record<HomeSection, TaskRecord[]> = { waiting: [], active: [], done: [] }
  for (const record of records.toSorted(compareByActivity)) {
    grouped[sectionOf(record.status)].push(record)
  }
  return grouped
}

/** Compact "45s" / "5min" / "1h 12min"; work and wait are NEVER summed. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  if (totalSeconds < 60) {
    return t('workspace.durSeconds', { n: totalSeconds })
  }
  const totalMinutes = Math.round(totalSeconds / 60)
  if (totalMinutes < 60) {
    return t('workspace.durMinutes', { n: totalMinutes })
  }
  const hours = Math.floor(totalMinutes / 60)
  return t('workspace.durHours', { h: hours, m: totalMinutes % 60 })
}

/** "14:07" wall-clock stamp for journal lines; empty on an unparsable date. */
export function clockTime(iso: string): string {
  const time = new Date(iso)
  if (Number.isNaN(time.getTime())) {
    return ''
  }
  const hh = String(time.getHours()).padStart(2, '0')
  const mm = String(time.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

/** The composer has ONE textarea; the title is the first line of the prompt. */
export function titleFromPrompt(prompt: string): string {
  const firstLine = prompt
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  return (firstLine ?? '').replace(/\s+/g, ' ').slice(0, 80)
}

export const EVENT_LABEL_KEY: Record<TaskEventType, MessageKey> = {
  turn_started: 'workspace.evTurnStarted',
  tool_use: 'workspace.evToolUse',
  tool_result: 'workspace.evToolResult',
  message: 'workspace.evMessage',
  question: 'workspace.evQuestion',
  commit: 'workspace.evCommit',
  review_started: 'workspace.evReviewStarted',
  review_done: 'workspace.evReviewDone',
  shipped: 'workspace.evShipped',
  error: 'workspace.evError',
  interrupted: 'workspace.evInterrupted',
}

/** Semaphore tone of a journal line; review_done resolves from its verdict. */
export type EventTone = 'go' | 'check' | 'stop' | 'idle'

const EVENT_TONE: Record<TaskEventType, EventTone> = {
  turn_started: 'check',
  tool_use: 'idle',
  tool_result: 'idle',
  message: 'idle',
  question: 'check',
  commit: 'go',
  review_started: 'check',
  review_done: 'check',
  shipped: 'go',
  error: 'stop',
  interrupted: 'idle',
}

export function eventTone(type: TaskEventType): EventTone {
  return EVENT_TONE[type]
}

/** First non-empty string among the given data keys, or null. */
export function firstString(data: TaskEventData, keys: string[]): string | null {
  for (const key of keys) {
    const value = data[key]
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }
  return null
}

const SUMMARY_MAX = 140

const clip = (text: string): string =>
  text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1)}…` : text

/** Data keys probed per event type, in preference order: the payload keys are
 * summaries by contract but their exact names vary by event producer. */
const SUMMARY_KEYS: Record<TaskEventType, string[]> = {
  turn_started: ['message', 'summary'],
  tool_use: ['summary', 'input', 'detail', 'path', 'file'],
  tool_result: ['summary', 'result', 'detail', 'output'],
  message: ['text', 'preview', 'summary', 'message'],
  question: ['question', 'text', 'summary'],
  commit: ['message', 'subject', 'summary'],
  review_started: ['message', 'summary'],
  review_done: [],
  shipped: ['url', 'branch'],
  error: ['message', 'error', 'summary'],
  interrupted: ['message', 'summary'],
}

/** One dense line per journal event; falls back to the localized type label. */
export function eventSummary(event: TaskEvent): string {
  const label = t(EVENT_LABEL_KEY[event.type])
  if (event.type === 'tool_use') {
    const name = firstString(event.data, ['tool', 'name'])
    const detail = firstString(event.data, SUMMARY_KEYS.tool_use)
    if (name && detail) {
      return clip(`${name} · ${detail}`)
    }
    return clip(name ?? detail ?? label)
  }
  if (event.type === 'review_done') {
    const verdict = firstString(event.data, ['verdict'])
    return clip(verdict ? `${label} · ${verdict}` : label)
  }
  return clip(firstString(event.data, SUMMARY_KEYS[event.type]) ?? label)
}

/**
 * Last line of activity for a home card: the streamed text wins while the
 * agent writes, otherwise the latest journal event.
 */
export function lastActivity(events: TaskEvent[], liveText: string): string | null {
  const lastLine = liveText
    .split('\n')
    .map((line) => line.trim())
    .findLast((line) => line.length > 0)
  if (lastLine) {
    return clip(lastLine)
  }
  const last = events.at(-1)
  return last ? eventSummary(last) : null
}

/** Maps a review verdict from event data to the shared verdict labels. */
export function verdictLabelKey(verdict: unknown): MessageKey | null {
  if (verdict === 'approve' || verdict === 'request_changes' || verdict === 'comment') {
    return `verdict.${verdict}`
  }
  return null
}

/** Findings count carried by a review_done event, if the runner included one. */
export function findingsCount(data: TaskEventData): number | null {
  for (const key of ['findings', 'findings_count', 'count']) {
    const value = data[key]
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
      return value
    }
  }
  return null
}

/**
 * Inserts one journal event, deduplicating by seq (SSE and hydration can
 * deliver the same line twice) and keeping the array sorted. The common case
 * — a live append — stays O(1).
 */
export function mergeEvent(events: TaskEvent[], event: TaskEvent): void {
  const last = events[events.length - 1]
  if (!last || event.seq > last.seq) {
    events.push(event)
    return
  }
  const at = events.findIndex((existing) => existing.seq >= event.seq)
  if (events[at]?.seq === event.seq) {
    events[at] = event
    return
  }
  events.splice(at, 0, event)
}
