<script setup lang="ts">
// Cumulable label filter row: one pill per label carried by the currently
// loaded items (forgeLabelCounts), each with its own tally. Purely
// presentational: the parent owns the selection and the toggle logic. The
// pill's fill comes from the label's own color (forge data), computed by
// LabelColor.ts; only the neutral fallback (no color, or one that slipped
// past upstream validation) comes from our own --cs-* tokens.
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
  gap: 6px;
}

/* Neutral tokens by default; a colored --lp-* triple is injected inline per
   pill from the label's own forge color (see LabelColor.ts), never a literal
   hex here. */
.lc-chip {
  --lp-rest-bg: var(--cs-line-2);
  --lp-selected-bg: var(--cs-green);
  --lp-selected-text: var(--cs-on-green);

  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-family: inherit;
  font-size: 13px;
  font-weight: 500;
  color: var(--cs-text-2);
  padding: 4px 12px;
  border: none;
  border-radius: 999px;
  background: var(--lp-rest-bg);
  cursor: pointer;
}

/* Selected is the state: full-strength fill, contrast-computed text. */
.lc-chip--on {
  background: var(--lp-selected-bg);
  color: var(--lp-selected-text);
  font-weight: 700;
}

.lc-count {
  font-family: var(--font-mono);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  opacity: 0.6;
}

.lc-chip--on .lc-count {
  opacity: 0.9;
}
</style>
