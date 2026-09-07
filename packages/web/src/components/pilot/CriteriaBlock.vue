<script setup lang="ts">
import { t } from '../../i18n'
import type { RecapRecord } from '../../types'

// `criteria` is RecapRecord's own criteria[] (RecapCriterionVerdict: a status
// plus the denormalized ticket text), not TaskRecord's (AcceptanceCriterion:
// text only, no status): the pastille this block renders needs a verdict to
// color itself with, which only the recap's shape carries.
defineProps<{
  criteria?: RecapRecord['criteria']
}>()
</script>

<template>
  <section class="crb-root">
    <h3 class="crb-title">{{ t('pilot.criteria.title') }}</h3>
    <p v-if="!criteria || criteria.length === 0" class="crb-empty">
      {{ t('pilot.criteria.none') }}
    </p>
    <ul v-else class="crb-list">
      <li v-for="verdict in criteria" :key="verdict.criterion_id" class="crb-row">
        <span
          class="crb-dot"
          :class="`crb-dot--${verdict.status}`"
          :title="verdict.status"
          aria-hidden="true"
        />
        <span class="crb-body">
          <span class="crb-text">{{ verdict.text ?? verdict.criterion_id }}</span>
          <span v-if="verdict.evidence" class="crb-evidence"
            >{{ t('pilot.criteria.evidence') }}: {{ verdict.evidence }}</span
          >
        </span>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.crb-root {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.crb-title {
  margin: 0;
  font-family: var(--font);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--fg-muted);
}

.crb-empty {
  margin: 0;
  font-size: var(--fs);
  color: var(--fg-dim);
}

.crb-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.crb-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: var(--fs);
  color: var(--fg);
}

.crb-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--fg-dim);
  margin-top: 4px;
}

.crb-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.crb-evidence {
  font-size: 12px;
  color: var(--fg-dim);
}

.crb-dot--met {
  background: var(--ok);
}

.crb-dot--unmet {
  background: var(--err);
}

.crb-dot--unclear {
  background: var(--warn);
}

.crb-text {
  overflow-wrap: anywhere;
}
</style>
