<script setup lang="ts">
// Bulle utilisateur : une ligne pleine largeur, alignée à DROITE (chat),
// surface remplie via le kit `.msg.user .body`. Markdown via renderMarkdown
// (échappe tout avant de transformer), comme le message agent.
import { computed } from 'vue'
import { clockTime } from '../../composables/useTaskBoard'
import { renderMarkdown } from '../../markdown'
import { formatExactStamp } from '../../relative-time'

const props = defineProps<{ text: string; at?: string }>()

const html = computed(() => renderMarkdown(props.text))
const stamp = computed(() => (props.at ? clockTime(props.at) : ''))
const exact = computed(() => (props.at ? formatExactStamp(props.at) : undefined))
</script>

<template>
  <div class="tvu-root msg user" :title="exact">
    <div class="tvu-block body">
      <!-- eslint-disable-next-line vue/no-v-html — renderMarkdown escapes everything first -->
      <div class="tvu-bubble tvu-md md" v-html="html" />
    </div>
    <span v-if="stamp" class="tvu-time ts">{{ stamp }}</span>
  </div>
</template>

<style scoped>
.tvu-root {
  min-width: 0;
  /* Le kit `.msg.user` aligne déjà la ligne à droite ; on empile bulle + stamp. */
  width: 100%;
}

.tvu-block {
  /* La surface vient du kit ; ici seulement le flux markdown. */
  max-width: 72ch;
  width: fit-content;
}

.tvu-time {
  flex: none;
  font-variant-numeric: tabular-nums;
}

.tvu-root .tvu-bubble {
  margin: 0;
  max-width: 72ch;
  color: var(--fg);
  overflow-wrap: anywhere;
  min-width: 0;
  white-space: normal;
}
</style>
