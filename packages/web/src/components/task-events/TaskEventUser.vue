<script setup lang="ts">
// User prompt in the thread, on the kit's own message grammar: a 4ch gutter
// naming the speaker, then the text behind an accent rail. It sits on the
// LEFT like everything else — the rail and the gutter carry the dissymmetry
// with the agent, no alignment trick does.
//
// Rendered through the SAME markdown path as the assistant's own message
// (see TaskEventMessage.vue): a list or a code block the user typed reads as
// what it is. renderMarkdown escapes ALL input before transforming anything,
// so this is exactly as safe on user-authored (adversarial) text as it is on
// the agent's own.
import { computed } from 'vue'
import { t } from '../../i18n'
import { renderMarkdown } from '../../markdown'
import { formatExactStamp } from '../../relative-time'

const props = defineProps<{ text: string; at?: string }>()

const html = computed(() => renderMarkdown(props.text))
const exact = computed(() => (props.at ? formatExactStamp(props.at) : undefined))
</script>

<template>
  <div class="tvu-root msg user" :title="exact">
    <span class="tvu-who who you">{{ t('conversation.you') }}</span>
    <!-- eslint-disable-next-line vue/no-v-html — renderMarkdown escapes everything first -->
    <div class="tvu-bubble tvu-md body" v-html="html" />
  </div>
</template>

<style scoped>
.tvu-root {
  min-width: 0;
}

.tvu-who {
  flex: none;
}

/* The kit's `.msg.user .body` draws the accent rail and its 1ch of padding;
   only the markdown flow is scoped here. */
.tvu-root .tvu-bubble {
  margin: 0;
  max-width: 72ch;
  color: var(--fg);
  overflow-wrap: anywhere;
  min-width: 0;
  white-space: normal;
}

/* Rendered markdown: same quiet document rhythm as the assistant's own
   bubble (TaskEventMessage.vue) — one visual language for both sides of the
   thread, not a second one invented for the user's side. */
.tvu-md :deep(p),
.tvu-md :deep(ul),
.tvu-md :deep(ol),
.tvu-md :deep(pre) {
  margin: 0 0 calc(var(--row) / 2);
}

.tvu-md :deep(:last-child) {
  margin-bottom: 0;
}

.tvu-md :deep(h2),
.tvu-md :deep(h3) {
  margin: var(--row) 0 calc(var(--row) / 2);
  font-size: var(--fs);
  font-weight: 700;
  color: var(--fg);
}

.tvu-md :deep(h2:first-child),
.tvu-md :deep(h3:first-child) {
  margin-top: 0;
}

.tvu-md :deep(ul),
.tvu-md :deep(ol) {
  padding-left: 3ch;
}

.tvu-md :deep(li) {
  margin: 2px 0;
}

.tvu-md :deep(code) {
  white-space: pre-wrap;
}

.tvu-md :deep(pre) {
  padding: calc(var(--row) / 2) 1ch;
  border-left: 2px solid var(--line);
  background: var(--bg-raised);
  overflow-x: auto;
}

.tvu-md :deep(a) {
  color: var(--accent);
}
</style>
