<script setup lang="ts">
// User prompt in the thread, componentised (fiche 12 section 2): a
// surface-background bubble, right-aligned, no avatar — the dissymmetry with
// the assistant's un-bubbled text IS the point the fiche makes there.
//
// Rendered through the SAME markdown path as the assistant's own message
// (see TaskEventMessage.vue): today this text renders as a raw <p>, so a
// list or a code block the user typed shows up as a wall of text while the
// assistant's own replies render properly formatted. renderMarkdown escapes
// ALL input before transforming anything, so this is exactly as safe on
// user-authored (adversarial) text as it is on the agent's own.
import { computed } from 'vue'
import { renderMarkdown } from '../../markdown'

const props = defineProps<{ text: string }>()

const html = computed(() => renderMarkdown(props.text))
</script>

<template>
  <div class="tvu-root">
    <!-- eslint-disable-next-line vue/no-v-html — renderMarkdown escapes everything first -->
    <div class="tvu-bubble tvu-md" v-html="html" />
  </div>
</template>

<style scoped>
.tvu-root {
  align-self: flex-end;
  width: fit-content;
  max-width: 550px;
  min-width: 0;
  margin: 4px 0;
}

.tvu-bubble {
  margin: 0;
  padding: 8px 16px;
  border: 1px solid var(--cs-line-2);
  border-radius: 16px;
  background: var(--cs-surface);
  font-size: 14px;
  line-height: 24px;
  color: var(--cs-text);
  overflow-wrap: anywhere;
  min-width: 0;
}

/* Rendered markdown: same quiet document rhythm as the assistant's own
   bubble (TaskEventMessage.vue) — one visual language for both sides of the
   thread, not a second one invented for the user's side. */
.tvu-md :deep(p),
.tvu-md :deep(ul),
.tvu-md :deep(ol),
.tvu-md :deep(pre) {
  margin: 0 0 8px;
}

.tvu-md :deep(:last-child) {
  margin-bottom: 0;
}

.tvu-md :deep(h2),
.tvu-md :deep(h3) {
  margin: 12px 0 6px;
  font-size: 13.5px;
  font-weight: 700;
  color: var(--cs-text);
}

.tvu-md :deep(h2:first-child),
.tvu-md :deep(h3:first-child) {
  margin-top: 0;
}

.tvu-md :deep(h3) {
  font-size: 12.5px;
}

.tvu-md :deep(ul),
.tvu-md :deep(ol) {
  padding-left: 20px;
}

.tvu-md :deep(li) {
  margin: 2px 0;
}

.tvu-md :deep(code) {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--cs-green-text);
  white-space: pre-wrap;
}

.tvu-md :deep(pre) {
  padding: 9px 11px;
  border: 1px solid var(--cs-line-2);
  border-radius: 8px;
  background: var(--cs-inset);
  overflow-x: auto;
}

.tvu-md :deep(pre code) {
  color: var(--cs-text);
}

.tvu-md :deep(a) {
  color: var(--cs-green-hover);
}
</style>
