<script setup lang="ts">
import { G } from '../../glyphs'

// Shared accordion chrome for one forge board list (issues or pull requests):
// a foldable header with its count and, when the forge capped the list, an
// explicit caveat line, never silence on a truncated result. The controls
// row (sort / status filter / labels) and the item list are slots: this
// component owns no fetch, no filter, no sort, only the fold state display.
defineProps<{
  label: string
  /**
   * Null when the count is not actually known yet (loading, transport error,
   * forge unavailable): never a fabricated 0 that would read as "empty". A
   * plain number is the whole corpus, unfiltered. A string is a caller-formatted
   * "shown / total" (or equivalent), used once a filter or a label selection
   * narrows what is actually on screen: a lone total would then describe a
   * list nobody sees any more, not the one the reader is looking at.
   */
  count: number | string | null
  /** Set only when the forge's own `truncated` flag is true; null otherwise. */
  truncatedHint: string | null
  open: boolean
}>()

const emit = defineEmits<{ 'update:open': [open: boolean] }>()
</script>

<template>
  <section class="fa-root">
    <button class="fa-head" :aria-expanded="open" @click="emit('update:open', !open)">
      <span class="fa-chevron" :class="{ 'fa-chevron--closed': !open }" aria-hidden="true">{{
        open ? G.expand : G.collapse
      }}</span>
      <span class="fa-label">{{ label }}</span>
      <span v-if="count !== null" class="fa-count">{{ count }}</span>
    </button>
    <p v-if="truncatedHint" class="fa-truncated">{{ truncatedHint }}</p>
    <template v-if="open">
      <div v-if="$slots.filters || $slots.labels" class="fa-controls">
        <div v-if="$slots.filters" class="fa-controls-row">
          <slot name="filters" />
        </div>
        <div v-if="$slots.labels" class="fa-controls-row">
          <slot name="labels" />
        </div>
      </div>
      <div class="fa-body">
        <slot />
      </div>
    </template>
  </section>
</template>

<style scoped>
.fa-root {
  display: flex;
  flex-direction: column;
  gap: calc(var(--row) / 2);
}

.fa-head {
  display: flex;
  align-items: baseline;
  gap: 1ch;
  text-align: left;
  font: inherit;
  color: var(--fg);
  padding: 0 1ch;
  margin: 0 -1ch;
  border: none;
  background: transparent;
  cursor: pointer;
}

.fa-head:hover {
  background: var(--bg-hover);
}

.fa-chevron {
  flex: none;
  color: var(--fg-muted);
}

.fa-label {
  font-weight: 700;
  color: var(--fg);
}

.fa-count {
  font-size: 12px;
  color: var(--fg-dim);
  font-variant-numeric: tabular-nums;
}

.fa-truncated {
  margin: 0;
  padding-left: 2ch;
  font-size: 12px;
  color: var(--fg-dim);
}

.fa-controls {
  display: flex;
  flex-direction: column;
  gap: calc(var(--row) / 2);
}

.fa-controls-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 1ch;
}

.fa-body {
  display: flex;
  flex-direction: column;
  gap: calc(var(--row) / 2);
}
</style>
