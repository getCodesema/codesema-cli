<script setup lang="ts">
// Cumulable label filter row: one pill per label carried by the currently
// loaded items (forgeLabelCounts), each with its own tally. Purely
// presentational: the parent owns the selection and the toggle logic. The
// pill's fill comes from the label's own color (forge data), computed by
// LabelColor.ts; only the neutral fallback (no color, or one that slipped
// past upstream validation) comes from our own theme tokens.
import { t } from '../../i18n'
import type { LabelCount } from './ForgeLogic'
import { labelPillStyle } from './LabelColor'

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
      :style="labelPillStyle(entry.color)"
      :aria-pressed="isSelected(entry.label)"
      @click="emit('toggle', entry.label)"
    >
      <span class="lc-count">{{ entry.count }}</span>
      <span class="lc-name">{{ entry.label }}</span>
    </button>
  </div>
</template>

<style scoped>
.lc-root {
  display: flex;
  flex-wrap: wrap;
  gap: 1ch;
}

/* Neutral tokens by default; a colored --lp-* triple is injected inline per
   pill from the label's own forge color (see LabelColor.ts), never a literal
   hex here. */
.lc-chip {
  --lp-rest-bg: var(--line);
  --lp-selected-bg: var(--ok);
  --lp-selected-text: var(--bg);

  display: inline-flex;
  align-items: center;
  gap: 1ch;
  font: inherit;
  color: var(--fg-dim);
  padding: 0 1ch;
  border: 1px solid var(--line);
  background: var(--lp-rest-bg);
  cursor: pointer;
}

/* Selected is the state: full-strength fill, contrast-computed text. */
.lc-chip--on {
  background: var(--lp-selected-bg);
  border-color: var(--lp-selected-bg);
  color: var(--lp-selected-text);
  font-weight: 700;
}

.lc-count {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--fg-muted);
}

.lc-chip--on .lc-count {
  color: inherit;
}
</style>
