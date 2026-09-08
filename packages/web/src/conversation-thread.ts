// Pure shaping of the conversation thread: what the journal's events become
// once the reader sees them — folded runs, one checks verdict per turn, the
// stamps that are worth printing — plus the one destructive offer the thread
// carries at its tail. No Vue, no DOM.

import { formatDuration, groupThreadEvents } from './composables/useTaskBoard'
import type { MessageKey } from './i18n'
import type { TaskEvent, TaskEventType, TaskRecord, TaskStatus } from './types'

export type ThreadItem =
  | { kind: 'single'; event: TaskEvent; prompt: string | null; showTime: boolean }
  | { kind: 'tools'; key: number; events: TaskEvent[]; turnIndex: number }
  | { kind: 'setup'; key: number; events: TaskEvent[]; duration: string }

/** Runner notices — sandbox, install, worktree, slot — as opposed to what the
 * agent itself said or did. They fold away until the reader asks for them. */
const SETUP_EVENT_TYPES: ReadonlySet<TaskEventType> = new Set([
  'isolation',
  'prep',
  'resource',
  'queue',
  'branch',
])

const NARRATIVE_EVENT_TYPES: ReadonlySet<TaskEventType> = new Set(['message', 'question'])

/** Seq of every 'checks' event superseded by a later one in the same turn: the
 * thread keeps one verdict per turn, the Checks tab keeps the detail. */
function supersededChecks(events: TaskEvent[]): Set<number> {
  const latestOfTurn = new Map<number, number>()
  let turnIndex = -1
  for (const event of events) {
    if (event.type === 'turn_started') {
      turnIndex++
    }
    if (event.type === 'checks') {
      latestOfTurn.set(turnIndex, event.seq)
    }
  }
  const kept = new Set(latestOfTurn.values())
  return new Set(
    events.filter((event) => event.type === 'checks' && !kept.has(event.seq)).map((e) => e.seq),
  )
}

const minuteOf = (iso: string): number => Math.floor(Date.parse(iso) / 60_000)

/** A stamp is printed only when the minute moved: a burst of events in the
 * same minute reads as one moment, not as a column of identical clocks. */
function stampVisibleItems(items: ThreadItem[]): ThreadItem[] {
  let lastMinute = Number.NaN
  return items.map((item) => {
    const last = item.kind === 'single' ? item.event : item.events.at(-1)
    const minute = last ? minuteOf(last.at) : Number.NaN
    const stamped =
      item.kind === 'single'
        ? { ...item, showTime: !Number.isNaN(minute) && minute !== lastMinute }
        : item
    if (!Number.isNaN(minute)) {
      lastMinute = minute
    }
    return stamped
  })
}

/** Prompt of the turn each turn_started event opens: the i-th such event
 * carries record.turns[i], and the thread renders it as the user's message. */
function promptBySeqOf(record: TaskRecord, events: TaskEvent[]): Map<number, string> {
  const prompts = new Map<number, string>()
  let turn = 0
  for (const event of events) {
    if (event.type !== 'turn_started') {
      continue
    }
    const prompt = record.turns[turn]?.prompt
    turn++
    if (prompt !== undefined && prompt !== null) {
      prompts.set(event.seq, prompt)
    }
  }
  return prompts
}

/** One fold, or the plain lines back: a run of one setup notice is not worth
 * a disclosure of its own. */
function foldedSetup(run: TaskEvent[]): ThreadItem[] {
  const first = run[0]
  const last = run.at(-1)
  if (run.length < 2 || !first || !last) {
    return run.map((event) => ({ kind: 'single', event, prompt: null, showTime: false }))
  }
  const ms = Math.max(0, Date.parse(last.at) - Date.parse(first.at))
  return [{ kind: 'setup', key: first.seq, events: run, duration: formatDuration(ms) }]
}

export function threadItemsOf(record: TaskRecord, events: TaskEvent[]): ThreadItem[] {
  const dropped = supersededChecks(events)
  const prompts = promptBySeqOf(record, events)
  const items: ThreadItem[] = []
  let setupRun: TaskEvent[] = []
  let narrativeSeen = false

  for (const block of groupThreadEvents(events.filter((event) => !dropped.has(event.seq)))) {
    if (block.kind === 'tools') {
      items.push(...foldedSetup(setupRun), {
        kind: 'tools',
        key: block.events[0]?.seq ?? 0,
        events: block.events,
        turnIndex: block.turnIndex,
      })
      setupRun = []
      continue
    }
    if (SETUP_EVENT_TYPES.has(block.event.type) && !narrativeSeen) {
      setupRun.push(block.event)
      continue
    }
    narrativeSeen = narrativeSeen || NARRATIVE_EVENT_TYPES.has(block.event.type)
    items.push(...foldedSetup(setupRun), {
      kind: 'single',
      event: block.event,
      prompt: prompts.get(block.event.seq) ?? null,
      showTime: false,
    })
    setupRun = []
  }
  items.push(...foldedSetup(setupRun))
  return stampVisibleItems(items)
}

/** Statuses where the worktree (or the forked branch) can be reclaimed. The
 * offer itself lives at the tail of the thread, never beside the ship. */
const CLEANABLE_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'queued',
  'waiting_for_you',
  'review_ok',
  'review_ko',
  'shipped',
  'failed',
  'interrupted',
])

export type CleanupOffer = { available: boolean; labelKey: MessageKey; hintKey: MessageKey }

export function cleanupOffer(record: TaskRecord): CleanupOffer {
  const onWorktree = record.work_on === true
  return {
    available: CLEANABLE_STATUSES.has(record.status),
    labelKey: onWorktree ? 'workspace.cleanupWorktree' : 'workspace.cleanupBranch',
    hintKey: onWorktree ? 'workspace.cleanupWorktreeHint' : 'workspace.cleanupBranchHint',
  }
}
