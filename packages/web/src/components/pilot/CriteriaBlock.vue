<script setup lang="ts">
import { G } from '../../glyphs'
import { t } from '../../i18n'
import type { CriterionStatus, RecapRecord, TaskCheckStatus } from '../../types'

const CRITERION_GLYPH: Record<CriterionStatus, string> = {
  met: G.ok,
  unmet: G.fail,
  unclear: G.attention,
}

/** The kit's check-row tones are keyed on a check status: met reads as passed,
 * unmet as failed, unclear as the amber timeout row. */
const CRITERION_CHECK_STATUS: Record<CriterionStatus, TaskCheckStatus> = {
  met: 'passed',
  unmet: 'failed',
  unclear: 'timeout',
}

// `criteria` is RecapRecord's own criteria[] (RecapCriterionVerdict: a status
// plus the denormalized ticket text), not TaskRecord's (AcceptanceCriterion:
// text only, no status): the row this block renders needs a verdict to take
// its tone from, which only the recap's shape carries.
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
    <ul v-else class="crb-list checks">
      <li
        v-for="verdict in criteria"
        :key="verdict.criterion_id"
        class="crb-row check-row"
        :data-s="CRITERION_CHECK_STATUS[verdict.status]"
      >
        <span
          class="crb-dot g"
          :class="`crb-dot--${verdict.status}`"
          :title="verdict.status"
          aria-hidden="true"
          >{{ CRITERION_GLYPH[verdict.status] }}</span
        >
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
  gap: calc(var(--row) / 2);
}

.crb-title {
  margin: 0;
  font-size: 12px;
  color: var(--fg-dim);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.crb-empty {
  margin: 0;
  color: var(--fg-dim);
}

.crb-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.crb-row {
  grid-template-columns: 2ch 1fr;
  color: var(--fg);
}

.crb-body {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.crb-evidence {
  font-size: 12px;
  color: var(--fg-dim);
}

.crb-dot--met {
  color: var(--ok);
}

.crb-dot--unmet {
  color: var(--err);
}

.crb-dot--unclear {
  color: var(--warn);
}

.crb-text {
  overflow-wrap: anywhere;
}
</style>
