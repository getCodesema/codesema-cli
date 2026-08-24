<script setup lang="ts">
// Dense, presentational card for one forge issue: number, title, author,
// updated date, labels. Mirrors MrCard.vue's shape and density so the two
// accordions of the Issue Radar read as one system. Props in, nothing
// fetched, nothing owned: the caller decides what a click does.
import { computed } from 'vue'
import { t } from '../../i18n'
import type { ForgeIssue } from '../../types'

const props = defineProps<{ issue: ForgeIssue }>()

const labels = computed(() => props.issue.labels)

function formatUpdatedAt(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(iso),
    )
  } catch {
    return iso
  }
}
</script>

<template>
  <div class="isc-root">
    <div class="isc-top">
      <span class="isc-number">{{ t('mrs.number', { n: issue.number }) }}</span>
    </div>

    <p class="isc-title">{{ issue.title }}</p>

    <p class="isc-meta">{{ issue.author }} · {{ formatUpdatedAt(issue.updatedAt) }}</p>

    <div v-if="labels.length > 0" class="isc-labels">
      <span v-for="label in labels" :key="label" class="isc-label">{{ label }}</span>
    </div>
  </div>
</template>

<style scoped>
.isc-root {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
}

.isc-top {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.isc-number {
  flex-shrink: 0;
  font-size: 11.5px;
  font-weight: 700;
  color: var(--cs-green-text);
}

.isc-title {
  margin: 0;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--cs-text);
  line-height: 1.35;
}

.isc-meta {
  margin: 0;
  font-size: 11px;
  color: var(--cs-ghost);
}

.isc-labels {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 2px;
}

/* Neutral border: a label on a card is content, not a state on its own. */
.isc-label {
  font-size: 10px;
  font-family: var(--font-mono);
  color: var(--cs-muted);
  padding: 1.5px 7px;
  border: 1px solid var(--cs-line-2);
  border-radius: 999px;
}
</style>
