// The conversation's own logic, kept out of the SFCs it drives: clocks, the
// interleaved thread, and the reply composer. Every function here is pure of
// DOM — focus and scrolling stay in the components, behind callbacks.

import { computed, onUnmounted, ref, watch, type ComputedRef, type Ref } from 'vue'
import { t } from '../i18n'
import type { TaskEventCtx } from '../task-event-registry'
import type { TaskEvent, TaskRecord, TaskTurn } from '../types'
import { extractQuickReplies } from './useQuickReplies'
import {
  formatDuration,
  formatTokens,
  groupThreadEvents,
  lastQuestion,
  replyModeOf,
  reviewRefOf,
  streamsLiveText,
  type ReplyMode,
} from './useTaskBoard'
import type { ApiResult, TaskState } from './useTasks'

export type ConversationClocks = {
  /** 1s ticker, alive only while a turn or its review is in flight. */
  nowTick: Ref<number>
  /** 30s ticker for the "il y a X" stamps. */
  slowNow: Ref<number>
  /** Elapsed time of whatever is in flight: the open turn, then its review. */
  runningElapsed: ComputedRef<string | null>
}

export function useConversationClocks(record: Ref<TaskRecord>): ConversationClocks {
  const nowTick = ref(Date.now())
  let ticker: ReturnType<typeof setInterval> | null = null
  watch(
    () => streamsLiveText(record.value.status),
    (running) => {
      if (running && ticker === null) {
        nowTick.value = Date.now()
        ticker = setInterval(() => {
          nowTick.value = Date.now()
        }, 1000)
      } else if (!running && ticker !== null) {
        clearInterval(ticker)
        ticker = null
      }
    },
    { immediate: true },
  )
  const slowNow = ref(Date.now())
  const slowTicker = setInterval(() => {
    slowNow.value = Date.now()
  }, 30_000)
  onUnmounted(() => {
    if (ticker !== null) {
      clearInterval(ticker)
    }
    clearInterval(slowTicker)
  })
  return { nowTick, slowNow, runningElapsed: elapsedOf(record, nowTick) }
}

function elapsedOf(record: Ref<TaskRecord>, nowTick: Ref<number>): ComputedRef<string | null> {
  return computed(() => {
    const turn = record.value.turns.at(-1)
    if (!turn) {
      return null
    }
    const since =
      record.value.status === 'running' && turn.ended_at === null
        ? turn.started_at
        : record.value.status === 'reviewing'
          ? turn.ended_at
          : null
    return since === null
      ? null
      : formatDuration(Math.max(0, nowTick.value - new Date(since).getTime()))
  })
}

// ── Thread: interleave each turn's user prompt with its journal events ────
// The i-th turn_started event opens record.turns[i]; the prompt renders as a
// user bubble right before it. Consecutive tool events fold into ONE block.
export type ThreadItem =
  | { kind: 'single'; event: TaskEvent; prompt: string | null }
  | { kind: 'tools'; key: number; events: TaskEvent[]; turnIndex: number }

export type ConversationThread = {
  items: ComputedRef<ThreadItem[]>
  ctxFor: (event: TaskEvent) => TaskEventCtx
  isLiveTools: (item: Extract<ThreadItem, { kind: 'tools' }>) => boolean
  toolsSummary: (item: Extract<ThreadItem, { kind: 'tools' }>) => string
}

export function useConversationThread(
  state: Ref<TaskState>,
  slowNow: Ref<number>,
): ConversationThread {
  const record = computed(() => state.value.record)
  const items = computed<ThreadItem[]>(() => {
    let turn = 0
    return groupThreadEvents(state.value.events).map((block) => {
      if (block.kind === 'tools') {
        return {
          kind: 'tools' as const,
          key: block.events[0]?.seq ?? 0,
          events: block.events,
          turnIndex: block.turnIndex,
        }
      }
      if (block.event.type === 'turn_started') {
        const prompt = record.value.turns[turn]?.prompt ?? null
        turn++
        return { kind: 'single' as const, event: block.event, prompt }
      }
      return { kind: 'single' as const, event: block.event, prompt: null }
    })
  })
  return {
    items,
    ctxFor: eventCtxFactory(state, slowNow),
    isLiveTools: (item) =>
      record.value.status === 'running' &&
      item.turnIndex === record.value.turns.length - 1 &&
      record.value.turns.at(-1)?.ended_at === null,
    toolsSummary: (item) => toolsSummaryText(record.value, item),
  }
}

function toolsSummaryText(
  record: TaskRecord,
  item: Extract<ThreadItem, { kind: 'tools' }>,
): string {
  const count = item.events.filter((event) => event.type === 'tool_use').length
  const parts = [t('workspace.toolsCount', { n: count })]
  const turn = record.turns[item.turnIndex]
  if (turn?.tokens) {
    parts.push(t('workspace.tokensCount', { n: formatTokens(turn.tokens) }))
  }
  if (turn?.ended_at) {
    const ms = new Date(turn.ended_at).getTime() - new Date(turn.started_at).getTime()
    if (ms > 0) {
      parts.push(formatDuration(ms))
    }
  }
  return parts.join(' · ')
}

// The journal's message/question payloads are bounded previews; the full body
// lives on the turn. Walk the events once, tracking the turn index, so each
// bubble renders the whole text instead of a cut "…" preview.
function fullTextBySeqOf(state: Ref<TaskState>): ComputedRef<Map<number, string>> {
  return computed(() => {
    const map = new Map<number, string>()
    const turns = state.value.record.turns
    let turn = -1
    for (const event of state.value.events) {
      if (event.type === 'turn_started') {
        turn++
        continue
      }
      const full = fullTextOf(event, turns[turn])
      if (full !== null) {
        map.set(event.seq, full)
      }
    }
    return map
  })
}

function fullTextOf(event: TaskEvent, turn: TaskTurn | undefined): string | null {
  if (event.type === 'message') {
    return turn?.response ?? null
  }
  return event.type === 'question' ? (turn?.question ?? null) : null
}

function eventCtxFactory(
  state: Ref<TaskState>,
  slowNow: Ref<number>,
): (event: TaskEvent) => TaskEventCtx {
  const fullTextBySeq = fullTextBySeqOf(state)
  const lastQuestionSeq = computed(
    () => state.value.events.findLast((event) => event.type === 'question')?.seq ?? null,
  )
  return (event) => {
    const record = state.value.record
    return {
      active:
        event.type === 'question' &&
        record.status === 'waiting_for_you' &&
        event.seq === lastQuestionSeq.value,
      // The card offers its review as soon as an archive can be asked for:
      // its own ref, or the task's current one on older journals.
      reviewAvailable:
        event.type === 'review_done' &&
        (reviewRefOf(event.data) !== null || record.review_ref !== null),
      now: slowNow.value,
      fullText: fullTextBySeq.value.get(event.seq) ?? null,
    }
  }
}

// ── Reply composer: prepare the next instruction at any time ──────────────
export type ReplyComposer = {
  draft: Ref<string>
  busy: Ref<boolean>
  /** Message parked while the agent holds the turn; auto-sent on hand-over. */
  pending: Ref<string | null>
  mode: ComputedRef<ReplyMode>
  placeholder: ComputedRef<string>
  questionActive: ComputedRef<boolean>
  quickReplies: ComputedRef<string[]>
  send: () => Promise<void>
  sendQuickReply: (option: string) => Promise<void>
  cancelPending: () => void
  prefillFix: () => void
}

export type ReplyComposerOptions = {
  state: Ref<TaskState>
  reply: (message: string) => Promise<ApiResult>
  onError: (message: string | null) => void
  onFocus: () => void
}

type ReplyDraft = {
  draft: Ref<string>
  busy: Ref<boolean>
  pending: Ref<string | null>
  mode: ComputedRef<ReplyMode>
  questionActive: ComputedRef<boolean>
  post: (message: string) => Promise<boolean>
  send: () => Promise<void>
  deliverPending: () => Promise<void>
}

function useReplyDraft(options: ReplyComposerOptions): ReplyDraft {
  const status = computed(() => options.state.value.record.status)
  const draft = ref('')
  const busy = ref(false)
  const pending = ref<string | null>(null)
  const mode = computed(() => replyModeOf(status.value))

  async function post(message: string): Promise<boolean> {
    busy.value = true
    options.onError(null)
    const result = await options.reply(message)
    busy.value = false
    if (!result.ok) {
      options.onError(result.error)
    }
    return result.ok
  }

  async function send(): Promise<void> {
    const message = draft.value.trim()
    if (!message || busy.value || mode.value === 'dead') {
      return
    }
    if (mode.value === 'queue') {
      // Park it: the status watcher delivers on hand-over. A second send while
      // parked appends — one turn, one message.
      pending.value = prepend(pending.value, message)
      draft.value = ''
      return
    }
    if (await post(message)) {
      draft.value = ''
    }
  }

  async function deliverPending(): Promise<void> {
    const message = pending.value
    if (message === null || busy.value) {
      return
    }
    pending.value = null
    if (!(await post(message))) {
      // Never lose the words: a failed delivery lands back in the draft.
      draft.value = prepend(message, draft.value)
    }
  }

  return {
    draft,
    busy,
    pending,
    mode,
    questionActive: computed(() => status.value === 'waiting_for_you'),
    post,
    send,
    deliverPending,
  }
}

export function useReplyComposer(options: ReplyComposerOptions): ReplyComposer {
  const { draft, busy, pending, mode, questionActive, post, send, deliverPending } =
    useReplyDraft(options)

  // The field focuses by itself the moment the agent hands over — and any
  // parked message leaves on its own at that same moment.
  watch(
    () => options.state.value.record.status,
    (status) => {
      if (replyModeOf(status) === 'now' && pending.value !== null) {
        void deliverPending()
      } else if (status === 'waiting_for_you') {
        options.onFocus()
      }
    },
    { immediate: true },
  )

  return {
    draft,
    busy,
    pending,
    mode,
    placeholder: computed(() =>
      mode.value === 'queue'
        ? t('workspace.replyQueuePlaceholder')
        : t('workspace.replyPlaceholder'),
    ),
    questionActive,
    // Quick replies: the enumerated options of the ACTIVE question, one click.
    quickReplies: computed(() => {
      if (!questionActive.value) {
        return []
      }
      const question = lastQuestion(options.state.value.events)
      return question === null ? [] : extractQuickReplies(question)
    }),
    send,
    sendQuickReply: async (option) => {
      if (!busy.value) {
        await post(option)
      }
    },
    cancelPending: () => {
      // Parked message back under the cursor for editing (or just clearing).
      const message = pending.value
      pending.value = null
      if (message !== null) {
        draft.value = prepend(message, draft.value)
        options.onFocus()
      }
    },
    prefillFix: () => {
      draft.value = t('workspace.fixFindingsPrefill')
      options.onFocus()
    },
  }
}

const prepend = (head: string | null, tail: string): string =>
  head === null ? tail : tail ? `${head}\n${tail}` : head
