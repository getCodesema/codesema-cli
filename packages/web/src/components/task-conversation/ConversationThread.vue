<script setup lang="ts">
// The thread itself: each turn's prompt, the journal rendered through the
// event registry, folded tool runs, the live bubbles of the turn in flight,
// the review's own progress block, and the quick replies of an open question.
import { computed, nextTick, ref, watch } from 'vue'
import { formatTokens } from '../../composables/useTaskBoard'
import { useConversationThread } from '../../composables/useTaskConversation'
import type { ApiResult, TaskState } from '../../composables/useTasks'
import { cleanupOffer, type ThreadItem } from '../../conversation-thread'
import { G } from '../../glyphs'
import { t } from '../../i18n'
import { TASK_EVENT_COMPONENTS } from '../../task-event-registry'
import QuickReplies from '../composer/QuickReplies.vue'
import TaskEventUser from '../task-events/TaskEventUser.vue'

const props = defineProps<{
  state: TaskState
  /** Slow clock (epoch ms) of the conversation, for the "il y a X" stamps. */
  slowNow: number
  /** Elapsed time of the turn (or its review) in flight; null when idle. */
  runningElapsed: string | null
  quickReplies: string[]
  replyBusy: boolean
  /** DELETE …/worktree: the one destructive offer, kept at the thread's tail. */
  abandon: () => Promise<ApiResult>
}>()

const emit = defineEmits<{
  'open-review': [archiveRef: string | null]
  fix: []
  pick: [option: string]
  other: []
  error: [message: string | null]
}>()

const state = computed(() => props.state)
const record = computed(() => props.state.record)
const { items, ctxFor, isLiveTools, toolsSummary, setupSummary } = useConversationThread(
  state,
  computed(() => props.slowNow),
)

// ── Danger zone: the destructive offer, at the very end of the thread ─────
// Two clicks, and only two: arming is dropped by Escape, by leaving the
// button, and by any status change under it.
const cleanup = computed(() => cleanupOffer(record.value))
const cleanupArmed = ref(false)
const cleanupBusy = ref(false)

watch(
  () => record.value.status,
  () => {
    cleanupArmed.value = false
  },
)

function disarmCleanup(): void {
  cleanupArmed.value = false
}

async function doCleanup(): Promise<void> {
  if (!cleanupArmed.value) {
    cleanupArmed.value = true
    return
  }
  cleanupArmed.value = false
  cleanupBusy.value = true
  emit('error', null)
  const result = await props.abandon()
  cleanupBusy.value = false
  if (!result.ok) {
    emit('error', result.error)
  }
}

// The live area covers BOTH streams of the task_text channel. The agent's
// turn is a CONVERSATION: each message it streams is its own bubble and they
// accumulate. The review is a status line: one sober block, replaced as it
// progresses — and it shows for the whole 'reviewing' phase, text or no text.
const liveBubbles = computed(() =>
  record.value.status === 'running' ? props.state.liveMessages : [],
)
const reviewStreaming = computed(() => record.value.status === 'reviewing')

function liveSummary(): string {
  const parts: string[] = []
  if (props.runningElapsed) {
    parts.push(props.runningElapsed)
  }
  if (props.state.liveTokens > 0) {
    parts.push(t('workspace.tokensCount', { n: formatTokens(props.state.liveTokens) }))
  }
  return parts.length > 0 ? ` — ${parts.join(' · ')}` : ''
}

const itemKey = (item: ThreadItem): string =>
  item.kind === 'single' ? `event-${item.event.seq}` : `${item.kind}-${item.key}`

// ── Scroll: follow the tail politely ─────────────────────────────────────
// New events and stream text keep the view glued to the bottom ONLY when the
// reader is already there — scrolling up to read is never hijacked.
const cvScroll = ref<HTMLDivElement | null>(null)
const FOLLOW_MARGIN_PX = 80

function followTail(): void {
  const el = cvScroll.value
  if (!el) {
    return
  }
  if (el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_MARGIN_PX) {
    el.scrollTop = el.scrollHeight
  }
}

watch(
  () => [
    props.state.events.length,
    props.state.liveText.length,
    // A new bubble AND more text in the current one both grow the thread.
    props.state.liveMessages.length,
    props.state.liveMessages.at(-1)?.text.length ?? 0,
  ],
  () => void nextTick(followTail),
)
</script>

<template>
  <div ref="cvScroll" class="cv-scroll thread">
    <template v-for="item in items" :key="itemKey(item)">
      <template v-if="item.kind === 'single'">
        <TaskEventUser v-if="item.prompt !== null" :text="item.prompt" :at="item.event.at" />
        <component
          :is="TASK_EVENT_COMPONENTS[item.event.type]"
          :event="item.event"
          :task="record"
          :ctx="ctxFor(item.event, item.showTime)"
          @open-review="(archiveRef: string | null) => emit('open-review', archiveRef)"
          @fix="emit('fix')"
        />
      </template>
      <!-- Everything the runner did before the conversation started: one
           line, opened only by a reader who asks for it. -->
      <details v-else-if="item.kind === 'setup'" class="cv-prep tools">
        <summary class="cv-tools-summary">
          <span class="cv-tools-label cv-tools-label--done">{{ setupSummary(item) }}</span>
        </summary>
        <div class="cv-tools-body">
          <component
            :is="TASK_EVENT_COMPONENTS[ev.type]"
            v-for="ev in item.events"
            :key="ev.seq"
            :event="ev"
            :task="record"
            :ctx="ctxFor(ev, false)"
          />
        </div>
      </details>
      <details v-else class="cv-tools tools" :class="{ 'cv-tools--live': isLiveTools(item) }">
        <summary class="cv-tools-summary">
          <template v-if="isLiveTools(item)">
            <span class="cv-tools-dot status" data-tone="info" aria-hidden="true" />
            <span class="cv-tools-label">{{ t('workspace.agentWorking') }}{{ liveSummary() }}</span>
          </template>
          <span v-else class="cv-tools-label cv-tools-label--done">
            {{ t('workspace.toolsDetail') }} — {{ toolsSummary(item) }}
          </span>
        </summary>
        <div class="cv-tools-body">
          <component
            :is="TASK_EVENT_COMPONENTS[ev.type]"
            v-for="ev in item.events"
            :key="ev.seq"
            :event="ev"
            :task="record"
            :ctx="ctxFor(ev, false)"
          />
        </div>
      </details>
    </template>

    <!-- Live stream of the agent's turn: one bubble per message it streamed,
         in order. Only the last one is in flight — the kit's `.msg.live`
         draws its blinking caret; the settled ones step back. -->
    <div
      v-for="(bubble, index) in liveBubbles"
      :key="bubble.seq"
      class="cv-live msg"
      :class="{ live: index === liveBubbles.length - 1 }"
    >
      <p class="cv-live-text body">{{ bubble.text }}</p>
      <p v-if="index === liveBubbles.length - 1" class="cv-live-hint">
        {{ t('workspace.agentWriting') }}
      </p>
    </div>

    <!-- While 'reviewing' it is the review reading the diff, not the agent
         writing: a sober frame naming what runs, and one progress line
         replaced as the review advances. -->
    <div v-if="reviewStreaming" class="cv-live cv-live--review review-live">
      <span class="cv-live-tag"
        ><b>{{ t('workspace.evReviewStarted') }}</b></span
      >
      <p v-if="state.liveText.trim().length > 0" class="cv-live-text">
        {{ state.liveText }}<span class="cv-caret" aria-hidden="true">{{ G.cursor }}</span>
      </p>
      <!-- Only the elapsed time is the REVIEW's own: the live token meter
           belongs to the agent turn that just ended. -->
      <p class="cv-live-hint">
        <span class="cv-live-dot status" data-tone="info" aria-hidden="true" />{{
          t('workspace.reviewRunning')
        }}<template v-if="runningElapsed"> — {{ runningElapsed }}</template>
      </p>
    </div>

    <!-- Quick replies: the question enumerated its options — one click. -->
    <QuickReplies
      :options="quickReplies"
      :disabled="replyBusy"
      @pick="(option: string) => emit('pick', option)"
      @other="emit('other')"
    />

    <!-- The end of the thread is where an irreversible action belongs: far
         from the header's primary offer, and armed before it fires. -->
    <section v-if="cleanup.available" class="cv-danger live err">
      <span class="cv-danger-label">{{ t('conversation.dangerZone') }}</span>
      <button
        class="cv-danger-btn btn danger"
        :class="{ armed: cleanupArmed }"
        type="button"
        :disabled="cleanupBusy"
        :title="t(cleanup.hintKey)"
        @click="doCleanup"
        @blur="disarmCleanup"
        @keydown.esc="disarmCleanup"
      >
        {{ cleanupArmed ? t('workspace.cleanupConfirm') : t(cleanup.labelKey) }}
      </button>
    </section>
  </div>
</template>

<style scoped>
.cv-scroll {
  flex: 1;
  min-height: 0;
  max-height: none;
}

.cv-live {
  grid-template-columns: 1fr;
}

.cv-live-text {
  margin: 0;
  min-width: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.cv-caret {
  color: var(--accent);
  animation: blink 1s steps(2) infinite;
}

.cv-live--review {
  flex-direction: column;
  align-items: flex-start;
}

.cv-live-tag {
  color: var(--fg-dim);
}

.cv-live-hint {
  margin: 0;
  color: var(--fg-dim);
}

/* The review runs even when it says nothing: the dot is the proof of life. */
.cv-live-dot {
  margin-right: 1ch;
}

.cv-danger {
  margin-top: var(--row);
  align-items: center;
}

.cv-danger-label {
  flex: 1;
  font-size: 12px;
  text-transform: uppercase;
  color: var(--err);
}

.cv-tools--live {
  border-color: var(--info);
}

.cv-tools--live .cv-tools-label {
  color: var(--info);
}

.cv-tools-summary {
  display: flex;
  align-items: baseline;
  gap: 1ch;
}

.cv-tools-summary::-webkit-details-marker {
  display: none;
}

.cv-tools-body {
  border-top: 1px solid var(--line);
  padding: calc(var(--row) / 2) 0;
  display: flex;
  flex-direction: column;
}
</style>
