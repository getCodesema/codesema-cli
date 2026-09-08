<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { extractQuickReplies } from '../../composables/useQuickReplies'
import {
  activityPhraseKey,
  formatDuration,
  formatTokens,
  groupThreadEvents,
  lastQuestion,
  resumeStateOf,
  reviewRefOf,
} from '../../composables/useTaskBoard'
import type { TaskState } from '../../composables/useTasks'
import { EXECUTION_STATUS } from '../../execution-status'
import { G } from '../../glyphs'
import { t } from '../../i18n'
import { formatRelativeAge } from '../../relative-time'
import { TASK_EVENT_COMPONENTS, type TaskEventCtx } from '../../task-event-registry'
import type { TaskEvent } from '../../types'
import ChatComposer from '../composer/ChatComposer.vue'
import TaskEventUser from '../task-events/TaskEventUser.vue'
import ChecksBlock from './ChecksBlock.vue'
import CriteriaBlock from './CriteriaBlock.vue'
import EvidenceBlock from './EvidenceBlock.vue'
import { anchorThreadBlocks, type ThreadBlockKind } from './PilotLogic'
import QuestionBlock from './QuestionBlock.vue'
import RecapBlock from './RecapBlock.vue'

const props = withDefaults(
  defineProps<{
    state: TaskState
    sending?: boolean
    showBack?: boolean
  }>(),
  { sending: false, showBack: false },
)

const emit = defineEmits<{
  back: []
  send: [text: string]
  pick: [option: string]
  ship: []
  stop: []
  resume: []
}>()

const record = computed(() => props.state.record)
const visual = computed(() => EXECUTION_STATUS[record.value.status])
const phraseKey = computed(() => activityPhraseKey(record.value) ?? visual.value.phraseKey)
const age = computed(() => formatRelativeAge(record.value.updated_at))

const canShip = computed(() => record.value.status === 'review_ok')
const canStop = computed(() =>
  ['queued', 'running', 'waiting_for_you'].includes(record.value.status),
)
const resumeState = computed(() => resumeStateOf(record.value))
const hasActions = computed(() => canShip.value || canStop.value || resumeState.value === 'ready')

const now = ref(Date.now())
const ticker = setInterval(() => {
  now.value = Date.now()
}, 30_000)
onUnmounted(() => clearInterval(ticker))

const lastQuestionSeq = computed(
  () => props.state.events.findLast((event) => event.type === 'question')?.seq ?? null,
)

function isActiveQuestion(event: TaskEvent): boolean {
  return (
    event.type === 'question' &&
    record.value.status === 'waiting_for_you' &&
    event.seq === lastQuestionSeq.value
  )
}

const fullTextBySeq = computed(() => {
  const map = new Map<number, string>()
  let turn = -1
  for (const event of props.state.events) {
    if (event.type === 'turn_started') {
      turn++
    } else if (event.type === 'message') {
      const response = record.value.turns[turn]?.response
      if (response) {
        map.set(event.seq, response)
      }
    } else if (event.type === 'question') {
      const question = record.value.turns[turn]?.question
      if (question) {
        map.set(event.seq, question)
      }
    }
  }
  return map
})

function ctxFor(event: TaskEvent): TaskEventCtx {
  return {
    active: isActiveQuestion(event),
    reviewAvailable:
      event.type === 'review_done' &&
      (reviewRefOf(event.data) !== null || record.value.review_ref !== null),
    now: now.value,
    fullText: fullTextBySeq.value.get(event.seq) ?? null,
  }
}

type ThreadItem =
  | { kind: 'single'; key: string; event: TaskEvent; prompt: string | null }
  | { kind: 'tools'; key: string; events: TaskEvent[]; turnIndex: number }
  | { kind: 'block'; key: string; block: ThreadBlockKind }

function blockItems(blocks: readonly ThreadBlockKind[]): ThreadItem[] {
  return blocks.map((block) => ({ kind: 'block' as const, key: `block-${block}`, block }))
}

function singleItems(event: TaskEvent, prompt: string | null): ThreadItem[] {
  return isActiveQuestion(event) ? [] : [{ kind: 'single', key: `ev-${event.seq}`, event, prompt }]
}

const thread = computed<ThreadItem[]>(() => {
  const anchors = anchorThreadBlocks(props.state.events)
  let turn = 0
  const items = groupThreadEvents(props.state.events).flatMap((group): ThreadItem[] => {
    if (group.kind === 'tools') {
      const seq = group.events[0]?.seq ?? 0
      return [
        { kind: 'tools', key: `tools-${seq}`, events: group.events, turnIndex: group.turnIndex },
      ]
    }
    const event = group.event
    const prompt =
      event.type === 'turn_started' ? (record.value.turns[turn++]?.prompt ?? null) : null
    return [...singleItems(event, prompt), ...blockItems(anchors.after.get(event.seq) ?? [])]
  })
  return [...items, ...blockItems(anchors.trailing)]
})

function isLiveTools(item: Extract<ThreadItem, { kind: 'tools' }>): boolean {
  return (
    record.value.status === 'running' &&
    item.turnIndex === record.value.turns.length - 1 &&
    record.value.turns.at(-1)?.ended_at === null
  )
}

function toolsSummary(item: Extract<ThreadItem, { kind: 'tools' }>): string {
  const count = item.events.filter((event) => event.type === 'tool_use').length
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
  if (props.state.liveTokens > 0) {
    parts.push(t('workspace.tokensCount', { n: formatTokens(props.state.liveTokens) }))
  }
  return parts.length === 0 ? '' : ` · ${parts.join(' · ')}`
}

const liveBubbles = computed(() =>
  record.value.status === 'running' ? props.state.liveMessages : [],
)
const reviewStreaming = computed(() => record.value.status === 'reviewing')

const activeQuestion = computed(() =>
  record.value.status === 'waiting_for_you' ? lastQuestion(props.state.events) : null,
)
const activeQuestionOptions = computed(() =>
  activeQuestion.value ? extractQuickReplies(activeQuestion.value) : [],
)

const scrollRef = ref<HTMLDivElement | null>(null)
const FOLLOW_MARGIN_PX = 80
let pinnedToTail = true

function jumpToTail(): void {
  void nextTick(() => {
    const el = scrollRef.value
    if (el) {
      el.scrollTop = el.scrollHeight
    }
  })
}

function onScroll(): void {
  const el = scrollRef.value
  if (!el) {
    return
  }
  pinnedToTail = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_MARGIN_PX
}

function followTail(): void {
  if (pinnedToTail) {
    jumpToTail()
  }
}

onMounted(jumpToTail)

watch(
  () => record.value.id,
  () => {
    pinnedToTail = true
    jumpToTail()
  },
)

watch(
  () => [
    props.state.events.length,
    props.state.liveText.length,
    props.state.liveMessages.length,
    props.state.liveMessages.at(-1)?.text.length ?? 0,
  ],
  followTail,
)

const draft = ref('')
const composerRef = ref<InstanceType<typeof ChatComposer> | null>(null)

function handleSend(text: string): void {
  emit('send', text)
  draft.value = ''
}

function focusComposer(): void {
  composerRef.value?.focus()
}
</script>

<template>
  <section class="pt-root" :class="`pt-root--${record.status}`" :data-tone="visual.tone">
    <header class="pt-head">
      <button v-if="showBack" class="pt-back btn ghost" type="button" @click="emit('back')">
        {{ t('pilot.mobile.back') }}
      </button>
      <span v-if="visual.attention" class="pt-warn" aria-hidden="true">{{ G.attention }}</span>
      <span v-else class="pt-dot status" :data-tone="visual.tone" aria-hidden="true" />
      <span class="pt-head-text">
        <span class="pt-sub"
          >{{ state.projectId }} · <span aria-hidden="true">{{ G.branch }}</span>
          {{ record.branch || record.base }}</span
        >
        <span class="pt-title">{{ record.title }}</span>
      </span>
      <span class="pt-state">{{ t(phraseKey) }} · {{ age }}</span>
      <div v-if="hasActions" class="pt-actions">
        <button
          v-if="resumeState === 'ready'"
          type="button"
          class="btn pt-action pt-action--resume"
          :disabled="sending"
          @click="emit('resume')"
        >
          {{ t('workspace.resume') }}
        </button>
        <button
          v-if="canStop"
          type="button"
          class="btn pt-action pt-action--stop"
          :disabled="sending"
          @click="emit('stop')"
        >
          {{ t('workspace.interrupt') }}
        </button>
        <button
          v-if="canShip"
          type="button"
          class="btn pt-action pt-action--ship"
          :disabled="sending"
          @click="emit('ship')"
        >
          {{ t('workspace.ship') }}
        </button>
      </div>
    </header>

    <div ref="scrollRef" class="pt-scroll" @scroll="onScroll">
      <div class="pt-thread thread">
        <template v-for="item in thread" :key="item.key">
          <template v-if="item.kind === 'single'">
            <TaskEventUser v-if="item.prompt !== null" :text="item.prompt" />
            <div class="pt-event">
              <component
                :is="TASK_EVENT_COMPONENTS[item.event.type]"
                :event="item.event"
                :task="record"
                :ctx="ctxFor(item.event)"
              />
            </div>
          </template>

          <details
            v-else-if="item.kind === 'tools'"
            class="pt-tools tools"
            :class="{ 'pt-tools--live': isLiveTools(item) }"
          >
            <summary class="pt-tools-summary">
              <template v-if="isLiveTools(item)">
                <span class="pt-tools-dot status" data-tone="info" aria-hidden="true" />
                <span class="pt-tools-label pt-tools-label--live"
                  >{{ t('workspace.agentWorking') }}{{ liveSummary() }}</span
                >
              </template>
              <span v-else class="pt-tools-label pt-tools-label--done">
                {{ t('workspace.toolsDetail') }} · {{ toolsSummary(item) }}
              </span>
            </summary>
            <div class="pt-tools-body">
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

          <div v-else class="pt-block" :class="`pt-block--${item.block}`">
            <CriteriaBlock v-if="item.block === 'criteria'" :criteria="state.recap?.criteria" />
            <ChecksBlock v-else-if="item.block === 'checks'" :checks="state.checks" />
            <EvidenceBlock
              v-else-if="item.block === 'evidence'"
              :project-id="state.projectId"
              :task-id="record.id"
              :evidence="state.evidence ?? null"
              :verification="state.verification ?? null"
              :activity="record.activity ?? null"
            />
            <RecapBlock v-else :recap="state.recap ?? null" />
          </div>
        </template>

        <div
          v-for="(bubble, index) in liveBubbles"
          :key="bubble.seq"
          class="pt-live"
          :class="{ 'pt-live--settled': index < liveBubbles.length - 1 }"
        >
          <p class="pt-live-text">
            {{ bubble.text
            }}<span v-if="index === liveBubbles.length - 1" class="pt-caret" aria-hidden="true">{{
              G.cursor
            }}</span>
          </p>
          <p v-if="index === liveBubbles.length - 1" class="pt-live-hint">
            {{ t('workspace.agentWriting') }}
          </p>
        </div>

        <div v-if="reviewStreaming" class="pt-live pt-live--review">
          <span class="pt-live-tag">{{ t('workspace.evReviewStarted') }}</span>
          <p v-if="state.liveText.trim().length > 0" class="pt-live-text">
            {{ state.liveText }}<span class="pt-caret" aria-hidden="true">{{ G.cursor }}</span>
          </p>
        </div>

        <div v-if="activeQuestion" class="pt-event pt-event--question">
          <QuestionBlock
            :question="activeQuestion"
            :options="activeQuestionOptions"
            :disabled="sending"
            @pick="emit('pick', $event)"
            @other="focusComposer"
          />
        </div>
      </div>
    </div>

    <footer class="pt-foot">
      <ChatComposer
        ref="composerRef"
        v-model="draft"
        :placeholder="t('workspace.replyPlaceholder')"
        :sending="sending"
        @send="handleSend"
      />
    </footer>
  </section>
</template>

<style scoped>
.pt-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  border: 1px solid var(--line);
  border-left: 3px solid var(--tone, var(--line));
  background: var(--bg);
  overflow: hidden;
}

.pt-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 1ch;
  padding: calc(var(--row) / 2) 1ch;
  border-bottom: 1px solid var(--line);
}

.pt-back {
  flex: none;
  color: var(--fg-dim);
}

.pt-back:hover {
  color: var(--fg);
}

.pt-dot {
  flex: none;
}

.pt-warn {
  flex: none;
  color: var(--warn);
  font-weight: 700;
}

.pt-head-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.pt-sub {
  font-size: 12px;
  color: var(--fg-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pt-title {
  font-weight: 700;
  color: var(--fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pt-state {
  flex: none;
  font-size: 12px;
  color: var(--tone, var(--fg-dim));
  white-space: nowrap;
}

.pt-actions {
  flex: none;
  display: flex;
  gap: 1ch;
}

.pt-action--resume {
  color: var(--warn);
  border-color: var(--warn);
}

.pt-action--stop {
  color: var(--err);
  border-color: var(--err);
}

.pt-action--ship {
  color: var(--bg);
  background: var(--ok);
  border-color: var(--ok);
  font-weight: 700;
}

.pt-action--ship:hover:not(:disabled) {
  background: var(--fg);
  border-color: var(--fg);
}

.pt-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  background: var(--bg);
}

.pt-thread {
  max-height: none;
  overflow: visible;
}

.pt-event {
  max-width: 85%;
  min-width: 0;
}

.pt-event--question {
  max-width: 100%;
}

.pt-block {
  align-self: stretch;
  padding: calc(var(--row) / 2) 1ch;
  border-top: 1px solid var(--line);
}

.pt-tools {
  max-width: 85%;
}

.pt-tools--live {
  border-color: var(--info);
}

.pt-tools-summary {
  display: flex;
  align-items: center;
  gap: 1ch;
  padding: 2px 1ch;
  cursor: pointer;
  list-style: none;
  font-size: 12px;
  color: var(--fg-dim);
}

.pt-tools-summary::-webkit-details-marker {
  display: none;
}

.pt-tools-dot {
  flex: none;
}

.pt-tools-label--live {
  color: var(--info);
}

.pt-tools-body {
  border-top: 1px solid var(--line);
  padding: 2px 1ch;
  display: flex;
  flex-direction: column;
}

.pt-live {
  max-width: 85%;
  padding: 2px 1ch;
  border-left: 2px solid var(--info);
}

.pt-live--settled,
.pt-live--review {
  border-left-color: var(--line);
}

.pt-live-tag {
  display: inline-block;
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--fg-dim);
}

.pt-live-text {
  margin: 0;
  color: var(--fg);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.pt-live-hint {
  margin: 0;
  font-size: 12px;
  color: var(--fg-dim);
}

.pt-caret {
  color: var(--accent);
  animation: blink 1s steps(2) infinite;
}

.pt-foot {
  flex: none;
  padding: calc(var(--row) / 2) 1ch calc(var(--row) / 2 + env(safe-area-inset-bottom));
  border-top: 1px solid var(--line);
}
</style>
