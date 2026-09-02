<script setup lang="ts">
import { computed, ref } from 'vue'
import { extractQuickReplies } from '../../composables/useQuickReplies'
import { activityPhraseKey, lastQuestion, resumeStateOf } from '../../composables/useTaskBoard'
import type { TaskState } from '../../composables/useTasks'
import { EXECUTION_STATUS } from '../../execution-status'
import { t } from '../../i18n'
import { formatRelativeAge } from '../../relative-time'
import ChatComposer from '../composer/ChatComposer.vue'
import ChecksBlock from './ChecksBlock.vue'
import CriteriaBlock from './CriteriaBlock.vue'
import EvidenceBlock from './EvidenceBlock.vue'
import type { LensBlock } from './PilotLogic'
import QuestionBlock from './QuestionBlock.vue'
import RecapBlock from './RecapBlock.vue'

const props = defineProps<{
  state: TaskState
  sending?: boolean
}>()

const emit = defineEmits<{
  'open-full': []
  'open-lens': [block: LensBlock]
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

// Same three offers as TaskConversation's header, minus Cleanup (destructive
// two-step, stays in the classic interface only). 'reviewing' is deliberately
// absent from canStop: the runner frees the task's slot before handing over
// to the review, so an interrupt there always 409s.
const canShip = computed(() => record.value.status === 'review_ok')
const canStop = computed(() =>
  ['queued', 'running', 'waiting_for_you'].includes(record.value.status),
)
const resumeState = computed(() => resumeStateOf(record.value))

const questionActive = computed(() => record.value.status === 'waiting_for_you')
const question = computed(() => (questionActive.value ? lastQuestion(props.state.events) : null))
const quickReplyOptions = computed(() =>
  question.value === null ? [] : extractQuickReplies(question.value),
)

const criteria = computed(() => props.state.recap?.criteria)

function openLens(block: LensBlock): void {
  emit('open-lens', block)
}

function onZoneKeydown(event: KeyboardEvent, block: LensBlock): void {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    openLens(block)
  }
}

const composerRef = ref<InstanceType<typeof ChatComposer> | null>(null)

/** "Autre…" is not a reply of its own: it hands typing back to the composer,
 * same as TaskConversation's own focusReply. */
function onOther(): void {
  composerRef.value?.focus()
}

const draft = ref('')

function onSend(text: string): void {
  emit('send', text)
  draft.value = ''
}
</script>

<template>
  <article class="ac-root" :class="`ac-root--${record.status}`">
    <button type="button" class="ac-head" @click="emit('open-full')">
      <span v-if="visual.attention" class="ac-warn" aria-hidden="true">⚠</span>
      <span
        v-else
        class="ac-dot"
        :class="{ 'ac-dot--pulse': visual.pulse }"
        :style="{ background: visual.color }"
        aria-hidden="true"
      />
      <span class="ac-head-text">
        <span class="ac-sub"
          >{{ state.projectId }} · <span aria-hidden="true">⎇</span>
          {{ record.branch || record.base }}</span
        >
        <span class="ac-title">{{ record.title }}</span>
      </span>
      <span class="ac-state" :style="{ color: visual.text }">{{ t(phraseKey) }} · {{ age }}</span>
    </button>

    <!-- Not literal <button>s: EvidenceBlock can render a real <video
         controls> and RecapBlock's markdown can render <a> links, both
         interactive content HTML5 forbids nesting inside a <button>. -->
    <div class="ac-body">
      <div
        class="ac-zone"
        role="button"
        tabindex="0"
        @click="openLens('evidence')"
        @keydown="onZoneKeydown($event, 'evidence')"
      >
        <EvidenceBlock
          :task-id="record.id"
          :evidence="state.evidence ?? null"
          :verification="state.verification ?? null"
          :activity="record.activity ?? null"
        />
      </div>
      <div
        class="ac-zone"
        role="button"
        tabindex="0"
        @click="openLens('recap')"
        @keydown="onZoneKeydown($event, 'recap')"
      >
        <RecapBlock :recap="state.recap ?? null" />
      </div>
    </div>

    <div class="ac-proofs">
      <div
        class="ac-zone"
        role="button"
        tabindex="0"
        @click="openLens('checks')"
        @keydown="onZoneKeydown($event, 'checks')"
      >
        <ChecksBlock :checks="state.checks" />
      </div>
      <div
        class="ac-zone"
        role="button"
        tabindex="0"
        @click="openLens('criteria')"
        @keydown="onZoneKeydown($event, 'criteria')"
      >
        <CriteriaBlock :criteria="criteria" />
      </div>
    </div>

    <footer class="ac-foot">
      <div v-if="canShip || canStop || resumeState === 'ready'" class="ac-actions">
        <button
          v-if="resumeState === 'ready'"
          type="button"
          class="ac-action ac-action--resume"
          :disabled="sending"
          @click="emit('resume')"
        >
          {{ t('workspace.resume') }}
        </button>
        <button
          v-if="canStop"
          type="button"
          class="ac-action ac-action--stop"
          :disabled="sending"
          @click="emit('stop')"
        >
          {{ t('workspace.interrupt') }}
        </button>
        <button
          v-if="canShip"
          type="button"
          class="ac-action ac-action--ship"
          :disabled="sending"
          @click="emit('ship')"
        >
          {{ t('workspace.ship') }}
        </button>
      </div>
      <QuestionBlock
        :question="question"
        :options="quickReplyOptions"
        :disabled="sending"
        @pick="emit('pick', $event)"
        @other="onOther"
      />
      <ChatComposer
        ref="composerRef"
        v-model="draft"
        :placeholder="t('workspace.replyPlaceholder')"
        :sending="sending"
        @send="onSend"
      />
    </footer>
  </article>
</template>

<style scoped>
.ac-root {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--cs-line);
  border-radius: 12px;
  background: var(--cs-panel);
  box-shadow: var(--cs-shadow-panel);
  overflow: hidden;
}

.ac-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border: none;
  border-bottom: 1px solid var(--cs-line);
  background: transparent;
  cursor: pointer;
  text-align: left;
  font-family: inherit;
}

.ac-dot {
  flex: none;
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.ac-dot--pulse {
  animation: ac-pulse 1.6s ease-in-out infinite;
}

@media (prefers-reduced-motion: reduce) {
  .ac-dot--pulse {
    animation: none;
  }
}

@keyframes ac-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}

.ac-warn {
  flex: none;
  color: var(--cs-amber-text);
}

.ac-head-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.ac-sub {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--cs-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ac-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--cs-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ac-state {
  flex: none;
  font-family: var(--font-mono);
  font-size: 11px;
  white-space: nowrap;
}

.ac-body {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  padding: 12px 14px 0;
  min-width: 0;
}

.ac-proofs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  padding: 12px 14px;
}

.ac-zone {
  min-width: 0;
  padding: 10px;
  border: 1px solid var(--cs-line);
  border-radius: 8px;
  background: var(--cs-surface-2);
  cursor: zoom-in;
  outline: 2px solid transparent;
  outline-offset: 2px;
  transition: outline-color var(--cs-duration-fast) var(--cs-ease-out);
}

.ac-zone:hover,
.ac-zone:focus-visible {
  outline-color: var(--cs-line-3);
}

.ac-foot {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 14px 12px;
  border-top: 1px solid var(--cs-line);
}

.ac-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.ac-action {
  font-size: 12px;
  font-weight: 600;
  font-family: inherit;
  padding: 6px 12px;
  border-radius: 6px;
  border: 1px solid var(--cs-line-2);
  background: transparent;
  cursor: pointer;
  transition: border-color var(--cs-duration-fast) var(--cs-ease-out);
}

.ac-action:disabled {
  opacity: 0.45;
  cursor: default;
}

.ac-action--stop {
  color: var(--cs-red-text);
  border-color: var(--cs-red-line);
}

.ac-action--stop:hover:not(:disabled) {
  border-color: var(--cs-red);
}

.ac-action--ship {
  color: var(--cs-on-green);
  background: var(--cs-green);
  border-color: var(--cs-green);
}

.ac-action--ship:hover:not(:disabled) {
  background: var(--cs-green-hover);
  border-color: var(--cs-green-hover);
}

.ac-action--resume {
  color: var(--cs-amber-text);
  border-color: var(--cs-amber-line);
  background: var(--cs-amber-soft);
}

.ac-action--resume:hover:not(:disabled) {
  border-color: var(--cs-amber);
}
</style>
