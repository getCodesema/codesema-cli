<script setup lang="ts">
import { computed } from 'vue'
import type { PartialReview } from '../types'

type Severity = 'critical' | 'major' | 'minor' | 'info'

const SEVERITIES: ReadonlySet<Severity> = new Set(['critical', 'major', 'minor', 'info'])

// Same mapping as ReviewLive's single-lane findings feed: kept in sync there.
const SEVERITY_COLOR: Record<Severity, string> = {
  critical: 'var(--codesema-risk-high)',
  major: 'var(--codesema-accent)',
  minor: 'var(--codesema-risk-med)',
  info: 'var(--codesema-risk-low)',
}

const SEVERITY_LABEL_KEY: Record<Severity, string> = {
  critical: 'diffView.sevCritical',
  major: 'diffView.sevMajor',
  minor: 'diffView.sevMinor',
  info: 'diffView.sevInfo',
}

const props = defineProps<{
  kind: 'reviewer' | 'prosecutor'
  partial: PartialReview | null
  judging: boolean
}>()

const labelKey = computed(() =>
  props.kind === 'reviewer' ? 'live.laneReviewer' : 'live.laneProsecutor',
)
const findings = computed(() => props.partial?.findings ?? [])
const hasContent = computed(
  () => findings.value.length > 0 || (props.partial?.stepTitles.length ?? 0) > 0,
)
const currentStep = computed(() => props.partial?.stepTitles.at(-1))

const severityCounts = computed(() => {
  const counts: Record<Severity, number> = { critical: 0, major: 0, minor: 0, info: 0 }
  for (const f of findings.value) {
    if (f.severity && SEVERITIES.has(f.severity as Severity)) {
      counts[f.severity as Severity]++
    }
  }
  return counts
})
</script>

<template>
  <div class="dlane-root" :class="{ 'dlane-root--dim': judging }">
    <div class="dlane-head">
      <span class="dlane-label">{{ $t(labelKey) }}</span>
      <span class="dlane-total">{{ findings.length }}</span>
    </div>

    <div v-if="hasContent" class="dlane-body">
      <div class="dlane-sevrow">
        <span
          v-for="sev in SEVERITIES"
          :key="sev"
          class="dlane-chip"
          :class="{ 'dlane-chip--zero': severityCounts[sev] === 0 }"
          :title="$t(SEVERITY_LABEL_KEY[sev])"
        >
          <span class="dlane-chip-dot" :style="{ background: SEVERITY_COLOR[sev] }" />
          {{ severityCounts[sev] }}
        </span>
      </div>

      <p v-if="kind === 'reviewer' && currentStep" class="dlane-line">
        <span class="dlane-line-tag">{{ $t('live.laneStep') }}</span>
        {{ currentStep }}
      </p>
      <p v-else-if="kind === 'prosecutor'" class="dlane-line">
        {{ $t('live.laneFindingCount', { n: findings.length }, findings.length) }}
      </p>
    </div>

    <p v-else class="dlane-warming">
      <span class="dlane-warm-dot" aria-hidden="true" />
      {{ $t('live.laneWarmingUp') }}
    </p>
  </div>
</template>

<style scoped>
.dlane-root {
  border: 1px solid var(--codesema-line);
  background: var(--codesema-panel);
  border-radius: 12px;
  padding: 14px 16px;
  min-width: 0;
  transition:
    opacity 0.25s ease,
    padding 0.25s ease;
}

.dlane-root--dim {
  opacity: 0.55;
  padding: 10px 14px;
}

.dlane-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--codesema-ink-3);
  margin-bottom: 10px;
}

.dlane-total {
  font-family: var(--font-mono);
  color: var(--codesema-accent);
  text-transform: none;
  letter-spacing: normal;
}

.dlane-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.dlane-sevrow {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.dlane-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--codesema-ink-2);
  border: 1px solid var(--codesema-line);
  border-radius: 999px;
  padding: 2px 9px;
}

.dlane-chip--zero {
  color: var(--codesema-ink-3);
  opacity: 0.55;
}

.dlane-chip-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.dlane-line {
  margin: 0;
  font-size: 12.5px;
  color: var(--codesema-ink-2);
  line-height: 1.5;
}

.dlane-line-tag {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--codesema-ink-3);
  margin-right: 7px;
}

.dlane-warming {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 12.5px;
  color: var(--codesema-ink-3);
  font-style: italic;
}

.dlane-warm-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--codesema-dot-idle);
  animation: dlane-warm-pulse 1.6s ease-in-out infinite;
}

@keyframes dlane-warm-pulse {
  0%,
  100% {
    opacity: 0.4;
  }
  50% {
    opacity: 1;
  }
}
</style>
