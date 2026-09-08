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

const canSend = (): boolean => props.draft.trim() !== ''
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
      <!-- One frame: the prompt glyph, the field, and the send that appears
           only once there is something to send. -->
      <div class="cv-reply-field">
        <span class="cv-reply-prompt" aria-hidden="true">{{ G.arrow }}</span>
        <textarea
          ref="replyInput"
          class="cv-reply-input"
          :rows="MIN_ROWS"
          :placeholder="placeholder"
          :value="draft"
          @input="onInput"
          @keydown.enter="onKeydown"
        />
        <button v-if="canSend()" class="cv-reply-send btn primary" type="submit" :disabled="busy">
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

/* A parked message is not a state the reader must act on: plain meta text. */
.cv-pending {
  align-items: baseline;
  gap: 1ch;
}

.cv-pending-label {
  flex: none;
  color: var(--fg-dim);
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
  display: block;
  padding: 0;
  border-top: none;
}

/* The frame: one hairline box around the prompt, the field and the send. */
.cv-reply-field {
  display: flex;
  align-items: flex-start;
  gap: 1ch;
  min-width: 0;
  border: 1px solid var(--line);
  background: var(--bg);
  padding: calc(var(--row) / 2) 1ch;
}

.cv-reply-field:focus-within {
  border-color: var(--accent);
}

/* Amber only here: an open question is the one thing blocking the agent. */
.cv-reply[data-mode='question'] .cv-reply-field {
  border-color: var(--warn);
}

.cv-reply-prompt {
  flex: none;
  color: var(--fg-muted);
}

.cv-reply-field .cv-reply-input {
  flex: 1;
  width: 100%;
  min-width: 0;
  resize: none;
  border: none;
  outline: none;
  background: transparent;
  padding: 0;
}

.cv-reply-input::placeholder {
  color: var(--fg-muted);
}

.cv-reply-send {
  flex: none;
  align-self: flex-end;
}

.cv-reply-hint {
  margin: 0;
  padding: 2px 1ch 0;
}

.cv-reply-dead {
  margin: 0;
  display: block;
}
</style>
