<script setup lang="ts">
// User prompt in the thread, on the kit's own message grammar: a 4ch gutter
// naming the speaker, then the text on the one filled surface the thread
// allows. It sits on the LEFT like everything else — the fill and the gutter
// carry the dissymmetry with the agent, no alignment trick does.
//
// Rendered through the SAME markdown path as the assistant's own message
// (see TaskEventMessage.vue): a list or a code block the user typed reads as
// what it is. renderMarkdown escapes ALL input before transforming anything,
// so this is exactly as safe on user-authored (adversarial) text as it is on
// the agent's own.
import { computed } from 'vue'
import { clockTime } from '../../composables/useTaskBoard'
import { t } from '../../i18n'
import { renderMarkdown } from '../../markdown'
import { formatExactStamp } from '../../relative-time'

const props = defineProps<{ text: string; at?: string }>()

const html = computed(() => renderMarkdown(props.text))
const stamp = computed(() => (props.at ? clockTime(props.at) : ''))
const exact = computed(() => (props.at ? formatExactStamp(props.at) : undefined))
</script>

<template>
  <div class="tvu-root msg user" :title="exact">
    <span class="tvu-who who you">{{ t('conversation.you') }}</span>
    <div class="tvu-block body">
      <!-- eslint-disable-next-line vue/no-v-html — renderMarkdown escapes everything first -->
      <div class="tvu-bubble tvu-md md" v-html="html" />
      <span v-if="stamp" class="tvu-time ts">{{ stamp }}</span>
    </div>
  </div>
</template>

<style scoped>
.tvu-root {
  min-width: 0;
}

.tvu-who {
  flex: none;
}

/* The kit's `.msg.user .body` draws the raised surface and its padding; only
   the markdown flow and the stamp beside it are scoped here. */
.tvu-block {
  display: flex;
  align-items: baseline;
  gap: 2ch;
}

.tvu-time {
  flex: none;
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}

.tvu-root .tvu-bubble {
  margin: 0;
  flex: 1 1 auto;
  max-width: 72ch;
  color: var(--fg);
  overflow-wrap: anywhere;
  min-width: 0;
  white-space: normal;
}
</style>
