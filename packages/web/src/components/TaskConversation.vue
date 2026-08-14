<script setup lang="ts">
// One conversation of the focus zone, maquette form. Header: title (⚠ when
// the agent waits), 📌 pin, the discreet 2-click branch/worktree cleanup,
// Stop, Ship; a mono "project · ⎇ branch" chip plus the colored status
// phrase; then the Conversation / Diff / Checks tabs (Diff is the scoped
// PreviewPanel, Checks is visible but not wired yet). The Conversation tab
// renders the journal through the event registry — agent bubbles, the amber
// question card, folded tool runs reading "agent working — elapsed · tokens"
// while live — with QUICK-REPLY buttons under an active question whose text
// enumerates its options (extractQuickReplies, pure), and the reply composer
// pinned at the bottom (amber send while a question waits, green otherwise).
// A task in flight is read-only — you answer questions or interrupt; a reply
// typed during a run is parked and delivered on hand-over.
import { computed, nextTick, onUnmounted, ref, shallowRef, watch } from 'vue'
import { extractQuickReplies } from '../composables/useQuickReplies'
import {
  focusTabs,
  formatDuration,
  formatTokens,
  groupThreadEvents,
  lastQuestion,
  replyModeOf,
  type FocusTab,
} from '../composables/useTaskBoard'
import type { ApiResult, TaskState } from '../composables/useTasks'
import { EXECUTION_STATUS } from '../execution-status'
import { t } from '../i18n'
import { TASK_EVENT_COMPONENTS, type TaskEventCtx } from '../task-event-registry'
import type { PreviewResult, ReviewRecord, TaskEvent, TaskStatus as TaskStatus2 } from '../types'
import PreviewPanel from './PreviewPanel.vue'

const props = defineProps<{
  state: TaskState
  /** Display name of the conversation's repo, for the header chip. */
  projectName: string
  /** Pinned in the focus deck: the 📌 toggle reflects and flips it. */
  pinned: boolean
  reply: (message: string) => Promise<ApiResult>
  interrupt: () => Promise<ApiResult>
  ship: () => Promise<ApiResult>
  abandon: () => Promise<ApiResult>
}>()

const emit = defineEmits<{ 'open-review': [record: ReviewRecord]; 'toggle-pin': [] }>()

const record = computed(() => props.state.record)
const visual = computed(() => EXECUTION_STATUS[record.value.status])

// ── Tabs: Conversation / Diff · N / Checks (soon) ─────────────────────────
const tab = ref<FocusTab>('conversation')
const tabs = computed(() => focusTabs(record.value.branch.length > 0))

// The PreviewPanel mounts once the conversation has a branch and stays
// mounted (v-show): its single fetch feeds both the Diff tab body and the
// tab's file count. New commits remount it so the count stays honest.
const diffCount = ref<number | null>(null)

function onPreviewLoaded(preview: PreviewResult): void {
  diffCount.value = preview.diffStats.files
}

const commitCount = computed(() => props.state.events.filter((e) => e.type === 'commit').length)
const previewKey = computed(() => `${record.value.branch}#${commitCount.value}`)

const diffTabLabel = computed(() =>
  diffCount.value === null
    ? t('workspace.tabDiff')
    : t('workspace.tabDiffCount', { n: diffCount.value }, diffCount.value),
)

function pickTab(next: FocusTab): void {
  if (tabs.value.find((entry) => entry.id === next)?.enabled) {
    tab.value = next
  }
}

// A branch can disappear under the open Diff tab (cleanup): fall back.
watch(
  () => record.value.branch,
  (branch) => {
    if (branch.length === 0) {
      tab.value = 'conversation'
      diffCount.value = null
    }
  },
)

// ── Scroll: thread scrolls, reply stays pinned; follow the tail politely ──
// New events/stream text keep the view glued to the bottom ONLY when the
// reader is already there (within a small margin) — scrolling up to read is
// never hijacked.
const cvScroll = ref<HTMLDivElement | null>(null)
const FOLLOW_MARGIN_PX = 80

function followTail(): void {
  const el = cvScroll.value
  if (!el) {
    return
  }
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_MARGIN_PX
  if (nearBottom) {
    void nextTick(() => {
      el.scrollTop = el.scrollHeight
    })
  }
}

watch(() => [props.state.events.length, props.state.liveText.length], followTail)

// ── Thread: interleave each turn's user prompt with its journal events ────
// The i-th turn_started event opens record.turns[i]; the prompt renders as a
// user bubble right before it. Consecutive tool events fold into ONE block
// (groupThreadEvents): the raw feed is detail, closed by default — while the
// turn runs it reads "agent working — elapsed · tokens" instead.
type ThreadItem =
  | { kind: 'single'; event: TaskEvent; prompt: string | null }
  | { kind: 'tools'; key: number; events: TaskEvent[]; turnIndex: number }

const thread = computed<ThreadItem[]>(() => {
  let turn = 0
  return groupThreadEvents(props.state.events).map((block) => {
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

// ── Clocks ────────────────────────────────────────────────────────────────
// A fast ticker (1s) drives the live meter while the agent holds a turn; a
// slow one (30s) keeps the "il y a X" stamps honest without being busy.
const nowTick = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | null = null
watch(
  () => record.value.status === 'running',
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

const runningElapsed = computed(() => {
  const turn = record.value.turns.at(-1)
  if (record.value.status !== 'running' || !turn || turn.ended_at !== null) {
    return null
  }
  return formatDuration(Math.max(0, nowTick.value - new Date(turn.started_at).getTime()))
})

/** A tools block is LIVE when it belongs to the still-open turn of a running task. */
function isLiveTools(item: Extract<ThreadItem, { kind: 'tools' }>): boolean {
  return (
    record.value.status === 'running' &&
    item.turnIndex === record.value.turns.length - 1 &&
    record.value.turns.at(-1)?.ended_at === null
  )
}

function toolsSummary(item: Extract<ThreadItem, { kind: 'tools' }>): string {
  const count = item.events.filter((e) => e.type === 'tool_use').length
  const parts = [t('workspace.toolsCount', { n: count })]
  const turn = record.value.turns[item.turnIndex]
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

function liveSummary(): string {
  const parts: string[] = []
  if (runningElapsed.value) {
    parts.push(runningElapsed.value)
  }
  if (props.state.liveTokens > 0) {
    parts.push(t('workspace.tokensCount', { n: formatTokens(props.state.liveTokens) }))
  }
  return parts.length > 0 ? ` — ${parts.join(' · ')}` : ''
}

const lastQuestionSeq = computed(() => {
  const questions = props.state.events.filter((e) => e.type === 'question')
  return questions.at(-1)?.seq ?? null
})

function ctxFor(event: TaskEvent): TaskEventCtx {
  return {
    active:
      event.type === 'question' &&
      record.value.status === 'waiting_for_you' &&
      event.seq === lastQuestionSeq.value,
    reviewAvailable: reviewRecord.value !== null,
    now: slowNow.value,
  }
}

const streaming = computed(
  () => props.state.liveText.trim().length > 0 && record.value.status === 'running',
)

// ── Quick replies: enumerated options of the ACTIVE question, one click ───
const questionActive = computed(() => record.value.status === 'waiting_for_you')

const quickReplies = computed<string[]>(() => {
  if (!questionActive.value) {
    return []
  }
  const question = lastQuestion(props.state.events)
  return question === null ? [] : extractQuickReplies(question)
})

async function sendQuickReply(option: string): Promise<void> {
  if (replyBusy.value) {
    return
  }
  replyBusy.value = true
  actionError.value = null
  const result = await props.reply(option)
  replyBusy.value = false
  if (!result.ok) {
    actionError.value = result.error
  }
}

// ── Review linkage: is the task's review loadable in the review view? ─────
// The server session exposes one review record; it belongs to this task only
// when it was produced on the task's branch.
const reviewRecord = shallowRef<ReviewRecord | null>(null)
const hasReviewDone = computed(() => props.state.events.some((e) => e.type === 'review_done'))

watch(
  hasReviewDone,
  async (has) => {
    if (!has || reviewRecord.value || !record.value.branch) {
      return
    }
    try {
      const res = await fetch('/api/review')
      if (res.status !== 200) {
        return
      }
      const review = (await res.json()) as ReviewRecord
      if (review.meta.branch === record.value.branch) {
        reviewRecord.value = review
      }
    } catch {
      // Local server stopped: the card simply keeps its degraded form.
    }
  },
  { immediate: true },
)

function openReview(): void {
  if (reviewRecord.value) {
    emit('open-review', reviewRecord.value)
  }
}

// ── Reply composer (always visible: prepare the next instruction anytime) ──
const replyInput = ref<HTMLTextAreaElement | null>(null)
const replyDraft = ref('')
const replyBusy = ref(false)
/** Message parked while the agent holds the turn; auto-sent on hand-over. */
const pendingReply = ref<string | null>(null)

const replyMode = computed(() => replyModeOf(record.value.status))
const replyPlaceholder = computed(() =>
  replyMode.value === 'queue'
    ? t('workspace.replyQueuePlaceholder')
    : t('workspace.replyPlaceholder'),
)

function focusReply(): void {
  tab.value = 'conversation'
  void nextTick(() => replyInput.value?.focus())
}

// The reply field focuses by itself the moment the agent hands over — and any
// parked message leaves on its own at that same moment.
watch(
  () => record.value.status,
  (status) => {
    if (replyModeOf(status) === 'now' && pendingReply.value !== null) {
      void deliverPending()
    } else if (status === 'waiting_for_you') {
      focusReply()
    }
  },
  { immediate: true },
)

function prefillFix(): void {
  replyDraft.value = t('workspace.fixFindingsPrefill')
  focusReply()
}

const actionError = ref<string | null>(null)
const shipNotice = ref<string | null>(null)

async function deliverPending(): Promise<void> {
  const message = pendingReply.value
  if (message === null || replyBusy.value) {
    return
  }
  pendingReply.value = null
  replyBusy.value = true
  actionError.value = null
  const result = await props.reply(message)
  replyBusy.value = false
  if (!result.ok) {
    // Never lose the words: a failed delivery lands back in the draft.
    replyDraft.value = replyDraft.value ? `${message}\n${replyDraft.value}` : message
    actionError.value = result.error
  }
}

/** Parked message back under the cursor for editing (or just clearing). */
function cancelPending(): void {
  const message = pendingReply.value
  pendingReply.value = null
  if (message !== null) {
    replyDraft.value = replyDraft.value ? `${message}\n${replyDraft.value}` : message
    focusReply()
  }
}

async function sendReply(): Promise<void> {
  const message = replyDraft.value.trim()
  if (!message || replyBusy.value || replyMode.value === 'dead') {
    return
  }
  if (replyMode.value === 'queue') {
    // Park it: the status watcher delivers when the agent hands over. A second
    // send while parked appends — one turn, one message.
    pendingReply.value = pendingReply.value ? `${pendingReply.value}\n${message}` : message
    replyDraft.value = ''
    return
  }
  replyBusy.value = true
  actionError.value = null
  const result = await props.reply(message)
  replyBusy.value = false
  if (result.ok) {
    replyDraft.value = ''
  } else {
    actionError.value = result.error
  }
}

// ── Cleanup: remove the worktree (and forked branch) with confirmation ────
const CLEANABLE: ReadonlySet<TaskStatus2> = new Set([
  'queued',
  'waiting_for_you',
  'review_ok',
  'review_ko',
  'shipped',
  'failed',
  'interrupted',
])
const canCleanup = computed(() => CLEANABLE.has(record.value.status))
// Two-step: first click arms, second fires; any status change disarms.
const cleanupArmed = ref(false)
const cleanupBusy = ref(false)
watch(
  () => record.value.status,
  () => {
    cleanupArmed.value = false
  },
)

async function doCleanup(): Promise<void> {
  if (!cleanupArmed.value) {
    cleanupArmed.value = true
    return
  }
  cleanupArmed.value = false
  cleanupBusy.value = true
  actionError.value = null
  const result = await props.abandon()
  cleanupBusy.value = false
  if (!result.ok) {
    actionError.value = result.error
  }
}

// ── Header actions ────────────────────────────────────────────────────────
const canInterrupt = computed(() =>
  ['queued', 'running', 'waiting_for_you', 'reviewing'].includes(record.value.status),
)

async function doInterrupt(): Promise<void> {
  actionError.value = null
  const result = await props.interrupt()
  if (!result.ok) {
    actionError.value = result.error
  }
}

async function doShip(): Promise<void> {
  actionError.value = null
  shipNotice.value = null
  const result = await props.ship()
  if (result.ok) {
    return
  }
  if (result.status === 501) {
    // T5 wires the actual push + MR creation; the button honors the contract.
    shipNotice.value = t('workspace.shipSoon')
  } else {
    actionError.value = result.error
  }
}

const work = computed(() => formatDuration(record.value.work_ms))
const wait = computed(() =>
  record.value.wait_ms > 0 ? formatDuration(record.value.wait_ms) : null,
)
</script>

<template>
  <div class="cv-root">
    <header class="cv-head">
      <div class="cv-title-row">
        <span v-if="visual.attention" class="cv-warn" aria-hidden="true">⚠</span>
        <span
          v-else
          class="cv-dot"
          :class="{ 'cv-dot--pulse': visual.pulse }"
          :style="{ background: visual.color }"
          aria-hidden="true"
        />
        <h1 class="cv-title">{{ record.title }}</h1>
        <span class="cv-actions">
          <button
            class="cv-pin"
            :class="{ 'cv-pin--on': pinned }"
            type="button"
            :aria-pressed="pinned"
            :aria-label="pinned ? t('workspace.unpin') : t('workspace.pin')"
            :title="pinned ? t('workspace.unpin') : t('workspace.pin')"
            @click="emit('toggle-pin')"
          >
            📌
          </button>
          <button
            v-if="canCleanup"
            class="cv-btn cv-btn--ghost-danger"
            :class="{ 'cv-btn--armed': cleanupArmed }"
            :disabled="cleanupBusy"
            :title="
              record.work_on ? t('workspace.cleanupWorktreeHint') : t('workspace.cleanupBranchHint')
            "
            @click="doCleanup"
          >
            {{
              cleanupArmed
                ? t('workspace.cleanupConfirm')
                : record.work_on
                  ? t('workspace.cleanupWorktree')
                  : t('workspace.cleanupBranch')
            }}
          </button>
          <button v-if="canInterrupt" class="cv-btn cv-btn--danger" @click="doInterrupt">
            {{ t('workspace.interrupt') }}
          </button>
          <button v-if="record.status === 'review_ok'" class="cv-btn cv-btn--ship" @click="doShip">
            {{ t('workspace.ship') }}
          </button>
        </span>
      </div>

      <div class="cv-sub">
        <span class="cv-chip">
          {{ projectName }} · <span aria-hidden="true">⎇</span> {{ record.branch || record.base }}
        </span>
        <span class="cv-phrase" :style="{ color: visual.text }">{{ t(visual.phraseKey) }}</span>
        <span class="cv-chrono">
          <span>{{ t('workspace.workTime', { t: work }) }}</span>
          <span v-if="wait" class="cv-wait">{{ t('workspace.waitTime', { t: wait }) }}</span>
        </span>
      </div>

      <p v-if="shipNotice" class="cv-notice">{{ shipNotice }}</p>
      <p v-if="actionError" class="cv-error">{{ actionError }}</p>

      <nav class="cv-tabs" :aria-label="t('workspace.conversations')">
        <button
          class="cv-tab"
          :class="{ 'cv-tab--active': tab === 'conversation' }"
          type="button"
          @click="pickTab('conversation')"
        >
          {{ t('workspace.tabConversation') }}
        </button>
        <button
          class="cv-tab"
          :class="{ 'cv-tab--active': tab === 'diff' }"
          type="button"
          :disabled="!tabs[1]?.enabled"
          :title="tabs[1]?.enabled ? undefined : t('workspace.noBranchYet')"
          @click="pickTab('diff')"
        >
          {{ diffTabLabel }}
        </button>
        <button
          class="cv-tab cv-tab--soon"
          type="button"
          disabled
          :title="t('workspace.tabChecksSoon')"
        >
          {{ t('workspace.tabChecks') }}
        </button>
      </nav>
    </header>

    <!-- Conversation tab: the thread scrolls, the composer stays pinned. -->
    <div v-show="tab === 'conversation'" class="cv-body">
      <div ref="cvScroll" class="cv-scroll">
        <div class="cv-thread">
          <template
            v-for="item in thread"
            :key="item.kind === 'tools' ? `tools-${item.key}` : item.event.seq"
          >
            <template v-if="item.kind === 'single'">
              <div v-if="item.prompt !== null" class="cv-user">
                <p class="cv-user-text">{{ item.prompt }}</p>
              </div>
              <component
                :is="TASK_EVENT_COMPONENTS[item.event.type]"
                :event="item.event"
                :task="record"
                :ctx="ctxFor(item.event)"
                @open-review="openReview"
                @fix="prefillFix"
              />
            </template>
            <details v-else class="cv-tools" :class="{ 'cv-tools--live': isLiveTools(item) }">
              <summary class="cv-tools-summary">
                <template v-if="isLiveTools(item)">
                  <span class="cv-tools-dot" aria-hidden="true" />
                  <span class="cv-tools-label"
                    >{{ t('workspace.agentWorking') }}{{ liveSummary() }}</span
                  >
                </template>
                <template v-else>
                  <span class="cv-tools-label cv-tools-label--done">
                    {{ t('workspace.toolsDetail') }} — {{ toolsSummary(item) }}
                  </span>
                </template>
              </summary>
              <div class="cv-tools-body">
                <component
                  :is="TASK_EVENT_COMPONENTS[ev.type]"
                  v-for="ev in item.events"
                  :key="ev.seq"
                  :event="ev"
                  :task="record"
                  :ctx="ctxFor(ev)"
                />
              </div>
            </details>
          </template>

          <div v-if="streaming" class="cv-live">
            <p class="cv-live-text">
              {{ state.liveText }}<span class="cv-caret" aria-hidden="true" />
            </p>
            <p class="cv-live-hint">{{ t('workspace.agentWriting') }}</p>
          </div>

          <!-- Quick replies: the question enumerated its options — one click. -->
          <div v-if="quickReplies.length > 0" class="cv-quick">
            <button
              v-for="option in quickReplies"
              :key="option"
              class="cv-quick-opt"
              type="button"
              :disabled="replyBusy"
              @click="sendQuickReply(option)"
            >
              → {{ option }}
            </button>
            <button class="cv-quick-other" type="button" @click="focusReply">
              {{ t('workspace.quickReplyOther') }}
            </button>
          </div>
        </div>
      </div>

      <div v-if="pendingReply !== null" class="cv-pending" role="status">
        <span class="cv-pending-label">{{ t('workspace.replyPendingLabel') }}</span>
        <span class="cv-pending-text">{{ pendingReply }}</span>
        <button
          class="cv-pending-cancel"
          type="button"
          :aria-label="t('workspace.replyPendingCancel')"
          :title="t('workspace.replyPendingCancel')"
          @click="cancelPending"
        >
          ✕
        </button>
      </div>

      <form v-if="replyMode !== 'dead'" class="cv-reply" @submit.prevent="sendReply">
        <textarea
          ref="replyInput"
          v-model="replyDraft"
          class="cv-reply-input"
          :class="{ 'cv-reply-input--waiting': questionActive }"
          rows="2"
          :placeholder="replyPlaceholder"
          @keydown.enter="(e) => (e.metaKey || e.ctrlKey) && sendReply()"
        />
        <button
          class="cv-reply-send"
          :class="{ 'cv-reply-send--waiting': questionActive }"
          type="submit"
          :disabled="replyBusy || !replyDraft.trim()"
        >
          {{ replyMode === 'queue' ? t('workspace.replyQueueSend') : t('workspace.replySend') }}
        </button>
      </form>
      <p v-else class="cv-reply-dead">{{ t('workspace.replyDeadHint') }}</p>
    </div>

    <!-- Diff tab: the scoped PreviewPanel; mounted once a branch exists so
         its single fetch also labels the tab with the real file count. -->
    <div v-if="record.branch" v-show="tab === 'diff'" class="cv-diff">
      <PreviewPanel
        :key="previewKey"
        :source="{ kind: 'branch', name: record.branch }"
        :project="state.projectId"
        @loaded="onPreviewLoaded"
      />
    </div>
  </div>
</template>

<style scoped>
.cv-root {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
  min-height: 0;
  background: var(--cs-inset);
}

/* ── Header ───────────────────────────────────────────────────────────── */
.cv-head {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 14px 20px 0;
  background: var(--cs-head);
  border-bottom: 1px solid var(--cs-line);
}

.cv-title-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.cv-warn {
  flex: none;
  font-size: 13px;
  color: var(--cs-amber-text);
}

.cv-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: none;
}

.cv-dot--pulse {
  box-shadow: var(--cs-amber-glow);
  animation: cv-pulse 1.6s ease-in-out infinite;
}

@keyframes cv-pulse {
  50% {
    opacity: 0.45;
  }
}

.cv-title {
  margin: 0;
  font-size: 14.5px;
  font-weight: 700;
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cv-actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
}

.cv-pin {
  font-size: 13px;
  line-height: 1;
  padding: 5px 8px;
  border-radius: 6px;
  border: 1px solid transparent;
  background: transparent;
  cursor: pointer;
  filter: grayscale(1);
  opacity: 0.55;
}

.cv-pin:hover {
  border-color: var(--cs-line-3);
  opacity: 0.85;
}

/* Pinned is a STATE: the pin wears the green. */
.cv-pin--on {
  filter: none;
  opacity: 1;
  border-color: var(--cs-green-ring);
  background: var(--cs-green-soft);
}

.cv-btn {
  font-size: 12px;
  font-weight: 600;
  font-family: inherit;
  padding: 6px 12px;
  border-radius: 6px;
  border: 1px solid var(--cs-line-2);
  background: transparent;
  cursor: pointer;
  transition: border-color 0.12s ease;
}

.cv-btn--danger {
  color: var(--cs-red-text);
  border-color: var(--cs-red-line);
}

.cv-btn--danger:hover {
  border-color: var(--cs-red);
}

.cv-btn--ship {
  color: var(--cs-on-green);
  background: var(--cs-green);
  border-color: var(--cs-green);
}

.cv-btn--ship:hover {
  background: var(--cs-green-hover);
  border-color: var(--cs-green-hover);
}

.cv-btn:disabled {
  opacity: 0.45;
  cursor: default;
}

.cv-btn--ghost-danger {
  border-color: transparent;
  color: var(--cs-ghost);
}

.cv-btn--ghost-danger:hover {
  border-color: var(--cs-red-line);
  color: var(--cs-red-text);
}

/* Armed = the click is live: the danger is a STATE, so it wears the color. */
.cv-btn--armed {
  border-color: var(--cs-red);
  color: var(--cs-red-text);
  background: var(--cs-red-soft);
}

.cv-sub {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--cs-muted);
}

.cv-chip {
  padding: 3px 8px;
  background: var(--cs-panel);
  border: 1px solid var(--cs-line-2);
  border-radius: 5px;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cv-phrase {
  font-weight: 500;
}

.cv-chrono {
  display: flex;
  gap: 10px;
  font-variant-numeric: tabular-nums;
  color: var(--cs-ghost);
}

.cv-wait {
  color: var(--cs-ghost);
}

.cv-notice {
  margin: 0;
  font-size: 12.5px;
  color: var(--cs-amber-text);
}

.cv-error {
  margin: 0;
  font-size: 12.5px;
  color: var(--cs-red-text);
  font-family: var(--font-mono);
  overflow-wrap: anywhere;
}

/* ── Tabs ─────────────────────────────────────────────────────────────── */
.cv-tabs {
  display: flex;
  gap: 2px;
  margin: 2px -20px 0;
  padding: 0 20px;
}

.cv-tab {
  font-size: 12px;
  font-family: inherit;
  padding: 9px 14px;
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--cs-muted);
  cursor: pointer;
}

.cv-tab:hover:not(:disabled) {
  color: var(--cs-text);
}

/* The active tab is underlined green (chosen, not "passing"). */
.cv-tab--active {
  color: var(--cs-text);
  font-weight: 600;
  border-bottom-color: var(--cs-green);
}

.cv-tab:disabled {
  cursor: default;
  color: var(--cs-ghost);
  opacity: 0.7;
}

/* ── Conversation body ────────────────────────────────────────────────── */
.cv-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 0 20px 16px;
}

.cv-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  margin: 0 -20px;
  padding: 18px 20px 4px;
}

.cv-thread {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* User turn: sober green-tinted bubble, right-aligned (maquette). */
.cv-user {
  align-self: flex-end;
  max-width: 72%;
  margin: 4px 0;
  padding: 10px 13px;
  border: 1px solid var(--cs-green-ring);
  border-radius: 10px 10px 3px 10px;
  background: var(--cs-green-soft);
}

.cv-user-text {
  margin: 0;
  font-size: 13px;
  line-height: 1.55;
  color: var(--cs-text);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  min-width: 0;
}

.cv-live {
  margin-top: 4px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--cs-amber-soft);
  max-width: 85%;
}

.cv-live-text {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--cs-text);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.cv-caret {
  display: inline-block;
  width: 7px;
  height: 14px;
  margin-left: 3px;
  vertical-align: text-bottom;
  background: var(--cs-amber);
  animation: cv-caret 0.9s steps(2) infinite;
}

@keyframes cv-caret {
  50% {
    opacity: 0;
  }
}

.cv-live-hint {
  margin: 6px 0 0;
  font-size: 11.5px;
  color: var(--cs-amber-text);
}

/* Folded tool runs: inset mono block (maquette's work journal). */
.cv-tools {
  border: 1px solid var(--cs-line);
  border-radius: 8px;
  background: var(--cs-panel);
  max-width: 85%;
}

/* The live variant is a signal: quiet amber ring, pulsing dot. */
.cv-tools--live {
  border-color: var(--cs-amber-line);
  background: var(--cs-amber-soft);
}

.cv-tools-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 11px;
  cursor: pointer;
  list-style: none;
  font-size: 12px;
  color: var(--cs-muted);
}

.cv-tools-summary::-webkit-details-marker {
  display: none;
}

.cv-tools-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--cs-amber);
  box-shadow: var(--cs-amber-glow);
  animation: cv-tools-pulse 1.6s ease-in-out infinite;
}

@keyframes cv-tools-pulse {
  50% {
    opacity: 0.35;
  }
}

@media (prefers-reduced-motion: reduce) {
  .cv-tools-dot,
  .cv-dot--pulse {
    animation: none;
  }
}

.cv-tools--live .cv-tools-label {
  color: var(--cs-amber-text);
  font-weight: 600;
}

.cv-tools-label--done {
  font-family: var(--font-mono);
  font-size: 11px;
}

.cv-tools-body {
  border-top: 1px solid var(--cs-line);
  padding: 6px 11px 9px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* ── Quick replies ────────────────────────────────────────────────────── */
.cv-quick {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 2px;
}

/* Amber: answering IS the pending human action. */
.cv-quick-opt {
  font-size: 12.5px;
  font-weight: 600;
  font-family: inherit;
  padding: 8px 14px;
  border: 1px solid var(--cs-amber-line);
  border-radius: 8px;
  background: var(--cs-amber-soft);
  color: var(--cs-amber-text);
  cursor: pointer;
  overflow-wrap: anywhere;
  text-align: left;
}

.cv-quick-opt:hover:not(:disabled) {
  border-color: var(--cs-amber);
}

.cv-quick-opt:disabled {
  opacity: 0.5;
  cursor: default;
}

.cv-quick-other {
  font-size: 12.5px;
  font-family: inherit;
  padding: 8px 14px;
  border: 1px solid var(--cs-line-3);
  border-radius: 8px;
  background: transparent;
  color: var(--cs-muted);
  cursor: pointer;
}

.cv-quick-other:hover {
  color: var(--cs-text);
}

/* ── Composer ─────────────────────────────────────────────────────────── */
.cv-reply {
  display: flex;
  align-items: flex-end;
  gap: 10px;
}

/* Parked message: a quiet amber signal — something WILL happen, not an error. */
.cv-pending {
  display: flex;
  align-items: baseline;
  gap: 8px;
  border: 1px solid var(--cs-amber);
  border-radius: 10px;
  background: var(--cs-amber-soft);
  padding: 7px 11px;
  font-size: 12.5px;
}

.cv-pending-label {
  flex: none;
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--cs-amber-text);
}

.cv-pending-text {
  flex: 1;
  color: var(--cs-text);
  white-space: pre-line;
  overflow-wrap: anywhere;
}

.cv-pending-cancel {
  flex: none;
  border: none;
  background: none;
  color: var(--cs-ghost);
  font-size: 13px;
  cursor: pointer;
  padding: 0 2px;
}

.cv-pending-cancel:hover {
  color: var(--cs-text);
}

.cv-reply-dead {
  margin: 0;
  font-size: 12.5px;
  color: var(--cs-ghost);
}

.cv-reply-input {
  flex: 1;
  border: 1px solid var(--cs-line-3);
  border-radius: 9px;
  background: var(--cs-surface);
  color: var(--cs-text);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.55;
  padding: 9px 12px;
  resize: vertical;
  min-height: 44px;
}

/* A live question turns the composer amber: answering unblocks the agent. */
.cv-reply-input--waiting {
  border-color: var(--cs-amber-line);
}

.cv-reply-input::placeholder {
  color: var(--cs-ghost);
}

.cv-reply-send {
  font-size: 12.5px;
  font-weight: 700;
  font-family: inherit;
  padding: 9px 16px;
  border-radius: 8px;
  border: 1px solid var(--cs-green);
  background: var(--cs-green);
  color: var(--cs-on-green);
  cursor: pointer;
}

.cv-reply-send--waiting {
  border-color: var(--cs-amber-text);
  background: var(--cs-amber-text);
  color: var(--cs-amber-card);
}

.cv-reply-send:disabled {
  opacity: 0.45;
  cursor: default;
}

/* ── Diff tab ─────────────────────────────────────────────────────────── */
.cv-diff {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 20px;
}
</style>
