<script setup lang="ts">
import { computed } from 'vue'
import { G } from '../glyphs'
import type { JudgeDecision, JudgeLive } from '../types'

const props = defineProps<{
  judge: JudgeLive | null
}>()

type Stamp = 'merged' | 'rejected' | 'kept'

const STAMP_GLYPH: Record<Stamp, string> = {
  merged: G.retry,
  rejected: G.fail,
  kept: G.ok,
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

    <div class="djp-list">
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
    </div>
  </section>
</template>

<style scoped>
.djp-root {
  border: 1px solid var(--line);
  background: var(--bg-raised);
  padding: calc(var(--row) / 2) 1ch;
  display: flex;
  flex-direction: column;
  gap: calc(var(--row) / 2);
}

.djp-progress {
  color: var(--fg-dim);
}

.djp-bar {
  height: 2px;
  background: var(--line);
  overflow: hidden;
}

.djp-bar-fill {
  height: 100%;
  background: var(--accent);
}

.djp-list {
  display: flex;
  flex-direction: column;
}

.djp-row {
  display: flex;
  align-items: baseline;
  gap: 1ch;
}

.djp-stamp {
  flex-shrink: 0;
  width: 2ch;
  text-align: center;
  font-weight: 700;
}

.djp-row--kept .djp-stamp {
  color: var(--ok);
}

.djp-row--merged .djp-stamp {
  color: var(--accent);
}

.djp-row--rejected .djp-stamp {
  color: var(--err);
}

.djp-id {
  font-size: 12px;
  flex-shrink: 0;
}

.djp-source {
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--fg-dim);
  flex-shrink: 0;
}

.djp-detail {
  color: var(--fg-dim);
  min-width: 0;
  overflow-wrap: anywhere;
}

.djp-detail--muted {
  color: var(--fg-muted);
}
</style>
