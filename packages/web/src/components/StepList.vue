<script setup lang="ts">
// Deltas are computed from parsedDiff (prop), never from the agent.
// risk/take/check are optional; findingCount may be 0.

import { computed } from 'vue'
import { sameFile, type ParsedDiff } from '../composables/useDiff'
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
      <span class="steplist-by">· {{ $t('reviews.stepsBy') }}</span>
    </div>

    <div class="steplist-cards">
      <div
        v-for="(ch, i) in steps"
        :key="i"
        class="steplist-card"
        :class="{ 'steplist-card--read': isRead(i) }"
        role="button"
        tabindex="0"
        @click="onCardClick(i)"
        @keydown.enter="onCardClick(i)"
        @keydown.space.prevent="onCardClick(i)"
      >
        <div class="steplist-card-top">
          <span class="steplist-radio" :class="{ 'steplist-radio--done': isRead(i) }">
            <span v-if="isRead(i)" class="steplist-radio-check">✓</span>
          </span>

          <div class="steplist-card-main">
            <div class="steplist-card-title">
              <span class="steplist-card-num">{{ i + 1 }}</span>
              <span>{{ ch.title }}</span>
            </div>

            <div class="steplist-card-meta">
              <template v-if="ch.risk && riskMeta(ch.risk)">
                <span
                  class="steplist-risk-badge"
                  :class="[riskMeta(ch.risk)!.textCls, riskMeta(ch.risk)!.bgCls]"
                >
                  <span
                    class="steplist-risk-dot"
                    :style="{ background: riskMeta(ch.risk)!.dotColor }"
                  />
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
                ▤ {{ $t('reviews.stepsFiles', { n: ch.files.length }) }}
              </span>

              <span v-if="ch.finding_refs.length > 0" class="steplist-findings-count">
                💬 {{ $t('reviews.stepsFindings', { n: ch.finding_refs.length }) }}
              </span>
            </div>
          </div>

          <button v-if="i === firstUnreadIndex" class="steplist-cta" @click.stop="onCardClick(i)">
            {{ $t('reviews.stepsStart') }}
          </button>
        </div>
      </div>
    </div>

    <p v-if="steps.length === 0" class="steplist-empty codesema-muted">
      {{ $t('reviews.stepsEmpty') }}
    </p>
  </div>
</template>

<style scoped>
.steplist-root {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 24px 22px;
}

/* header */
.steplist-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
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
  font-weight: 500;
  text-transform: none;
  letter-spacing: 0;
  color: var(--fg-dim);
}

/* cards */
.steplist-cards {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.steplist-card {
  border: 1px solid var(--line);
  border-radius: 11px;
  background: var(--bg-raised);
  padding: 14px 15px;
  cursor: pointer;
  transition:
    border-color 0.12s ease,
    box-shadow 0.12s ease;
  outline: none;
}

.steplist-card:hover {
  border-color: var(--fg-dim);
  box-shadow: 0 1px 3px rgba(16, 24, 40, 0.05);
}

.steplist-card:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.steplist-card--read {
  opacity: 0.6;
}

.steplist-card--read:hover {
  opacity: 0.8;
}

/* main row */
.steplist-card-top {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

/* radio check */
.steplist-radio {
  flex: 0 0 18px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 1.5px solid var(--line);
  display: grid;
  place-items: center;
  margin-top: 1px;
  background: transparent;
  flex-shrink: 0;
}

.steplist-radio--done {
  border-color: var(--ok);
  background: var(--ok);
}

.steplist-radio-check {
  font-size: 12px;
  color: #fff;
  line-height: 1;
  font-weight: 700;
}

/* body */
.steplist-card-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0;
}

.steplist-card-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: var(--fs);
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--fg);
  line-height: 1.35;
}

.steplist-card-num {
  font-family: var(--font);
  font-size: 18px;
  font-weight: 400;
  color: var(--fg-dim);
  flex-shrink: 0;
}

/* meta */
.steplist-card-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 11px;
  margin-top: 9px;
}

/* risk badge */
.steplist-risk-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  padding: 3px 10px;
  border-radius: 999px;
}

.steplist-risk-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.step-risk--high {
  color: var(--err);
}
.step-risk-bg--high {
  background: color-mix(in srgb, var(--err) 12%, transparent);
}
.step-risk--med {
  color: var(--warn);
}
.step-risk-bg--med {
  background: color-mix(in srgb, var(--warn) 12%, transparent);
}
.step-risk--low {
  color: var(--ok);
}
.step-risk-bg--low {
  background: color-mix(in srgb, var(--ok) 12%, transparent);
}

/* delta */
.steplist-delta {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-family: var(--font);
  font-size: 12px;
}

.steplist-delta-add {
  color: var(--ok);
}

.steplist-delta-del {
  color: var(--err);
}

/* files / notes */
.steplist-files-count,
.steplist-findings-count {
  font-size: 12px;
  color: var(--fg-dim);
}

/* cta */
.steplist-cta {
  flex-shrink: 0;
  align-self: center;
  padding: 8px 13px;
  border-radius: 8px;
  border: 0;
  background: var(--accent);
  /* dark ink on orange: ~7.6:1 contrast, white capped at 2.6:1 (AA = 4.5:1) */
  color: var(--bg);
  font-size: var(--fs);
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  white-space: nowrap;
  transition: filter 0.12s ease;
}

.steplist-cta:hover {
  filter: brightness(1.05);
}

/* empty */
.steplist-empty {
  font-size: var(--fs);
  padding: 16px 0;
  text-align: center;
}
</style>
