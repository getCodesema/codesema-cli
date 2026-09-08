<script setup lang="ts">
// The reply composer, pinned under the thread: the parked-message strip, the
// field and its send. The mode is the state — `question` while an answer
// unblocks the agent, `queue` while the agent holds the turn, `dead` when the
// conversation is over and the composer is replaced by a sentence.
import { nextTick, ref, watch } from 'vue'
import type { ReplyMode } from '../../composables/useTaskBoard'
import { G } from '../../glyphs'
import { t } from '../../i18n'

const props = defineProps<{
  draft: string
  mode: ReplyMode
  placeholder: string
  busy: boolean
  /** A question is open: the answer is what the agent is waiting for. */
  questionActive: boolean
  /** Message parked while the agent holds the turn; null when there is none. */
  pending: string | null
}>()

const emit = defineEmits<{
  'update:draft': [value: string]
  send: []
  'cancel-pending': []
}>()

const replyInput = ref<HTMLTextAreaElement | null>(null)

const MIN_ROWS = 2
const MAX_ROWS = 8

/** The field follows the text, between two and eight lines: never a single
 * cramped line, never a wall that eats the thread. */
function fitRows(): void {
  const el = replyInput.value
  if (!el) {
    return
  }
  el.rows = MIN_ROWS
  while (el.rows < MAX_ROWS && el.scrollHeight > el.clientHeight) {
    el.rows += 1
  }
}

watch(
  () => props.draft,
  () => void nextTick(fitRows),
)

function focus(): void {
  void nextTick(() => replyInput.value?.focus())
}

defineExpose({ focus })

function onInput(domEvent: Event): void {
  emit('update:draft', (domEvent.target as HTMLTextAreaElement).value)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.metaKey || event.ctrlKey) {
    emit('send')
  }
}

const composerMode = (): ReplyMode | 'question' => (props.questionActive ? 'question' : props.mode)
</script>

<template>
  <div class="cv-composer">
    <div v-if="pending !== null" class="cv-pending strip" role="status">
      <span class="cv-pending-label">{{ t('workspace.replyPendingLabel') }}</span>
      <span class="cv-pending-text">{{ pending }}</span>
      <button
        class="cv-pending-cancel"
        type="button"
        :aria-label="t('workspace.replyPendingCancel')"
        :title="t('workspace.replyPendingCancel')"
        @click="emit('cancel-pending')"
      >
        {{ G.ko }}
      </button>
    </div>

    <form
      v-if="mode !== 'dead'"
      class="cv-reply composer"
      :data-mode="composerMode()"
      @submit.prevent="emit('send')"
    >
      <!-- The send sits INSIDE the field box, at its bottom right: one
           surface, the base.css one, and nothing drawn around it. -->
      <div class="cv-reply-field">
        <textarea
          ref="replyInput"
          class="cv-reply-input"
          :class="{ 'cv-reply-input--waiting': questionActive }"
          :rows="MIN_ROWS"
          :placeholder="placeholder"
          :value="draft"
          @input="onInput"
          @keydown.enter="onKeydown"
        />
        <button
          class="cv-reply-send btn primary"
          :class="{ 'cv-reply-send--waiting': questionActive }"
          type="submit"
          :disabled="busy || !draft.trim()"
        >
          <span aria-hidden="true">{{ G.reply }}</span>
          {{ mode === 'queue' ? t('workspace.replyQueueSend') : t('workspace.replySend') }}
        </button>
      </div>
      <p class="cv-reply-hint hint">{{ t('composer.hintSend') }}</p>
    </form>
    <p v-else class="cv-reply-dead composer" data-mode="dead">
      {{ t('workspace.replyDeadHint') }}
    </p>
  </div>
</template>

<style scoped>
.cv-composer {
  flex: none;
}

.cv-pending {
  align-items: baseline;
  gap: 1ch;
  border-left: 3px solid var(--warn);
}

.cv-pending-label {
  flex: none;
  color: var(--warn);
}

.cv-pending-text {
  flex: 1;
  color: var(--fg);
  white-space: pre-line;
  overflow-wrap: anywhere;
}

.cv-pending-cancel {
  flex: none;
}

.cv-reply.composer {
  grid-template-columns: 1fr;
}

.cv-reply-field {
  position: relative;
  min-width: 0;
}

/* The textarea keeps base.css's own surface: no second box around it. The
   bottom padding is the room the send button stands in. */
.cv-reply-field .cv-reply-input {
  width: 100%;
  min-width: 0;
  resize: none;
  padding-bottom: calc(var(--row) + 4px);
}

/* A live question turns the composer amber: answering unblocks the agent. */
.cv-reply-input--waiting {
  border-color: var(--warn);
}

.cv-reply-input::placeholder {
  color: var(--fg-dim);
}

.cv-reply-send {
  position: absolute;
  right: 1ch;
  bottom: calc(var(--row) / 2);
}

.cv-reply-send--waiting {
  background: var(--warn);
  border-color: var(--warn);
}

.cv-reply-hint {
  margin: 0;
}

.cv-reply-dead {
  margin: 0;
  display: block;
}
</style>
