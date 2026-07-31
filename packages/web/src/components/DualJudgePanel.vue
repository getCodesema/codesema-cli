<script setup lang="ts">
import { computed } from 'vue'
import type { JudgeDecision, JudgeLive } from '../types'

const props = defineProps<{
  judge: JudgeLive | null
}>()

type Stamp = 'merged' | 'rejected' | 'kept'

const STAMP_GLYPH: Record<Stamp, string> = {
  merged: '⟲',
  rejected: '✗',
  kept: '✓',
}

const STAMP_LABEL_KEY: Record<Stamp, string> = {
  merged: 'live.judgeMergedInto',
  rejected: 'live.judgeRejected',
  kept: 'live.judgeKept',
}

function stampFor(d: JudgeDecision): Stamp {
  if (d.duplicate_of) {
    return 'merged'
  }
  return d.action === 'reject' ? 'rejected' : 'kept'
}

function sourceLabelKey(id: string): string {
  return id.startsWith('A') ? 'live.laneReviewer' : 'live.laneProsecutor'
}

const total = computed(() => props.judge?.total ?? 0)
const done = computed(() => props.judge?.decisions.length ?? 0)
const pct = computed(() => (total.value > 0 ? Math.round((done.value / total.value) * 100) : 0))

// Newest decision first: the judge appends to the cumulative list as it resolves each one.
const reversedDecisions = computed(() => [...(props.judge?.decisions ?? [])].toReversed())
</script>

<template>
  <section class="djp-root">
    <div class="djp-progress">
      {{ $t('live.judgeProgress', { done, total }) }}
    </div>
    <div class="djp-bar">
      <div class="djp-bar-fill" :style="{ width: `${pct}%` }" />
    </div>

    <TransitionGroup name="djp-fade" tag="div" class="djp-list">
      <div
        v-for="d in reversedDecisions"
        :key="d.id"
        class="djp-row"
        :class="`djp-row--${stampFor(d)}`"
      >
        <span class="djp-stamp" aria-hidden="true">{{ STAMP_GLYPH[stampFor(d)] }}</span>
        <span class="djp-id">{{ d.id }}</span>
        <span class="djp-source">{{ $t(sourceLabelKey(d.id)) }}</span>
        <span v-if="stampFor(d) === 'merged'" class="djp-detail">
          {{ $t(STAMP_LABEL_KEY.merged, { id: d.duplicate_of }) }}
        </span>
        <span v-else-if="d.reason" class="djp-detail djp-detail--muted">{{ d.reason }}</span>
        <span v-else class="djp-detail djp-detail--muted">{{
          $t(STAMP_LABEL_KEY[stampFor(d)])
        }}</span>
      </div>
    </TransitionGroup>
  </section>
</template>

<style scoped>
.djp-root {
  border: 1px solid var(--codesema-line);
  background: var(--codesema-panel);
  border-radius: 12px;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.djp-progress {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--codesema-ink-2);
  font-variant-numeric: tabular-nums;
}

.djp-bar {
  height: 4px;
  border-radius: 999px;
  background: var(--codesema-line-2);
  overflow: hidden;
}

.djp-bar-fill {
  height: 100%;
  background: var(--codesema-accent);
  border-radius: 999px;
  transition: width 0.4s ease;
}

.djp-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.djp-row {
  display: flex;
  align-items: baseline;
  gap: 9px;
  font-size: 12.5px;
  padding: 4px 2px;
}

.djp-stamp {
  flex-shrink: 0;
  width: 16px;
  text-align: center;
  font-weight: 700;
}

.djp-row--kept .djp-stamp {
  color: var(--codesema-risk-low);
}

.djp-row--merged .djp-stamp {
  color: var(--codesema-accent);
}

.djp-row--rejected .djp-stamp {
  color: var(--codesema-risk-high);
}

.djp-id {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--codesema-ink);
  flex-shrink: 0;
}

.djp-source {
  font-size: 10.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--codesema-ink-3);
  flex-shrink: 0;
}

.djp-detail {
  color: var(--codesema-ink-2);
  min-width: 0;
  overflow-wrap: anywhere;
}

.djp-detail--muted {
  color: var(--codesema-ink-3);
  font-style: italic;
}

.djp-fade-enter-active {
  transition:
    opacity 0.3s ease,
    transform 0.3s ease;
}

.djp-fade-enter-from {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
