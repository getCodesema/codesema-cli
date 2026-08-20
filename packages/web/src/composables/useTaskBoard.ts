// Pure state logic of the workspace: status sections (the rail groups),
// activity sort, duration formatting, event summaries. Components only
// compose these functions; none of this logic lives in a .vue file (testable
// with bun:test).

import { EXECUTION_STATUS } from '../execution-status'
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
  // T8. An interrupted conversation is not finished, it is STOPPED: nothing
  // re-enqueues it, only a human gesture (Resume, or a reply) starts a turn
  // again. That is the definition of this zone — the human is the bottleneck.
  interrupted: 'waiting',
  running: 'active',
  reviewing: 'active',
  queued: 'active',
  review_ok: 'done',
  shipped: 'done',
  failed: 'done',
}

export function sectionOf(status: TaskStatus): HomeSection {
  return SECTION_BY_STATUS[status]
}

// ── Work queue (T4 layout): four sections, in display order ────────────────

/** The four zones of the work queue: blocked on the human first, then the
 * machine at work, then ready to ship, then the folded done pile. */
export type QueueSection = 'attention' | 'active' | 'ready' | 'done'

const QUEUE_SECTION_BY_STATUS: Record<TaskStatus, QueueSection> = {
  // The human is the bottleneck: a question, a blocked review to read, or a
  // conversation stopped mid-turn that waits for a Resume (T8).
  waiting_for_you: 'attention',
  review_ko: 'attention',
  interrupted: 'attention',
  running: 'active',
  reviewing: 'active',
  queued: 'active',
  // Green ring: one click away from shipping.
  review_ok: 'ready',
  shipped: 'done',
  failed: 'done',
}

export function queueSectionOf(status: TaskStatus): QueueSection {
  return QUEUE_SECTION_BY_STATUS[status]
}

/**
 * The exact English `reason.detail` task-runner.ts attaches to a MACHINE-cap
 * wait (its private `MACHINE_LOAD_DETAIL` constant) — hand-mirrored here
 * (§ 0.4 convention: `packages/web/src/types.ts` already mirrors the contract
 * by hand) because it is the ONLY thing on a `TaskRecord` that tells the two
 * `resource_busy` motifs apart. `data.name` ('machine_busy'/'project_busy')
 * lives on the task's `queue` journal EVENT, not on the record itself, and
 * WorkQueue.vue's #N pill only ever has the record — never that task's
 * events (adversarial review round 3, MAJEUR 3: "à défaut reason.detail").
 *
 * The mirror is checked, not merely documented: WorkQueue.test.ts extracts
 * `MACHINE_LOAD_DETAIL` from the CLI source and renders the pill with it, so
 * a drift on either side turns that test red (round 5, mineur F).
 */
const MACHINE_LOAD_WAIT_DETAIL =
  'the machine-wide load cap (maxConcurrentAgents) has no free slot for a turn, a review or a checks run'

/**
 * Which promise the #N pill's tooltip may make. "N conversations ahead in this
 * project" is only true while the project HAS something running, and the
 * record says so itself: `resource_busy` is exactly the code the server writes
 * on a task waiting behind an active one. Any other reason — a conversation
 * whose worktree would not materialize, say — means the line is STOPPED, not
 * busy, and pointing at conversations ahead of it would send the human looking
 * for agents that are not there.
 *
 * T1.3 (D4) split `resource_busy` into two motifs, and this pill used to
 * conflate them (adversarial review round 3, MAJEUR 3): a task alone in an
 * otherwise idle project, held back by the MACHINE-wide cap, was told "N
 * conversations ahead in this project" — there are none, nothing runs there.
 * `reason.detail` is the discriminant (see `MACHINE_LOAD_WAIT_DETAIL` above).
 */
export function queueRankHintKey(
  record: Pick<TaskRecord, 'reason'>,
):
  | 'workspace.queuePositionHint'
  | 'workspace.queuePositionHintIdle'
  | 'workspace.queuePositionHintMachine' {
  if (record.reason?.code !== 'resource_busy') {
    return 'workspace.queuePositionHintIdle'
  }
  return record.reason.detail === MACHINE_LOAD_WAIT_DETAIL
    ? 'workspace.queuePositionHintMachine'
    : 'workspace.queuePositionHint'
}

/**
 * The conversation header's status phrase for a 'queued' task: the plain "in
 * line" phrase (EXECUTION_STATUS.queued.phraseKey), UNLESS the last task_meta
 * frame said this wait is for a MACHINE slot rather than this project's own
 * admission (T1.3, D4). Null for every other status — the caller falls back
 * to EXECUTION_STATUS as before. Adversarial review round 3, MAJEUR 4/AC-12:
 * `liveLoadCap`/`waitingForSlot` existed on the store and nothing derived a
 * label from them; this is that derivation, and the component using it is
 * what actually satisfies "the UI CAN derive the label".
 */
export function queuePhraseKey(
  status: TaskStatus,
  waitingForSlot: boolean,
): 'workspace.phaseQueuedMachine' | null {
  return status === 'queued' && waitingForSlot ? 'workspace.phaseQueuedMachine' : null
}

/**
 * Header phrase for a conversation. T3.1: `review_ko` with `checks_failed`
 * must not reuse "findings to fix" — that sentence is a lie when the review
 * was green and the checks were red. Same shape as `queuePhraseKey`: a
 * neighbour helper whose premise this ticket invalidated.
 */
export function statusPhraseKey(
  record: Pick<TaskRecord, 'status' | 'reason'>,
  waitingForSlot: boolean,
): MessageKey {
  const queued = queuePhraseKey(record.status, waitingForSlot)
  if (queued) {
    return queued
  }
  if (record.status === 'review_ko' && record.reason?.code === 'checks_failed') {
    return 'workspace.phaseChecksFailed'
  }
  return EXECUTION_STATUS[record.status].phraseKey
}

/** Queue-card flag: same split as `statusPhraseKey`, for the short label. */
export function statusLabelKey(record: Pick<TaskRecord, 'status' | 'reason'>): MessageKey {
  if (record.status === 'review_ko' && record.reason?.code === 'checks_failed') {
    return 'workspace.statusChecksFailed'
  }
  return EXECUTION_STATUS[record.status].labelKey
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

/**
 * Statuses where NOTHING moves until the human acts: an open question, and
 * (T8) a conversation stopped mid-turn, which no boot and no queue ever
 * restarts on its own. Both the bell badge and the bell's target read this,
 * so the count and the click can never disagree.
 */
const NEEDS_YOU_STATUSES: ReadonlySet<TaskStatus> = new Set(['waiting_for_you', 'interrupted'])

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
    if (NEEDS_YOU_STATUSES.has(state.record.status)) {
      needsYou++
    }
    if (HEADER_AGENT_STATUSES.has(state.record.status)) {
      agents++
    }
  }
  return { needsYou, agents }
}

/**
 * The conversation blocked on the human that has waited the LONGEST (oldest
 * updated_at, id as tie-break): the bell click opens it in focus.
 */
export function oldestWaiting<
  T extends { record: Pick<TaskRecord, 'status' | 'updated_at' | 'id'> },
>(states: readonly T[]): T | null {
  const waiting = states.filter((state) => NEEDS_YOU_STATUSES.has(state.record.status))
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
 * What a stopped conversation offers (T8):
 * 'ready'  — the turn it died on can be restarted as it stands: POST …/resume
 *            re-runs that very instruction (resumed provider session when the
 *            record kept one, transcript replay otherwise). The [Resume]
 *            button.
 * 'reply'  — it IS interrupted, but its last turn already answered (the human
 *            stopped it from 'waiting_for_you'): there is nothing to redo, and
 *            a Resume would silently repeat a finished turn. The UI says so
 *            and points at the composer — never a button that would fail.
 * 'none'   — not an interrupted conversation: no offer at all.
 *
 * Mirrors pendingResumeTurn() on the server, which owns the real gate: this
 * decides what to OFFER, the server decides what to run.
 */
export type ResumeState = 'ready' | 'reply' | 'none'

export function resumeStateOf(record: Pick<TaskRecord, 'status' | 'turns'>): ResumeState {
  if (record.status !== 'interrupted') {
    return 'none'
  }
  const turn = record.turns.at(-1)
  return turn && turn.response === null ? 'ready' : 'reply'
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
  cost: 'workspace.evCost',
  branch: 'workspace.evBranch',
  resource: 'workspace.evResource',
  queue: 'workspace.evQueue',
  issue: 'workspace.evIssue',
  prep: 'workspace.evPrep',
  criteria: 'workspace.evCriteria',
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
  // Neutral on purpose: a cost that could not be established is a gap in the
  // accounting, not a failure of the work.
  cost: 'idle',
  // Neutral on purpose (T1.6, DP14): none of the three branch facts this
  // carries stops anything — a declined rename, a preserved branch, a
  // fallen-back-to anchor are none of them a failure of the work.
  branch: 'idle',
  // Neutral even on a release FAILURE (DP9): a leaked volume the boot sweep
  // will rattrap is not the cry-wolf red 'error' would paint on a task that
  // otherwise shipped or was abandoned cleanly.
  resource: 'idle',
  // Neutral: an ordinary wait for a resource is not a degradation (DP8(b)/DP9).
  queue: 'idle',
  // Static fallback only: 'edited'/'not_ticket' (waiting on a human) and
  // 'cosmetic'/'bound' (routine) read very differently — see the per-name
  // tone lookup below, consulted first.
  issue: 'idle',
  prep: 'idle',
  // Neutral: an unreadable draft does not fail the task, and a validation is
  // a settled fact, not a cry-wolf red.
  criteria: 'idle',
}

/**
 * `data.name` is what actually distinguishes an 'issue' event's tone (DP9):
 * `edited`/`not_ticket`/`snapshot_unreadable`/`unreachable` leave this task's
 * ticket unresolved, `bound`/`coverage_gap`/`cosmetic` are settled facts.
 * NONE of them is ever red. Falls back to `EVENT_TONE.issue` for a name this build does
 * not know (a newer server), which is deliberately the ROUTINE tone —
 * defaulting an unknown cause to "check" would paint every future addition
 * red or amber before anyone decided it should be.
 */
const ISSUE_EVENT_TONE: Record<string, EventTone> = {
  edited: 'check',
  not_ticket: 'check',
  // A ticket whose frozen snapshot cannot be read back is silently out of
  // edit detection until a human re-binds it: amber, like the two above, for
  // the same reason — it is waiting on a person, not on the machine.
  snapshot_unreadable: 'check',
  // A forge this session could not read: AMBER, never red (DP9 — the task
  // carries on unmodified on its frozen snapshot, nothing is refused) and
  // never neutral either. It sits with the three above on the axis that
  // actually separates this table: the comparison did NOT conclude, so this
  // task's ticket is of unknown freshness — and, unlike every 'idle' name
  // here, this line comes with a D2 `reason_code` posed on the record.
  unreachable: 'check',
  bound: 'idle',
  coverage_gap: 'idle',
  cosmetic: 'idle',
}

/**
 * `event.type` decides the tone for every domain but 'issue' (DP9), whose
 * `data.name` carries the actual cause — `edited`/`not_ticket` are amber
 * (waiting on a human), the rest are neutral. Takes the whole event rather
 * than the bare type for exactly this one case.
 */
export function eventTone(event: Pick<TaskEvent, 'type' | 'data'>): EventTone {
  if (event.type === 'issue') {
    const name = typeof event.data.name === 'string' ? event.data.name : ''
    return ISSUE_EVENT_TONE[name] ?? EVENT_TONE.issue
  }
  return EVENT_TONE[event.type]
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
  cost: ['message', 'summary'],
  branch: ['text'],
  // Unreachable, and NOT what protects this type. `eventSummary` branches on
  // `event.type === 'resource'` BEFORE it ever indexes this table, so the
  // whole entry — empty or not — is dead weight; it is here because the
  // Record<TaskEventType, …> type demands one key per event type. The actual
  // protection is that branch, and it lives in `eventSummary`: what must never
  // happen is a `resource` line rendering `data.message`, the SERVER's own
  // English sentence, verbatim in a French UI (§6 quater's "message technique
  // anglais servi tel quel" trap). Restoring keys here would change nothing;
  // removing that branch would break it. See RESOURCE_NAME_LABEL_KEY below.
  resource: [],
  // Rendered from `data.name` (queueEventText below), never from the raw
  // `data.message` the server writes: that field is an ENGLISH sentence
  // (adversarial review round 3, MAJEUR 4) and, being always present, made
  // the `?? label` fallback below structurally unreachable — the translated
  // 'workspace.evQueue' label was dead code no journal line ever showed.
  queue: [],
  // Rendered from `data.name` (issueEventText below), never from the raw
  // `data.message` the server writes: that field is an ENGLISH sentence built
  // in task-issue.ts and, being posed by ALL of the six 'issue' constructors,
  // it made the `?? label` fallback at the end of `eventSummary`
  // structurally unreachable — the translated 'workspace.evIssue' label was
  // dead code no journal line ever showed, and a French workspace read six
  // English sentences (round-4 adversarial review, majeur 1; same defect
  // T1.3 closed for 'queue').
  issue: [],
  prep: [],
  // Rendered from `data.name` (criteriaEventText below), never from the raw
  // `data.message` the server writes: that field is an ENGLISH sentence, and
  // being always present would make the `?? label` fallback structurally
  // unreachable — the translated 'workspace.evCriteria' label would be dead
  // code no journal line ever showed (§6 quater).
  criteria: [],
}

/**
 * Per-`data.name` voice of a `resource` event (DP9's closed discriminant;
 * T1.9 emits exactly these three). An unrecognized name — a future DP9
 * addition this build predates — falls back to the localized type label
 * ("Resource"/"Ressource"), NEVER to the raw `data.message`: the whole point
 * is that the English server sentence must never reach the French journal.
 */
const RESOURCE_NAME_LABEL_KEY: Record<string, MessageKey> = {
  home_volume_released: 'workspace.evResourceHomeReleased',
  home_volume_not_released: 'workspace.evResourceHomeNotReleased',
  container_runtime_absent: 'workspace.evResourceNoRuntime',
}

/** `eventSummary`'s branch for `resource` events — see RESOURCE_NAME_LABEL_KEY. */
function resourceSummary(data: TaskEventData, label: string): string {
  const name = firstString(data, ['name'])
  const key = name ? RESOURCE_NAME_LABEL_KEY[name] : undefined
  return key ? t(key) : label
}

/**
 * `data.name` of a 'queue' event → its own translated detail, distinct from
 * the generic 'En attente' label (DP9's grammar: the type names the domain,
 * `data.name` names the incident). An unrecognized name (an older bundle
 * reading a future producer's event, whitelist-and-truncate) degrades to the
 * plain label rather than showing nothing or a raw token.
 */
const QUEUE_NAME_KEY: Record<string, MessageKey> = {
  machine_busy: 'workspace.evQueueMachine',
  project_busy: 'workspace.evQueueProject',
}

const PREP_NAME_KEY: Record<string, MessageKey> = {
  install_started: 'workspace.evPrepStarted',
  install_skipped: 'workspace.evPrepSkipped',
  install_passed: 'workspace.evPrepPassed',
  install_failed: 'workspace.evPrepFailed',
}

function prepEventText(data: TaskEventData): string {
  const name = firstString(data, ['name'])
  const key = name ? PREP_NAME_KEY[name] : undefined
  const label = key ? t(key) : t(EVENT_LABEL_KEY.prep)
  if (name === 'install_failed') {
    const detail = firstString(data, ['detail'])
    return detail ? `${label} · ${clip(detail)}` : label
  }
  const command = firstString(data, ['command'])
  return command ? `${label} · ${command}` : label
}

function queueEventText(data: TaskEventData): string {
  const name = firstString(data, ['name'])
  const key = name ? QUEUE_NAME_KEY[name] : undefined
  return key ? t(key) : t(EVENT_LABEL_KEY.queue)
}

/**
 * `data.name` of an 'issue' event → its own translated key (DP9's grammar:
 * the type names the domain, `data.name` names the incident). An
 * unrecognized name — an older bundle reading a newer server's event —
 * degrades to the plain 'Ticket' label rather than showing a raw token.
 */
const ISSUE_NAME_KEY: Record<string, MessageKey> = {
  bound: 'workspace.evIssueBound',
  coverage_gap: 'workspace.evIssueCoverageGap',
  cosmetic: 'workspace.evIssueCosmetic',
  not_ticket: 'workspace.evIssueNotTicket',
  snapshot_unreadable: 'workspace.evIssueSnapshotUnreadable',
  unreachable: 'workspace.evIssueUnreachable',
}

const ISSUE_SECTION_KEY: Record<string, MessageKey> = {
  context: 'workspace.evIssueSectionContext',
  goal: 'workspace.evIssueSectionGoal',
  scope: 'workspace.evIssueSectionScope',
  out_of_scope: 'workspace.evIssueSectionOutOfScope',
}

/** A comma-joined `data` list rendered as translated items, or "none". */
function issueList(data: TaskEventData, key: string, labels?: Record<string, MessageKey>): string {
  const raw = typeof data[key] === 'string' ? data[key] : ''
  const items = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  if (items.length === 0) {
    return t('workspace.evIssueNone')
  }
  // An id (or a section name) this bundle does not know is shown verbatim:
  // a criterion id IS its own label, and an unknown section is better named
  // by its wire token than dropped.
  return items.map((item) => (labels?.[item] ? t(labels[item]) : item)).join(', ')
}

/**
 * The journal line of an 'issue' event, from its `data.name` and — for
 * 'edited' — from the machine-readable diff DP13 requires it to carry: WHICH
 * sections moved and WHICH acceptance criteria appeared or disappeared, by
 * stable id. `sections_unknown` is the snapshot that has no per-section
 * breakdown at all: it must never render as "none moved", which is the
 * opposite of what the body hash just proved.
 */
function issueEventText(data: TaskEventData): string {
  const name = firstString(data, ['name'])
  if (name === 'edited') {
    return t('workspace.evIssueEdited', {
      sections:
        data.sections_unknown === true
          ? t('workspace.evIssueSectionsUnknown')
          : issueList(data, 'sections', ISSUE_SECTION_KEY),
      added: issueList(data, 'criteria_added'),
      removed: issueList(data, 'criteria_removed'),
    })
  }
  const key = name ? ISSUE_NAME_KEY[name] : undefined
  return key ? t(key) : t(EVENT_LABEL_KEY.issue)
}

/**
 * `data.name` of a 'criteria' event → its own translated key (DP9: the type
 * names the domain, `data.name` names the incident). An unrecognized name
 * degrades to the plain 'Criteria' label rather than showing a raw token or
 * the server's English `data.message`.
 */
const CRITERIA_NAME_KEY: Record<string, MessageKey> = {
  draft_unparsed: 'workspace.evCriteriaDraftUnparsed',
  validated: 'workspace.evCriteriaValidated',
}

function criteriaEventText(data: TaskEventData): string {
  const name = firstString(data, ['name'])
  const key = name ? CRITERIA_NAME_KEY[name] : undefined
  return key ? t(key) : t(EVENT_LABEL_KEY.criteria)
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
  if (event.type === 'resource') {
    return clip(resourceSummary(event.data, label))
  }
  if (event.type === 'queue') {
    return clip(queueEventText(event.data))
  }
  if (event.type === 'issue') {
    return clip(issueEventText(event.data))
  }
  if (event.type === 'prep') {
    return clip(prepEventText(event.data))
  }
  if (event.type === 'criteria') {
    return clip(criteriaEventText(event.data))
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
