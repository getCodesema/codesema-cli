<script setup lang="ts">
// Dense, presentational card for one forge issue: state, number, author, age,
// title, labels. Mirrors MrCard.vue's header shape so the two accordions of
// the forge board read as one density system. Props in, nothing fetched,
// nothing owned: the caller decides what a click does.
import { computed } from 'vue'
import { t, type MessageKey } from '../../i18n'
import { formatRelativeAge } from '../../relative-time'
import type { ForgeIssue } from '../../types'
import { labelPillStyle } from './LabelColor'

const props = defineProps<{ issue: ForgeIssue }>()

const labels = computed(() => props.issue.labels)
const age = computed(() => formatRelativeAge(props.issue.updatedAt))
const stateLabelKey = computed<MessageKey>(() =>
  props.issue.state === 'open' ? 'mrs.card.stateOpen' : 'mrs.card.stateClosed',
)
</script>

<template>
  <div class="fic-root">
    <div class="fic-head">
      <span
        class="fic-state"
        :class="`fic-state--${issue.state}`"
        role="img"
        :aria-label="t(stateLabelKey)"
      >
        <svg v-if="issue.state === 'open'" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="5.5" />
          <circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" />
        </svg>
        <svg v-else viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="5.5" />
          <path d="M5.5 8.2l1.8 1.8 3.2-3.6" />
        </svg>
      </span>
      <span class="fic-number">{{ t('mrs.number', { n: issue.number }) }}</span>
      <span class="fic-author">{{ issue.author }}</span>
      <span class="fic-age">{{ age }}</span>
    </div>

    <p class="fic-title">{{ issue.title }}</p>

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
  width: 100%;
}

.fic-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
  font-size: 12px;
  color: var(--cs-ghost);
}

.fic-state {
  flex: none;
  width: 13px;
  height: 13px;
  display: inline-flex;
}

.fic-state svg {
  width: 100%;
  height: 100%;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.fic-state--open {
  color: var(--cs-amber-text);
}

.fic-state--closed {
  color: var(--cs-green-text);
}

.fic-number {
  flex: none;
  font-weight: 700;
  color: var(--cs-green-text);
}

.fic-author {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fic-author::before {
  content: '·';
  margin-right: 6px;
}

.fic-age {
  flex: none;
  margin-left: auto;
}

.fic-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.25;
  color: var(--cs-text);
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
}

.fic-labels {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
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
