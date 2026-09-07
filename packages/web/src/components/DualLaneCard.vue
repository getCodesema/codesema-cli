<script setup lang="ts">
import { computed } from 'vue'
import type { PartialReview } from '../types'

type Severity = 'critical' | 'major' | 'minor' | 'info'

const SEVERITIES: ReadonlySet<Severity> = new Set(['critical', 'major', 'minor', 'info'])

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
          class="dlane-chip sev"
          :class="{ 'dlane-chip--zero': severityCounts[sev] === 0 }"
          :data-v="sev"
          :title="$t(SEVERITY_LABEL_KEY[sev])"
        >
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

    <p v-else class="dlane-warming status" data-s="running">
      {{ $t('live.laneWarmingUp') }}
    </p>
  </div>
</template>

<style scoped>
.dlane-root {
  border: 1px solid var(--line);
  background: var(--bg-raised);
  padding: calc(var(--row) / 2) 1ch;
  min-width: 0;
}

.dlane-root--dim {
  color: var(--fg-dim);
}

.dlane-head {
  display: flex;
  align-items: baseline;
  gap: 1ch;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--fg-dim);
}

.dlane-total {
  color: var(--accent);
  text-transform: none;
  letter-spacing: normal;
}

.dlane-body {
  display: flex;
  flex-direction: column;
}

.dlane-sevrow {
  display: flex;
  flex-wrap: wrap;
  gap: 1ch;
}

.dlane-chip {
  display: inline-flex;
  align-items: baseline;
  gap: 1ch;
  font-size: 12px;
  border: 1px solid var(--line);
  padding: 0 1ch;
}

.dlane-chip--zero {
  color: var(--fg-muted);
}

.dlane-line {
  color: var(--fg-dim);
}

.dlane-line-tag {
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--fg-dim);
  margin-right: 1ch;
}

.dlane-warming {
  color: var(--fg-dim);
}
</style>
