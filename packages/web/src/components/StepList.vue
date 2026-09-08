<script setup lang="ts">
// Deltas are computed from parsedDiff (prop), never from the agent.
// risk/take/check are optional; findingCount may be 0.

import { computed } from 'vue'
import { sameFile, type ParsedDiff } from '../composables/useDiff'
import { G } from '../glyphs'
import { riskMeta } from '../risk'
import type { StepView } from '../types'

const props = defineProps<{
  steps: StepView[]
  parsedDiff: ParsedDiff
  readSet?: Set<number>
}>()

const emit = defineEmits<{
  select: [index: number]
}>()

function stepDelta(ch: StepView): { add: number; del: number } {
  let add = 0
  let del = 0
  for (const chFile of ch.files) {
    const diffFile = props.parsedDiff.files.find((df) => sameFile(df.path, chFile))
    if (!diffFile) {
      continue
    }
    add += diffFile.addCount
    del += diffFile.delCount
  }
  return { add, del }
}

const firstUnreadIndex = computed(() => {
  const readSet = props.readSet ?? new Set<number>()
  for (let i = 0; i < props.steps.length; i++) {
    if (!readSet.has(i)) {
      return i
    }
  }
  return -1
})

function isRead(index: number): boolean {
  return props.readSet?.has(index) ?? false
}

function onCardClick(index: number) {
  emit('select', index)
}
</script>

<template>
  <div class="steplist-root">
    <div class="steplist-header">
      <span class="steplist-title">{{ $t('reviews.stepsTitle') }}</span>
      <span class="steplist-by muted">{{ G.sep }} {{ $t('reviews.stepsBy') }}</span>
    </div>

    <div class="steplist-cards">
      <div
        v-for="(ch, i) in steps"
        :key="i"
        class="steplist-card stepcard"
        :class="{ 'steplist-card--read': isRead(i) }"
        role="button"
        tabindex="0"
        @click="onCardClick(i)"
        @keydown.enter="onCardClick(i)"
        @keydown.space.prevent="onCardClick(i)"
      >
        <span class="steplist-radio i" :class="{ 'steplist-radio--done': isRead(i) }">
          <span v-if="isRead(i)" class="steplist-radio-check" aria-hidden="true">{{ G.ok }}</span>
          <span v-else class="steplist-card-num">{{ i + 1 }}</span>
        </span>

        <div class="steplist-card-main">
          <div class="steplist-card-title">{{ ch.title }}</div>

          <div class="steplist-card-meta">
            <template v-if="ch.risk && riskMeta(ch.risk)">
              <span class="steplist-risk-badge risk" :data-r="riskMeta(ch.risk)!.r">
                {{ $t(riskMeta(ch.risk)!.label) }}
              </span>
            </template>

            <span class="steplist-delta">
              <template v-if="stepDelta(ch).add > 0">
                <span class="steplist-delta-add">+{{ stepDelta(ch).add }}</span>
              </template>
              <template v-if="stepDelta(ch).del > 0">
                <span class="steplist-delta-del">−{{ stepDelta(ch).del }}</span>
              </template>
            </span>

            <span class="steplist-files-count">
              <span aria-hidden="true">{{ G.file }}</span>
              {{ $t('reviews.stepsFiles', { n: ch.files.length }) }}
            </span>

            <span v-if="ch.finding_refs.length > 0" class="steplist-findings-count">
              <span aria-hidden="true">{{ G.note }}</span>
              {{ $t('reviews.stepsFindings', { n: ch.finding_refs.length }) }}
            </span>
          </div>
        </div>

        <button v-if="i === firstUnreadIndex" class="steplist-cta btn" @click.stop="onCardClick(i)">
          {{ $t('reviews.stepsStart') }}
        </button>
      </div>
    </div>

    <p v-if="steps.length === 0" class="steplist-empty empty">
      {{ $t('reviews.stepsEmpty') }}
    </p>
  </div>
</template>

<style scoped>
.steplist-root {
  display: flex;
  flex-direction: column;
  gap: calc(var(--row) / 2);
  padding: var(--row) 2ch;
}

.steplist-header {
  display: flex;
  align-items: baseline;
  gap: 1ch;
}

.steplist-title {
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--fg-dim);
}

.steplist-by {
  font-size: 12px;
}

.steplist-cards {
  display: flex;
  flex-direction: column;
  gap: calc(var(--row) / 2);
}

.steplist-card {
  align-items: start;
  cursor: pointer;
}

.steplist-card:hover {
  background: var(--bg-hover);
}

.steplist-card--read {
  color: var(--fg-dim);
}

.steplist-radio {
  text-align: center;
}

.steplist-radio--done {
  color: var(--ok);
}

.steplist-card-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.steplist-card-title {
  font-weight: 700;
}

.steplist-card-meta {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 2ch;
  color: var(--fg-dim);
  font-size: 12px;
}

.steplist-delta {
  display: inline-flex;
  align-items: baseline;
  gap: 1ch;
}

.steplist-delta-add {
  color: var(--ok);
}

.steplist-delta-del {
  color: var(--err);
}

.steplist-cta {
  align-self: start;
  white-space: nowrap;
}
</style>
