<script setup lang="ts">
// Conversation thread of one task: the journal rendered through the event
// registry (compact lines always visible, live streamed text while a turn
// runs, results unfolding on demand). A task in flight is read-only — you
// answer questions or interrupt, nothing else (no free chat into a live run).
import { computed, nextTick, ref, shallowRef, watch } from 'vue'
import { clockTime, formatDuration } from '../composables/useTaskBoard'
import type { ApiResult, TaskState } from '../composables/useTasks'
import { EXECUTION_STATUS } from '../execution-status'
import { t } from '../i18n'
import { TASK_EVENT_COMPONENTS, type TaskEventCtx } from '../task-event-registry'
import type { ReviewRecord, TaskEvent, TaskStatus } from '../types'

const props = defineProps<{
  state: TaskState
  reply: (message: string) => Promise<ApiResult>
  interrupt: () => Promise<ApiResult>
  ship: () => Promise<ApiResult>
}>()

const emit = defineEmits<{ back: []; 'open-review': [record: ReviewRecord] }>()

const record = computed(() => props.state.record)
const visual = computed(() => EXECUTION_STATUS[record.value.status])

// ── Thread: interleave each turn's user prompt with its journal events ────
// The i-th turn_started event opens record.turns[i]; the prompt renders as a
// user bubble right before it, so the thread reads as a conversation.
type ThreadItem = { event: TaskEvent; prompt: string | null }

const thread = computed<ThreadItem[]>(() => {
  let turn = 0
  return props.state.events.map((event) => {
    if (event.type === 'turn_started') {
      const prompt = record.value.turns[turn]?.prompt ?? null
      turn++
      return { event, prompt }
    }
    return { event, prompt: null }
  })
})

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
  }
}

const streaming = computed(
  () => props.state.liveText.trim().length > 0 && record.value.status === 'running',
)

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

// ── Reply composer ────────────────────────────────────────────────────────
const REPLYABLE: ReadonlySet<TaskStatus> = new Set([
  'waiting_for_you',
  'review_ok',
  'review_ko',
  'failed',
  'interrupted',
])

const replyInput = ref<HTMLTextAreaElement | null>(null)
const replyDraft = ref('')
const replyBusy = ref(false)
const canReply = computed(() => REPLYABLE.has(record.value.status))

function focusReply(): void {
  void nextTick(() => replyInput.value?.focus())
}

// The reply field focuses by itself the moment the agent hands over.
watch(
  () => record.value.status,
  (status) => {
    if (status === 'waiting_for_you') {
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

async function sendReply(): Promise<void> {
  const message = replyDraft.value.trim()
  if (!message || replyBusy.value) {
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
      <button class="cv-back" @click="emit('back')">{{ t('workspace.back') }}</button>
      <div class="cv-title-row">
        <span
          class="cv-dot"
          :class="{ 'cv-dot--pulse': visual.pulse }"
          :style="{ background: visual.color }"
          aria-hidden="true"
        />
        <h1 class="cv-title">{{ record.title }}</h1>
        <span class="cv-status" :style="{ color: visual.text, background: visual.soft }">
          {{ visual.icon }} {{ t(visual.labelKey) }}
        </span>
      </div>
      <div class="cv-sub">
        <code v-if="record.branch" class="cv-branch">{{ record.branch }}</code>
        <span class="cv-chrono">
          <span>{{ t('workspace.workTime', { t: work }) }}</span>
          <span v-if="wait" class="cv-wait">{{ t('workspace.waitTime', { t: wait }) }}</span>
        </span>
        <span class="cv-actions">
          <button v-if="canInterrupt" class="cv-btn cv-btn--danger" @click="doInterrupt">
            {{ t('workspace.interrupt') }}
          </button>
          <button
            class="cv-btn cv-btn--ship"
            :disabled="record.status !== 'review_ok'"
            @click="doShip"
          >
            {{ t('workspace.ship') }}
          </button>
        </span>
      </div>
      <p v-if="shipNotice" class="cv-notice">{{ shipNotice }}</p>
      <p v-if="actionError" class="cv-error">{{ actionError }}</p>
    </header>

    <div class="cv-thread">
      <template v-for="item in thread" :key="item.event.seq">
        <div v-if="item.prompt !== null" class="cv-user">
          <span class="cv-user-tag">{{ t('workspace.you') }}</span>
          <p class="cv-user-text">{{ item.prompt }}</p>
          <span class="cv-user-time">{{ clockTime(item.event.at) }}</span>
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

      <div v-if="streaming" class="cv-live">
        <p class="cv-live-text">{{ state.liveText }}<span class="cv-caret" aria-hidden="true" /></p>
        <p class="cv-live-hint">{{ t('workspace.agentWriting') }}</p>
      </div>
    </div>

    <form v-if="canReply" class="cv-reply" @submit.prevent="sendReply">
      <textarea
        ref="replyInput"
        v-model="replyDraft"
        class="cv-reply-input"
        rows="2"
        :placeholder="t('workspace.replyPlaceholder')"
        @keydown.enter="(e) => (e.metaKey || e.ctrlKey) && sendReply()"
      />
      <button class="cv-reply-send" type="submit" :disabled="replyBusy || !replyDraft.trim()">
        {{ t('workspace.replySend') }}
      </button>
    </form>
  </div>
</template>

<style scoped>
.cv-root {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}

.cv-head {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.cv-back {
  align-self: flex-start;
  font-size: 12px;
  font-weight: 600;
  font-family: inherit;
  padding: 5px 10px;
  border-radius: 8px;
  border: 1px solid var(--sema-line-card);
  background: var(--sema-card);
  color: var(--sema-ink-2);
  cursor: pointer;
}

.cv-back:hover {
  border-color: var(--sema-ink-3);
}

.cv-title-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.cv-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex: none;
}

.cv-dot--pulse {
  animation: cv-pulse 1.6s ease-in-out infinite;
}

@keyframes cv-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 var(--sema-amber-soft);
  }
  50% {
    box-shadow: 0 0 8px 2px var(--sema-amber-soft);
  }
}

.cv-title {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cv-status {
  flex: none;
  font-size: 11px;
  font-weight: 600;
  border-radius: 999px;
  padding: 2px 10px;
  white-space: nowrap;
}

.cv-sub {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.cv-branch {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--sema-ink-2);
  background: var(--sema-panel-2);
  border-radius: 6px;
  padding: 2px 8px;
}

.cv-chrono {
  display: flex;
  gap: 10px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--sema-ink-3);
  font-variant-numeric: tabular-nums;
}

.cv-wait {
  color: var(--sema-ink-ghost);
}

.cv-actions {
  margin-left: auto;
  display: flex;
  gap: 8px;
}

.cv-btn {
  font-size: 12px;
  font-weight: 600;
  font-family: inherit;
  padding: 6px 12px;
  border-radius: 8px;
  border: 1px solid var(--sema-line-card);
  background: var(--sema-card);
  cursor: pointer;
  transition: border-color 0.12s ease;
}

.cv-btn--danger {
  color: var(--sema-red-text);
}

.cv-btn--danger:hover {
  border-color: var(--sema-red);
}

.cv-btn--ship {
  color: var(--sema-green-text);
}

.cv-btn--ship:not(:disabled):hover {
  border-color: var(--sema-green);
}

.cv-btn:disabled {
  opacity: 0.45;
  cursor: default;
}

.cv-notice {
  margin: 0;
  font-size: 12.5px;
  color: var(--sema-amber-text);
}

.cv-error {
  margin: 0;
  font-size: 12.5px;
  color: var(--sema-red-text);
  font-family: var(--font-mono);
  overflow-wrap: anywhere;
}

.cv-thread {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 14px 16px;
  border: 1px solid var(--sema-line-card);
  border-radius: 13px;
  background: var(--sema-card);
}

.cv-user {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin: 8px 0 4px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--sema-panel-2);
}

.cv-user-tag {
  flex: none;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--sema-ink-3);
}

.cv-user-text {
  margin: 0;
  font-size: 13px;
  line-height: 1.55;
  color: var(--sema-ink);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  min-width: 0;
}

.cv-user-time {
  margin-left: auto;
  flex: none;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--sema-ink-ghost);
  font-variant-numeric: tabular-nums;
}

.cv-live {
  margin-top: 8px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--sema-amber-soft);
}

.cv-live-text {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--sema-ink);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.cv-caret {
  display: inline-block;
  width: 7px;
  height: 14px;
  margin-left: 3px;
  vertical-align: text-bottom;
  background: var(--sema-amber);
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
  color: var(--sema-amber-text);
}

.cv-reply {
  display: flex;
  align-items: flex-end;
  gap: 10px;
}

.cv-reply-input {
  flex: 1;
  border: 1px solid var(--sema-line-card);
  border-radius: 10px;
  background: var(--sema-card);
  color: var(--sema-ink);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.55;
  padding: 9px 12px;
  resize: vertical;
  min-height: 44px;
}

.cv-reply-input::placeholder {
  color: var(--sema-ink-ghost);
}

.cv-reply-send {
  font-size: 13px;
  font-weight: 600;
  font-family: inherit;
  padding: 9px 16px;
  border-radius: 9px;
  border: 1px solid var(--sema-accent);
  background: var(--sema-accent);
  color: var(--sema-on-accent);
  cursor: pointer;
}

.cv-reply-send:disabled {
  opacity: 0.45;
  cursor: default;
}
</style>
