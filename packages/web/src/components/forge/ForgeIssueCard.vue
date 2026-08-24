<script setup lang="ts">
// Dense, presentational card for one forge issue: number, title, author,
// updated date, labels. Mirrors MrCard.vue's shape and density so the two
// accordions of the forge board read as one system. Props in, nothing
// fetched, nothing owned: the caller decides what a click does.
import { computed } from 'vue'
import { t } from '../../i18n'
import type { ForgeIssue } from '../../types'
import { labelPillStyle } from './LabelColor'

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
  <div class="fic-root">
    <div class="fic-top">
      <span class="fic-number">{{ t('mrs.number', { n: issue.number }) }}</span>
    </div>

    <p class="fic-title">{{ issue.title }}</p>

    <p class="fic-meta">{{ issue.author }} · {{ formatUpdatedAt(issue.updatedAt) }}</p>

    <div v-if="labels.length > 0" class="fic-labels">
      <span
        v-for="label in labels"
        :key="label.name"
        class="fic-label"
        :style="labelPillStyle(label.color)"
        >{{ label.name }}</span
      >
    </div>
  </div>
</template>

<style scoped>
.fic-root {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
}

.fic-top {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.fic-number {
  flex-shrink: 0;
  font-size: 11.5px;
  font-weight: 700;
  color: var(--cs-green-text);
}

.fic-title {
  margin: 0;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--cs-text);
  line-height: 1.35;
}

.fic-meta {
  margin: 0;
  font-size: 11px;
  color: var(--cs-ghost);
}

.fic-labels {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 2px;
}

/* Non-interactive compact pill: same fill family as LabelChips' rest state
   (see LabelColor.ts), never a colored border: a label on a card is content,
   not a state. */
.fic-label {
  --lp-rest-bg: var(--cs-line-2);

  display: inline-flex;
  font-size: 12px;
  font-weight: 500;
  color: var(--cs-text-2);
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--lp-rest-bg);
}
</style>
