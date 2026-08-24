<script setup lang="ts">
// Cumulable label filter row: one chip per label carried by the currently
// loaded items (forgeLabelCounts), each with its own tally. Purely
// presentational: the parent owns the selection and the toggle logic.
import { t } from '../../i18n'
import type { LabelCount } from './ForgeLogic'

const props = defineProps<{
  counts: LabelCount[]
  selected: readonly string[]
}>()

const emit = defineEmits<{ toggle: [label: string] }>()

const isSelected = (label: string): boolean => props.selected.includes(label)
</script>

<template>
  <div v-if="counts.length > 0" class="lc-root" role="group" :aria-label="t('forge.labelsAria')">
    <button
      v-for="entry in counts"
      :key="entry.label"
      type="button"
      class="lc-chip"
      :class="{ 'lc-chip--on': isSelected(entry.label) }"
      :aria-pressed="isSelected(entry.label)"
      @click="emit('toggle', entry.label)"
    >
      {{ entry.label }}
      <span class="lc-count">{{ entry.count }}</span>
    </button>
  </div>
</template>

<style scoped>
.lc-root {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

/* Neutral border by default: a label chip is not a state until selected. */
.lc-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-family: inherit;
  font-size: 11px;
  color: var(--cs-text-2);
  padding: 3px 9px;
  border: 1px solid var(--cs-line-2);
  border-radius: 999px;
  background: var(--cs-surface);
  cursor: pointer;
}

.lc-chip:hover {
  border-color: var(--cs-line-3);
}

/* Active selection is the state: colored border, per the doctrine. */
.lc-chip--on {
  border-color: var(--cs-green-ring);
  background: var(--cs-green-soft);
  color: var(--cs-text);
}

.lc-count {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--cs-ghost);
  font-variant-numeric: tabular-nums;
}

.lc-chip--on .lc-count {
  color: var(--cs-green-text);
}
</style>
