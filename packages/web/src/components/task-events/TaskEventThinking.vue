<script setup lang="ts">
// Reasoning block in the thread (fiche 12 section 3): the same pilule
// gabarit as the tool-call line, folded to a scrolling one-line tail while
// it streams, unfolded to a width-capped monospace prose block on click.
//
// NOT YET WIRED: no TaskEventType carries reasoning today (fiche 12 section
// 8.2's own inventory says so) — types.ts and task-event-registry.ts are
// both outside this component's authoring scope (task-events/ only), so
// this is a ready-to-plug component, not a routed one yet. See the report
// back to the team lead.
import { Brain, ChevronRight } from '@lucide/vue'
import { computed, onUnmounted, ref, watch } from 'vue'
import { t } from '../../i18n'
import { previewTail, THINKING_IDLE_MS } from './TaskEventThinking'

const props = defineProps<{
  /** Accumulated reasoning text so far — the streamed prefix, not a delta. */
  text: string
  /**
   * True while the parent KNOWS more of this block may still arrive (the
   * turn it belongs to is still running). Independent of the 1200ms silence
   * timer below: a turn that ends immediately closes the block even if the
   * timer has not fired yet, so nothing is ever left reading "still
   * thinking" after the agent has already handed over.
   */
  streaming?: boolean
  /** Fold state, owned by the caller — same controlled shape as
   * ForgeAccordion.vue, not a ref this component keeps to itself: the
   * conversation is what knows whether ANOTHER block should close when one
   * opens, and it is the only way this branch is reachable from a test that
   * cannot simulate a click (this harness renders once, to a string). */
  open: boolean
}>()

const emit = defineEmits<{ 'update:open': [open: boolean] }>()

const preview = computed(() => previewTail(props.text))

// "Toujours en cours" per fiche 12 section 3: 1200ms with no new content
// ends it, even mid-turn — a block can go quiet while the agent moves on to
// a tool call without the turn itself being over.
const active = ref(props.streaming ?? false)
let idleTimer: ReturnType<typeof setTimeout> | null = null

function clearIdleTimer(): void {
  if (idleTimer !== null) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
}

function armIdleTimer(): void {
  clearIdleTimer()
  idleTimer = setTimeout(() => {
    active.value = false
  }, THINKING_IDLE_MS)
}

if (props.streaming) {
  armIdleTimer()
}

watch(
  () => props.streaming,
  (streaming) => {
    if (streaming) {
      active.value = true
      armIdleTimer()
    } else {
      active.value = false
      clearIdleTimer()
    }
  },
)

// New content while streaming resets the silence clock; growth while NOT
// streaming (a late replay, or a parent that forgot to flip the flag) never
// fakes activity back on.
watch(
  () => props.text,
  () => {
    if (props.streaming) {
      active.value = true
      armIdleTimer()
    }
  },
)

onUnmounted(clearIdleTimer)
</script>

<template>
  <div class="tvth-root">
    <button
      type="button"
      class="tvth-head"
      :aria-expanded="open"
      @click="emit('update:open', !open)"
    >
      <Brain class="tvth-icon" aria-hidden="true" />
      <span class="tvth-label">{{ t('workspace.evThinking') }}</span>
      <span v-if="active" class="tvth-dot" aria-hidden="true" />
      <ChevronRight
        class="tvth-chevron"
        :class="{ 'tvth-chevron--open': open }"
        aria-hidden="true"
      />
    </button>
    <!-- Folded: the tail of the thought, by its last 240 characters — the
         only bit interesting to see while it is still forming. -->
    <p
      v-if="!open && preview.text"
      class="tvth-preview"
      :class="{ 'tvth-preview--faded': preview.truncated }"
    >
      <span class="tvth-preview-text">{{ preview.text }}</span>
    </p>
    <!-- Unfolded: the whole thing, capped to a reading-width column and a
         bounded scroll box rather than pushing the rest of the thread down. -->
    <div v-else-if="open" class="tvth-body">
      <p class="tvth-prose">{{ text }}</p>
    </div>
  </div>
</template>

<style scoped>
.tvth-root {
  display: flex;
  flex-direction: column;
  max-width: 85%;
  margin: 4px 0;
}

.tvth-head {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 2px 8px;
  margin: -2px -8px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font-family: inherit;
  cursor: pointer;
}

.tvth-head:hover {
  background: var(--cs-hover);
}

.tvth-icon {
  flex: none;
  width: 12px;
  height: 12px;
  margin-top: 4px;
  color: var(--cs-muted);
}

.tvth-label {
  flex: none;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 20px;
  color: var(--cs-muted);
}

/* Live signal while the block is still filling in (fiche 12 section 3's
   "toujours en cours"), same small pulsing dot used elsewhere in the thread
   for an in-progress state (TaskConversation.vue's own tools/review dots). */
.tvth-dot {
  align-self: center;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--cs-amber);
  animation: tvth-pulse 1.6s ease-in-out infinite;
}

@keyframes tvth-pulse {
  50% {
    opacity: 0.35;
  }
}

.tvth-chevron {
  flex: none;
  margin-left: auto;
  width: 13px;
  height: 13px;
  color: var(--cs-ghost);
  transition: transform 200ms ease;
}

.tvth-chevron--open {
  transform: rotate(90deg);
}

/* Folded preview: one line, clipped to its RIGHT edge (direction: rtl on the
   line, unicode-bidi: plaintext on its text) so an overflowing tail shows
   its END rather than its start — "défilé vers la droite" (fiche 12 section
   3): the reader sees the thought by how it currently ends. */
.tvth-preview {
  margin: 2px 0 0 20px;
  overflow: hidden;
  white-space: nowrap;
  direction: rtl;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 20px;
  color: var(--cs-muted);
}

.tvth-preview-text {
  unicode-bidi: plaintext;
}

.tvth-preview--faded {
  mask-image: linear-gradient(to right, transparent, black 36px);
  -webkit-mask-image: linear-gradient(to right, transparent, black 36px);
}

.tvth-body {
  margin: 6px 0 0 20px;
  padding-left: 12px;
  border-left: 2px solid color-mix(in srgb, var(--cs-green) 70%, transparent);
  max-height: 360px;
  overflow-y: auto;
}

.tvth-prose {
  margin: 0;
  max-width: 65ch;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 20px;
  color: var(--cs-text-2);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
