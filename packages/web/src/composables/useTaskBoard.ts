// Pure state logic of the workspace: status sections (the rail groups),
// activity sort, duration formatting, event summaries. Components only
// compose these functions; none of this logic lives in a .vue file (testable
// with bun:test).

import { t, type MessageKey } from '../i18n'
import type { TaskEvent, TaskEventData, TaskEventType, TaskRecord, TaskStatus } from '../types'
import type { FindingSeverity } from './useDiff'

/** The three status zones of the rail, in display order. */
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

// ── Work queue (T4 layout): four sections, in display order ────────────────

/** The four zones of the work queue: blocked on the human first, then the
 * machine at work, then ready to ship, then the folded done pile. */
export type QueueSection = 'attention' | 'active' | 'ready' | 'done'

const QUEUE_SECTION_BY_STATUS: Record<TaskStatus, QueueSection> = {
  // The human is the bottleneck: a question, or a blocked review to read.
  waiting_for_you: 'attention',
  review_ko: 'attention',
  running: 'active',
  reviewing: 'active',
  queued: 'active',
  // Green ring: one click away from shipping.
  review_ok: 'ready',
  shipped: 'done',
  failed: 'done',
  interrupted: 'done',
}

export function queueSectionOf(status: TaskStatus): QueueSection {
  return QUEUE_SECTION_BY_STATUS[status]
}

export type QueueGroups<T> = Record<QueueSection, T[]>

/** Groups conversations into the queue's four sections, most recently touched
 * first within each section. */
export function groupQueue<T extends { record: Pick<TaskRecord, 'status' | 'updated_at' | 'id'> }>(
  states: readonly T[],
): QueueGroups<T> {
  const groups: QueueGroups<T> = { attention: [], active: [], ready: [], done: [] }
  for (const state of states.toSorted((a, b) => compareByActivity(a.record, b.record))) {
    groups[queueSectionOf(state.record.status)].push(state)
  }
  return groups
}

/** The text of the LAST question event, for the attention card excerpt. */
export function lastQuestion(events: readonly TaskEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event !== undefined && event.type === 'question') {
      return firstString(event.data, SUMMARY_KEYS.question)
    }
  }
  return null
}

/**
 * When the conversation last became blocked on the human, as an epoch (ms):
 * the LAST question event's timestamp, else the record's own update time.
 * Null when neither parses — the card then simply omits "paused for X".
 */
export function waitingSince(events: readonly TaskEvent[], updatedAt: string): number | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event !== undefined && event.type === 'question') {
      const at = Date.parse(event.at)
      if (!Number.isNaN(at)) {
        return at
      }
      break
    }
  }
  const fallback = Date.parse(updatedAt)
  return Number.isNaN(fallback) ? null : fallback
}

/** Header search over the queue: case-insensitive match on title or branch;
 * a blank query matches everything. */
export function matchesQuery(record: Pick<TaskRecord, 'title' | 'branch'>, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === '') {
    return true
  }
  return record.title.toLowerCase().includes(needle) || record.branch.toLowerCase().includes(needle)
}

// ── Global header signals ──────────────────────────────────────────────────

/** Statuses counted as "agents at work" by the header counter. */
const HEADER_AGENT_STATUSES: ReadonlySet<TaskStatus> = new Set(['running', 'reviewing'])

export type AgentCounts = {
  /** Conversations blocked on the human (the amber bell badge). */
  needsYou: number
  /** Agents currently working: running + reviewing (the ● N counter). */
  agents: number
}

export function agentCounts(
  states: readonly { record: Pick<TaskRecord, 'status'> }[],
): AgentCounts {
  let needsYou = 0
  let agents = 0
  for (const state of states) {
    if (state.record.status === 'waiting_for_you') {
      needsYou++
    }
    if (HEADER_AGENT_STATUSES.has(state.record.status)) {
      agents++
    }
  }
  return { needsYou, agents }
}

/**
 * The waiting_for_you conversation that has waited the LONGEST (oldest
 * updated_at, id as tie-break): the bell click opens it in focus.
 */
export function oldestWaiting<
  T extends { record: Pick<TaskRecord, 'status' | 'updated_at' | 'id'> },
>(states: readonly T[]): T | null {
  const waiting = states.filter((state) => state.record.status === 'waiting_for_you')
  return waiting.toSorted((a, b) => compareByActivity(b.record, a.record))[0] ?? null
}

/**
 * What the always-visible reply composer does with a send, per status.
 * 'now'   — the server accepts a reply right away (its replyable gate).
 * 'queue' — the agent holds the turn; the message is parked client-side and
 *           auto-delivered the moment the status flips to a 'now' state, so
 *           the human can prepare the next instruction during a run.
 * 'dead'  — nothing will ever unlock (shipped/failed): composer disabled.
 */
export type ReplyMode = 'now' | 'queue' | 'dead'

const REPLY_MODE_BY_STATUS: Record<TaskStatus, ReplyMode> = {
  waiting_for_you: 'now',
  interrupted: 'now',
  review_ok: 'now',
  review_ko: 'now',
  queued: 'queue',
  running: 'queue',
  reviewing: 'queue',
  shipped: 'dead',
  failed: 'dead',
}

export function replyModeOf(status: TaskStatus): ReplyMode {
  return REPLY_MODE_BY_STATUS[status]
}

/**
 * Statuses whose turn is STILL streaming text on the task_text channel: the
 * agent's own turn ('running') and the automatic end-of-turn review
 * ('reviewing'), whose progress lines ride the very same channel. Anything
 * else settles the turn in the journal, so the volatile copy is dropped.
 */
export function streamsLiveText(status: TaskStatus): boolean {
  return status === 'running' || status === 'reviewing'
}

/**
 * One message the agent streamed during the turn in flight: `seq` is its
 * index in the turn (the provider's own message boundaries), `text` its
 * body so far. Volatile — nothing of this is persisted server-side.
 */
export type LiveMessage = { seq: number; text: string }

/**
 * Live bubbles belong to the AGENT's turn and to it alone: on any other
 * status the turn has settled in the journal (which then renders its
 * response), and the review streams a status line, not a conversation.
 */
export function keepsLiveMessages(status: TaskStatus): boolean {
  return status === 'running'
}

/**
 * Journal events that HAND OVER the turn's live bubbles: the reply (message)
 * or the question the agent ended on is now a journal line rendering the full
 * turn response, and a new turn starts from a blank slate. Dropping the
 * bubbles right there is what keeps the hand-over free of a visual double,
 * without waiting for the status frame that follows.
 */
export function settlesLiveMessages(type: TaskEventType): boolean {
  return type === 'turn_started' || type === 'message' || type === 'question'
}

/**
 * Inserts one streamed message, keyed by seq: the same seq REWRITES the
 * bubble in flight (the text is cumulative within a message), a new one is
 * appended. Blank text never opens a bubble — an assistant message made of
 * tool calls alone says nothing. Same shape as mergeEvent: the common case
 * (append at the tail) stays O(1), and a mid-turn reconnect that starts at
 * seq 4 shows one bubble, not four phantoms.
 */
export function mergeLiveMessage(messages: LiveMessage[], message: LiveMessage): void {
  if (message.text.trim().length === 0) {
    return
  }
  const last = messages[messages.length - 1]
  if (!last || message.seq > last.seq) {
    messages.push(message)
    return
  }
  const at = messages.findIndex((existing) => existing.seq >= message.seq)
  if (messages[at]?.seq === message.seq) {
    messages[at] = message
    return
  }
  messages.splice(at, 0, message)
}

/** The two things a task_text frame can carry — see TaskEnvelope. */
export type LiveTextTarget = { liveText: string; liveMessages: LiveMessage[] }

/**
 * Applies one task_text frame. A frame with a message index is a piece of the
 * agent's conversation and accumulates; a frame without one is a progress
 * line (the automatic review) and replaces the previous line.
 */
export function applyLiveText(target: LiveTextTarget, data: { text: string; seq?: number }): void {
  if (typeof data.seq === 'number') {
    mergeLiveMessage(target.liveMessages, { seq: data.seq, text: data.text })
    return
  }
  target.liveText = data.text
}

/**
 * Thread folding: runs of tool_use/tool_result collapse into ONE block per
 * turn (the raw feed is detail, not conversation — it hides behind a
 * disclosure that shows "agent working" live, then a compact summary). Every
 * other event stays a standalone block. turnIndex ties a tools block to
 * record.turns for its token count.
 */
export type ThreadBlock =
  { kind: 'single'; event: TaskEvent } | { kind: 'tools'; events: TaskEvent[]; turnIndex: number }

const TOOL_EVENT_TYPES: ReadonlySet<TaskEventType> = new Set(['tool_use', 'tool_result'])

export function groupThreadEvents(events: TaskEvent[]): ThreadBlock[] {
  const blocks: ThreadBlock[] = []
  let turnIndex = -1
  for (const event of events) {
    if (event.type === 'turn_started') {
      turnIndex++
    }
    if (TOOL_EVENT_TYPES.has(event.type)) {
      const last = blocks.at(-1)
      if (last?.kind === 'tools' && last.turnIndex === turnIndex) {
        last.events.push(event)
      } else {
        blocks.push({ kind: 'tools', events: [event], turnIndex: Math.max(turnIndex, 0) })
      }
    } else {
      blocks.push({ kind: 'single', event })
    }
  }
  return blocks
}

// ── Focus zone tabs (F2): Conversation / Diff / Checks ─────────────────────

export type FocusTab = 'conversation' | 'diff' | 'checks'

export type FocusTabState = { id: FocusTab; enabled: boolean }

/**
 * Tab availability of one conversation: Diff needs a branch to diff against
 * (a queued task has none yet); Checks is always openable — its body explains
 * itself (unconfigured hint, "no run yet") instead of a disabled tab.
 */
export function focusTabs(hasBranch: boolean): FocusTabState[] {
  return [
    { id: 'conversation', enabled: true },
    { id: 'diff', enabled: hasBranch },
    { id: 'checks', enabled: true },
  ]
}

/** "il y a 4 min" — relative stamp for thread meta lines; null when the date
 * does not parse (the line then simply omits it). */
export function timeAgo(iso: string, now: number): string | null {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) {
    return null
  }
  return t('workspace.agoTime', { t: formatDuration(Math.max(0, now - at)) })
}

/** Inline-code segments of a message: `code` spans become mono. Pure text
 * split, no markup interpretation beyond backtick pairs. */
export type TextSegment = { code: boolean; text: string }

export function splitInlineCode(text: string): TextSegment[] {
  const segments: TextSegment[] = []
  const parts = text.split(/`([^`\n]+)`/)
  for (const [i, part] of parts.entries()) {
    if (part !== '') {
      segments.push({ code: i % 2 === 1, text: part })
    }
  }
  return segments.length > 0 ? segments : [{ code: false, text }]
}

/** Compact token count for the live meter: 843, 12.4k, 1.2M. */
export function formatTokens(n: number): string {
  if (n < 1000) {
    return String(n)
  }
  if (n < 1_000_000) {
    return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  }
  return `${(n / 1_000_000).toFixed(1)}M`
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
  checks: 'workspace.evChecks',
  shipped: 'workspace.evShipped',
  error: 'workspace.evError',
  interrupted: 'workspace.evInterrupted',
  isolation: 'workspace.evIsolation',
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
  // Static fallback only: the checks line resolves go/stop from its status
  // (see checksEventLine in useChecks).
  checks: 'idle',
  shipped: 'go',
  error: 'stop',
  interrupted: 'idle',
  isolation: 'idle',
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
  // Rendered by its own component (TaskEventChecks): no probed key.
  checks: [],
  shipped: ['url', 'branch'],
  error: ['message', 'error', 'summary'],
  interrupted: ['message', 'summary'],
  isolation: ['reason', 'isolation'],
}

/**
 * What a review_started line says beyond its label: which turn is under
 * review, and which flow reviews it. Empty when the payload carries neither
 * (older journals), so the line degrades to the plain label.
 */
function reviewStartedDetails(data: TaskEventData): string[] {
  const details: string[] = []
  const turn = data.turn
  if (typeof turn === 'number' && Number.isInteger(turn) && turn > 0) {
    details.push(t('workspace.reviewTurn', { n: turn }))
  }
  const mode = firstString(data, ['mode'])
  if (mode) {
    details.push(mode)
  }
  return details
}

/**
 * Facts appended after the label, " · "-joined: the review lines are the only
 * ones that carry any (everything else reads its summary key instead).
 */
function summaryDetails(event: TaskEvent): string[] {
  if (event.type === 'review_started') {
    return reviewStartedDetails(event.data)
  }
  if (event.type === 'review_done') {
    const verdict = firstString(event.data, ['verdict'])
    return verdict ? [verdict] : []
  }
  return []
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
  const details = summaryDetails(event)
  if (details.length > 0) {
    return clip([label, ...details].join(' · '))
  }
  return clip(firstString(event.data, SUMMARY_KEYS[event.type]) ?? label)
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

/** Severities in display order: worst first, so the card reads top-down. */
const SEVERITY_ORDER: readonly FindingSeverity[] = ['critical', 'major', 'minor', 'info']

export type SeverityCount = { severity: FindingSeverity; n: number }

/**
 * Severity spread carried by a review_done event ('severity_major': 2). The
 * runner omits empty severities, so an absent key means zero — and an event
 * written before the spread existed simply yields an empty list.
 */
export function severityBreakdown(data: TaskEventData): SeverityCount[] {
  const counts: SeverityCount[] = []
  for (const severity of SEVERITY_ORDER) {
    const value = data[`severity_${severity}`]
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
      counts.push({ severity, n: value })
    }
  }
  return counts
}

/** Archive path of the review a review_done event points at, when it carries one. */
export function reviewRefOf(data: TaskEventData): string | null {
  return firstString(data, ['ref'])
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
