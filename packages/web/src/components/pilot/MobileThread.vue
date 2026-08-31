<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import { extractQuickReplies } from '../../composables/useQuickReplies'
import { lastQuestion, reviewRefOf } from '../../composables/useTaskBoard'
import type { TaskState } from '../../composables/useTasks'
import { t } from '../../i18n'
import { TASK_EVENT_COMPONENTS, type TaskEventCtx } from '../../task-event-registry'
import type { TaskEvent } from '../../types'
import ChatComposer from '../composer/ChatComposer.vue'
import EvidenceBlock from './EvidenceBlock.vue'
import QuestionBlock from './QuestionBlock.vue'
import RecapBlock from './RecapBlock.vue'

const props = withDefaults(
  defineProps<{
    state: TaskState
    sending?: boolean
  }>(),
  { sending: false },
)

const emit = defineEmits<{ back: []; send: [text: string]; pick: [option: string] }>()

const record = computed(() => props.state.record)

const now = ref(Date.now())
const ticker = setInterval(() => {
  now.value = Date.now()
}, 30_000)
onUnmounted(() => clearInterval(ticker))

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

const lastQuestionSeq = computed(() => {
  const questions = props.state.events.filter((event) => event.type === 'question')
  return questions.at(-1)?.seq ?? null
})

function ctxFor(event: TaskEvent): TaskEventCtx {
  return {
    active:
      event.type === 'question' &&
      record.value.status === 'waiting_for_you' &&
      event.seq === lastQuestionSeq.value,
    reviewAvailable:
      event.type === 'review_done' &&
      (reviewRefOf(event.data) !== null || record.value.review_ref !== null),
    now: now.value,
    fullText: fullTextBySeq.value.get(event.seq) ?? null,
  }
}

const streamEvents = computed(() =>
  props.state.events.filter(
    (event) =>
      !(
        event.type === 'question' &&
        record.value.status === 'waiting_for_you' &&
        event.seq === lastQuestionSeq.value
      ),
  ),
)

const activeQuestion = computed(() =>
  record.value.status === 'waiting_for_you' ? lastQuestion(props.state.events) : null,
)
const activeQuestionOptions = computed(() =>
  activeQuestion.value ? extractQuickReplies(activeQuestion.value) : [],
)

const draft = ref('')
const composerRef = ref<InstanceType<typeof ChatComposer> | null>(null)

function handleSend(text: string) {
  emit('send', text)
  draft.value = ''
}

function focusComposer() {
  composerRef.value?.focus()
}
</script>

<template>
  <div class="mbt-root">
    <header class="mbt-head">
      <button class="mbt-back" type="button" @click="emit('back')">
        {{ t('pilot.mobile.back') }}
      </button>
      <span class="mbt-headtext">
        <span class="mbt-headtitle">{{ record.title }}</span>
        <span class="mbt-headmeta">{{ state.projectId }}</span>
      </span>
    </header>

    <div class="mbt-scroll">
      <div class="mbt-thread">
        <div v-for="event in streamEvents" :key="event.seq" class="mbt-event">
          <component
            :is="TASK_EVENT_COMPONENTS[event.type]"
            :event="event"
            :task="record"
            :ctx="ctxFor(event)"
          />
        </div>
        <div class="mbt-event">
          <EvidenceBlock :task-id="record.id" :evidence="state.evidence ?? null" />
        </div>
        <div class="mbt-event">
          <RecapBlock :recap="state.recap ?? null" />
        </div>
        <div v-if="activeQuestion" class="mbt-event">
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

    <div class="mbt-foot">
      <ChatComposer
        ref="composerRef"
        v-model="draft"
        :placeholder="t('workspace.replyPlaceholder')"
        :sending="sending"
        @send="handleSend"
      />
    </div>
  </div>
</template>

<style scoped>
.mbt-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--cs-bg);
}

.mbt-head {
  flex: none;
  min-height: 52px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--cs-line);
  background: var(--cs-panel);
}

.mbt-back {
  flex: none;
  border: 0;
  background: transparent;
  color: var(--cs-text-2);
  font-family: inherit;
  font-size: 13px;
  font-weight: 600;
  padding: 4px 6px;
  cursor: pointer;
}

.mbt-back:hover {
  color: var(--cs-text);
}

.mbt-headtext {
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.mbt-headtitle {
  font-size: 14px;
  font-weight: 600;
  color: var(--cs-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mbt-headmeta {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--cs-ghost);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mbt-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 14px;
}

.mbt-thread {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.mbt-event {
  max-width: 92%;
  margin: 0;
}

.mbt-foot {
  flex: none;
  padding: 10px 12px calc(10px + env(safe-area-inset-bottom));
  border-top: 1px solid var(--cs-line);
  background: var(--cs-panel);
}
</style>
