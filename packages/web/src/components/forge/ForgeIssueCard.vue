<script setup lang="ts">
// Dense, presentational card for one forge issue: state, number, author, age,
// title, labels. Mirrors MrCard.vue's header shape so the two accordions of
// the forge board read as one density system. Props in, nothing fetched,
// nothing owned: the caller decides what a click does.
import { CircleCheck, CircleDot } from '@lucide/vue'
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
        <CircleDot v-if="issue.state === 'open'" aria-hidden="true" />
        <CircleCheck v-else aria-hidden="true" />
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
        class="fic-label badge"
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
  gap: 1ch;
  font-size: 12px;
  color: var(--fg-muted);
}

.fic-state {
  flex: none;
  width: 14px;
  height: 14px;
  display: inline-flex;
}

.fic-state svg {
  width: 100%;
  height: 100%;
}

.fic-state--open {
  color: var(--warn);
}

.fic-state--closed {
  color: var(--ok);
}

.fic-number {
  flex: none;
  font-weight: 700;
  color: var(--ok);
}

.fic-author {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fic-author::before {
  content: '·';
  margin-right: 1ch;
}

.fic-age {
  flex: none;
  margin-left: auto;
}

.fic-title {
  margin: 0;
  font-weight: 700;
  color: var(--fg);
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
}

.fic-labels {
  display: flex;
  flex-wrap: wrap;
  gap: 1ch;
}

/* Non-interactive compact pill: same fill family as LabelChips' rest state
   (see LabelColor.ts), never a colored border: a label on a card is content,
   not a state. */
.fic-label {
  --lp-rest-bg: var(--line);

  font-size: 12px;
  background: var(--lp-rest-bg);
}
</style>
